import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir as osHome, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { exec } from "../exec.ts";
import { runGit, worktreeRoot } from "../git-write.ts";
import { ACP_PROVIDERS } from "../harnesses/acp-catalog.ts";
import { validAcpModeId } from "../harnesses/acp-controls.ts";
import { launchable } from "../harnesses/catalog.ts";
import { driverFor } from "../harnesses/index.ts";
import type {
	CommandCatalog,
	LaunchHarness,
	LaunchOptions,
	LaunchParams,
	LaunchProject,
	LaunchRefs,
	LaunchSettings,
	LaunchState,
} from "../http/wire.ts";
import { processSnapshot } from "../processes.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import { capture, newSession, panePid, type TmuxOptions } from "../tmux.ts";
import type { Agent, ReceiptState } from "../types.ts";
import type { Acting, VerifiedUser } from "./acting.ts";
import { type Principal, principalLabel } from "./caller.ts";
import type { EventBus } from "./events.ts";
import { LIMITS } from "./limits.ts";
import type { Registry } from "./registry.ts";

/**
 * Starting agents from the app (`agents.launch`, an acting op).
 *
 * The home node starts the harness in a new detached tmux session through
 * the operator's login shell (`$SHELL -lic "exec <harness>"`), so it gets
 * the PATH and environment of a terminal, not the daemon's (launchd and
 * systemd give the daemon a bare one). The app can request provider settings
 * through the managed bridge. The launcher passes no permission bypass flags.
 *
 * The op returns as soon as the request checks out (federation gives a
 * relayed act a few seconds); the launch then goes on here and reports each
 * step as a `launch` event: worktree, starting, waiting, sending, done or
 * failed. The first message goes out only once the agent registered with
 * Pulsar and is ready: typed earlier, a TUI drops it. A dialog in the new
 * terminal (Claude's and Codex's folder trust) is shown as "Waiting in the
 * terminal" and the message waits until the operator answers it on that
 * machine. Nothing is sent on a timeout.
 *
 * A launch on another machine runs on its home node; this node follows it
 * there (`launch.status` reads) and repeats its steps as local events, with
 * pool addresses.
 */

/** What the app can start, and the fixed command that starts it. */
export const LAUNCH_HARNESSES = Object.fromEntries(
	launchable.map((h) => [h.id, h]),
) as Record<LaunchHarness, (typeof launchable)[number]>;
const HARNESS_IDS = launchable.map((h) => h.id);
const ACP_BINARIES = new Map<LaunchHarness, string>(
	ACP_PROVIDERS.map(({ id, binary }) => [id, binary]),
);

/** Native OMP also exposes steering and directly addressable child sessions. */
function preferredAcpBinary(id: LaunchHarness) {
	return id === "omp" ? undefined : ACP_BINARIES.get(id);
}

/** The program run by the login shell in a new tmux pane. */
export function harnessCommand(
	h: LaunchHarness,
	resumeArgs?: string[],
): string {
	// A provider session ID is opaque. Quote each argument for the login shell.
	if (resumeArgs)
		return `exec ${resumeArgs.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")}`;
	const entry = LAUNCH_HARNESSES[h];
	const acp = `exec pulsar acp ${entry.id}`;
	if ("managed" in entry) return acp;
	const native = `exec ${entry.bin}`;
	const binary = preferredAcpBinary(h);
	// Use this pane's PATH so launch remains correct after a cached options
	// probe or when the login shell chooses a different PATH in this folder.
	// Keep the selection script portable across login shells.
	return binary
		? `exec /bin/sh -c 'case "$(command -v pulsar 2>/dev/null):$(command -v ${binary} 2>/dev/null)" in /*:/*) ${acp} ;; *) ${native} ;; esac'`
		: native;
}

/**
 * Dialogs a harness shows in its terminal before it takes a prompt. While
 * one shows, the launch waits for the operator to answer it there.
 */
const DIALOGS: { re: RegExp; what: string }[] = [
	{
		re: /trust (the files in |the contents of )?this (folder|directory)/i,
		what: "folder trust",
	},
	{ re: /Do you trust/i, what: "folder trust" },
	{ re: /a project you created or one you trust/i, what: "folder trust" },
	{ re: /Yes, I trust this folder/i, what: "folder trust" },
];

/** The dialog a pane shows, if any. */
export function terminalDialog(text: string): string | null {
	// Only what is on screen now: the last lines, not old scrollback.
	const tail = text.trimEnd().split("\n").slice(-25).join("\n");
	return DIALOGS.find((d) => d.re.test(tail))?.what ?? null;
}

/** The operator's home folder (`~`): HOME, as their shell sees it. */
const homedir = () => process.env.HOME || osHome();

/**
 * Lists the harnesses a login shell finds, one marked line each
 * (`PULSAR_BIN:<executable>:<path>`), so what rc files print (a banner, a
 * terminal's escape codes on the same line) can't hide one. Constant: no
 * input goes in.
 */
const PROBE_BINARIES = new Set([
	"pulsar",
	...HARNESS_IDS.map((h) => LAUNCH_HARNESSES[h].bin),
	...ACP_BINARIES.values(),
]);
const PROBE_SCRIPT = `exec /bin/sh -c 'for c in ${[...PROBE_BINARIES].join(" ")}; do p=$(command -v "$c" 2>/dev/null) && printf "\\nPULSAR_BIN:%s:%s\\n" "$c" "$p"; done; exit 0'`;

/** Terminal escapes: OSC (`ESC ] ... BEL` or `ESC \\`) and CSI sequences. */
const ESCAPES =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: escape codes are control characters
	/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;

/** The executables a probe's output lists with an absolute path. */
export function parseProbe(stdout: string): Set<string> {
	const ids = new Set<string>();
	const text = stdout.replace(ESCAPES, "");
	for (const m of text.matchAll(/PULSAR_BIN:([a-z][a-z0-9-]*):(\/[^\r\n]*)/g)) {
		const bin = m[1]!;
		if (PROBE_BINARIES.has(bin) && isAbsolute(m[2]!.trim())) ids.add(bin);
	}
	return ids;
}

/** Folder names safe in a path: a branch `feat/x` becomes `feat-x`. */
function slug(s: string): string {
	return (
		s
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^[-.]+|[-.]+$/g, "")
			.slice(0, 80) || "worktree"
	);
}

const NONCE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_PATH = 4096;
const MAX_REF = 250;

function str(o: Record<string, unknown>, key: string, max: number) {
	const v = o[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string" || v.length > max)
		throw new RpcError("bad_request", `launch: bad ${key}`);
	return v;
}

/**
 * Checks launch params as they arrive (a relayed act reaches the home node
 * unchecked). Unknown keys are refused: the challenge covers all of them.
 */
export function parseLaunchParams(raw: unknown): LaunchParams {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new RpcError("bad_request", "launch: params must be an object");
	const o = raw as Record<string, unknown>;
	const allowed = new Set([
		"nonce",
		"cwd",
		"harness",
		"workspace",
		"resumeSessionId",
		"branch",
		"base",
		"prompt",
		"name",
		"model",
		"effort",
	]);
	for (const k of Object.keys(o))
		if (!allowed.has(k))
			throw new RpcError("bad_request", `launch: unknown ${k}`);
	const nonce = str(o, "nonce", 64);
	if (!nonce || !NONCE.test(nonce))
		throw new RpcError("bad_request", "launch: bad nonce");
	const cwd = str(o, "cwd", MAX_PATH)?.trim();
	if (!cwd || !(isAbsolute(cwd) || cwd === "~" || cwd.startsWith("~/")))
		throw new RpcError(
			"bad_request",
			"launch: the folder must be an absolute path",
		);
	const harness = o.harness;
	if (
		typeof harness !== "string" ||
		!HARNESS_IDS.includes(harness as LaunchHarness)
	)
		throw new RpcError("bad_request", "launch: unknown harness");
	const workspace = o.workspace;
	if (workspace !== "current" && workspace !== "worktree")
		throw new RpcError("bad_request", "launch: bad workspace");
	const branch = str(o, "branch", MAX_REF)?.trim() || undefined;
	const base = str(o, "base", MAX_REF)?.trim() || undefined;
	if (workspace === "current" && (branch || base))
		throw new RpcError("bad_request", "launch: a branch needs a new worktree");
	for (const ref of [branch, base])
		if (ref !== undefined && (ref.startsWith("-") || /[\s\0]/.test(ref)))
			throw new RpcError("bad_request", `launch: bad branch name ${ref}`);
	const prompt = str(o, "prompt", LIMITS.maxBody);
	const name = str(o, "name", 80)?.trim() || undefined;
	const model = str(o, "model", 128);
	const effort = str(o, "effort", 128);
	for (const [key, value] of Object.entries({ model, effort })) {
		if (
			value !== undefined &&
			(!validAcpModeId(value) || value !== value.trim())
		)
			throw new RpcError("bad_request", `launch: bad ${key}`);
	}
	if ((model || effort) && !preferredAcpBinary(harness as LaunchHarness))
		throw new RpcError(
			"bad_request",
			"First-turn settings require a managed ACP launch",
		);
	const resumeSessionId = str(o, "resumeSessionId", 200);
	if (
		resumeSessionId !== undefined &&
		(workspace !== "current" ||
			prompt ||
			name ||
			model ||
			effort ||
			!resumeSessionId ||
			resumeSessionId.includes("%2F") ||
			/\p{Cc}/u.test(resumeSessionId) ||
			(!ACP_BINARIES.has(harness as LaunchHarness) &&
				!driverFor(harness)?.resumeArgs?.(resumeSessionId)))
	)
		throw new RpcError(
			"bad_request",
			"Cannot resume this session with the requested launch options",
		);
	return {
		nonce,
		cwd,
		harness: harness as LaunchHarness,
		workspace,
		...(resumeSessionId ? { resumeSessionId } : {}),
		...(branch ? { branch } : {}),
		...(base ? { base } : {}),
		...(prompt?.trim() ? { prompt } : {}),
		...(name ? { name } : {}),
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
	};
}

/** What the launcher reads and how long it waits (tests shorten them). */
export interface LaunchTiming {
	pollMs: number;
	/** From start until the agent must be ready (no dialog showing). */
	readyMs: number;
	/** How long a dialog in the terminal may wait for the operator. */
	terminalMs: number;
	/** Unchanged pane reads before an agent with no status counts as ready. */
	quietPolls: number;
	/** A finished launch stays readable this long. */
	keepMs: number;
	/** How often a launch on another machine is read there. */
	followMs: number;
	/** How long the login shell may take to list installed harnesses. */
	probeMs: number;
	/** How long a read waits for it (under a relayed read's time limit). */
	probeWaitMs: number;
}

const TIMING: LaunchTiming = {
	pollMs: 500,
	readyMs: 120_000,
	terminalMs: 30 * 60_000,
	quietPolls: 4,
	keepMs: 30 * 60_000,
	followMs: 1500,
	probeMs: 30_000,
	probeWaitMs: 5000,
};

/** A read the home node answers for another node (federation `launch.*`). */
export type LaunchRead =
	| { op: "launch.status"; id: string }
	| { op: "launch.options" }
	| { op: "launch.refs"; cwd: string };

export interface LaunchDeps {
	registry: Registry;
	events: EventBus;
	store: Store;
	acting: Acting;
	machineId: () => string;
	machine: () => string;
	/** Sends the first message as the operator; the receipt state it got. */
	send: (
		user: VerifiedUser,
		agentId: string,
		body: string,
		confirm?: boolean,
	) => Promise<ReceiptState | null>;
	commands?: (id: string) => Promise<CommandCatalog>;
	/**
	 * The launched agent showed up (a local id here; a pool address for a
	 * launch followed on another machine): the operator started it, so its
	 * finished and failed turns are worth a notification.
	 */
	onAgent?: (agentId: string) => void;
	/** Tests: a private tmux server (`-L`). */
	tmux?: TmuxOptions;
	/** Tests: the login shell (default: the operator's, from the passwd entry). */
	shell?: string;
	/** Tests: the command a harness starts with (default `exec <bin>`). */
	command?: (h: LaunchHarness, resumeArgs?: string[]) => string;
	savedSession?: (id: string) => Agent | undefined;
	timing?: Partial<LaunchTiming>;
}

interface Resume {
	args: string[];
	acp: boolean;
}

interface Running {
	resume?: Resume;
	state: LaunchState;
	params: LaunchParams;
	nonce: string;
}

const FINAL = new Set(["done", "failed"]);
/** Receipt states in which a message reached the session. */
const HANDED: ReadonlySet<ReceiptState> = new Set([
	"sent",
	"delivered",
	"read",
	"acked",
	"replied",
	"done",
]);

export class Launches {
	private d: LaunchDeps;
	private t: LaunchTiming;
	private runs = new Map<string, Running>();
	/** `<login> <nonce>` → launch id, so a repeated press starts nothing new. */
	private nonces = new Map<string, string>();
	private starting = new Map<string, Promise<LaunchState>>();
	private harnessCache: { at: number; ids: Set<string> } | null = null;
	private probing: Promise<Set<string> | null> | null = null;
	private seq = 0;

	constructor(deps: LaunchDeps) {
		this.d = deps;
		this.t = { ...TIMING, ...deps.timing };
	}

	/** The login shell harnesses start under. */
	private shell(): string {
		if (this.d.shell) return this.d.shell;
		let sh: string | undefined;
		try {
			sh = userInfo().shell ?? undefined;
		} catch {}
		sh ||= process.env.SHELL;
		return sh && isAbsolute(sh) ? sh : "/bin/sh";
	}

	private command(h: LaunchHarness, args?: string[]): string {
		if (this.d.command) return this.d.command(h, args);

		return harnessCommand(h, args);
	}

	/**
	 * True when `m` names this machine: empty, its id, or its name (any
	 * case, with or without the tailnet's domain).
	 */
	isHere(m: string | null | undefined): boolean {
		if (!m || m === "local") return true;
		if (m === this.d.machineId()) return true;
		const name = this.d.machine().toLowerCase();
		const want = m.toLowerCase();
		return want === name || want.split(".")[0] === name;
	}

	/** Another machine's id, by id or name (any case, with or without the domain). */
	private peerId(m: string): string | null {
		const pool = this.d.registry.pool;
		if (!pool) return null;
		const exact = pool.machineIdOf(m);
		if (exact) return exact;
		const want = m.toLowerCase().split(".")[0];
		return (
			pool.machines().find((x) => x.name.toLowerCase() === want)?.machineId ??
			null
		);
	}

	/** A launch by id: this node's, or one it follows on another machine. */
	get(id: string): LaunchState | null {
		return this.runs.get(id)?.state ?? null;
	}

	/**
	 * `POST /agents/launch`: here, or relayed to the machine's home node,
	 * which verifies the assertion itself (src/service/acting.ts).
	 */
	async launch(
		principal: Principal,
		machine: string | null,
		params: unknown,
		assertion?: unknown,
	): Promise<LaunchState> {
		const here = this.isHere(machine);
		const result = (await this.d.acting.run(
			principal,
			"agents.launch",
			{
				machine: here
					? null
					: machine
						? (this.peerId(machine) ?? machine)
						: null,
			},
			params,
			assertion,
		)) as LaunchState;
		const pool = this.d.registry.pool;
		const remoteId = !here && machine ? this.peerId(machine) : null;
		if (!remoteId || !pool) return result;
		return this.follow(remoteId, result, principal);
	}

	/** The acting handler: checks the request, starts the launch, returns at once. */
	start(user: VerifiedUser, raw: unknown): Promise<LaunchState> {
		const p = parseLaunchParams(raw);
		const key = `${user.login} ${p.nonce}`;
		const held = this.nonces.get(key);
		if (held && this.runs.has(held))
			return Promise.resolve({ ...this.runs.get(held)!.state });
		// Two presses at once: the second waits for the first.
		const busy = this.starting.get(key);
		if (busy) return busy;
		const started = this.startOnce(user, p, key).finally(() =>
			this.starting.delete(key),
		);
		this.starting.set(key, started);
		return started;
	}

	private async prepareResume(
		harness: LaunchHarness,
		id: string,
		cwd: string,
	): Promise<Resume> {
		const key = this.d.registry.agentId(harness, id, null);
		const active = this.d.registry.get(key);
		if (active && active.status !== "gone")
			throw new RpcError("conflict", "This session is already open");
		const known = this.d.savedSession?.(key);
		let original = known?.cwd;
		let resume: Resume;
		if (known?.meta.acp === "1") {
			if (
				known.sessionId !== id ||
				known.harness !== harness ||
				known.meta.acpResume !== "1" ||
				!ACP_BINARIES.has(harness)
			)
				throw new RpcError(
					"bad_request",
					"This provider did not advertise ACP resume or load",
				);
			resume = { args: ["pulsar", "acp", harness, "--resume", id], acp: true };
		} else {
			const driver = driverFor(harness);
			const args = driver?.resumeArgs?.(id);
			if (!args || !driver?.scan)
				throw new RpcError(
					"bad_request",
					"This session cannot resume with its native CLI",
				);
			const saved = await driver.readSession?.(id);
			if (!saved)
				throw new RpcError(
					"not_found",
					"The native session is no longer available",
				);
			original = saved.cwd ?? original;
			const rows = await driver.scan.sessions();
			if (rows.some((row) => row.sessionId === id))
				throw new RpcError("conflict", "This session is already open");
			if (rows.some((row) => row.sessionId.startsWith("pid:")))
				throw new RpcError(
					"conflict",
					"The harness has an open session whose identity is still unknown",
				);
			resume = { args, acp: false };
		}
		if (!original || (await this.folder(original)) !== cwd)
			throw new RpcError(
				"bad_request",
				"Resume this session in its original folder",
			);
		return resume;
	}

	private async startOnce(
		user: VerifiedUser,
		p: LaunchParams,
		key: string,
	): Promise<LaunchState> {
		this.prune();

		const cwd = await this.folder(p.cwd);
		const resume = p.resumeSessionId
			? await this.prepareResume(p.harness, p.resumeSessionId, cwd)
			: undefined;
		let dir = cwd;
		let worktree: {
			root: string;
			path: string;
			branch: string;
			base: string;
		} | null = null;
		const id = `${Date.now().toString(36)}${(this.seq++ % 1296).toString(36).padStart(2, "0")}`;
		if (p.workspace === "worktree") {
			const root = await worktreeRoot(cwd);
			if (!root)
				throw new RpcError("bad_request", `${cwd} is not in a git repo`);
			const branch = p.branch ?? `pulsar/${p.harness}-${id}`;
			const fmt = await runGit(root, ["check-ref-format", "--branch", branch], {
				mode: "read",
			});
			if (!fmt.ok)
				throw new RpcError("bad_request", `not a valid branch name: ${branch}`);
			const exists = await runGit(
				root,
				["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
				{ mode: "read" },
			);
			if (exists.ok)
				throw new RpcError("bad_request", `branch ${branch} already exists`);
			const base = p.base ?? "HEAD";
			const ok = await runGit(
				root,
				[
					"rev-parse",
					"--verify",
					"--quiet",
					"--end-of-options",
					`${base}^{commit}`,
				],
				{ mode: "read" },
			);
			if (!ok.ok)
				throw new RpcError("bad_request", `no branch or commit ${base}`);
			const path = join(dirname(root), `${basename(root)}-${slug(branch)}`);
			if (await exists_(path))
				throw new RpcError("bad_request", `${path} already exists`);
			worktree = { root, path, branch, base };
			dir = join(path, relative(root, cwd));
		}

		const now = Date.now();
		const state: LaunchState = {
			id,
			machineId: this.d.machineId(),
			machine: this.d.machine(),
			harness: p.harness,
			cwd: dir,
			branch: worktree?.branch ?? null,
			step: worktree ? "worktree" : "starting",
			detail: null,
			error: null,
			agentId: null,
			session: p.resumeSessionId
				? `pulsar-resume-${createHash("sha256")
						.update(JSON.stringify([p.harness, p.resumeSessionId]))
						.digest("hex")
						.slice(0, 32)}`
				: `pulsar-${id}`,
			prompt: !!p.prompt,
			sent: false,
			startedAt: now,
			updatedAt: now,
		};
		const run: Running = { state, params: p, nonce: p.nonce, resume };
		this.runs.set(id, run);
		this.nonces.set(key, id);
		this.emit(run);
		void this.drive(run, user, worktree).catch((e: unknown) =>
			this.fail(run, user, (e as Error).message || "launch failed"),
		);
		return { ...state };
	}

	/** `~` and `~/x` on this machine; must be an existing folder. */
	private async folder(raw: string): Promise<string> {
		const cwd =
			raw === "~"
				? homedir()
				: raw.startsWith("~/")
					? join(homedir(), raw.slice(2))
					: raw;
		let s: Awaited<ReturnType<typeof stat>>;
		try {
			s = await stat(cwd);
		} catch {
			throw new RpcError(
				"not_found",
				`no folder ${cwd} on ${this.d.machine()}`,
			);
		}
		if (!s.isDirectory())
			throw new RpcError("bad_request", `${cwd} is not a folder`);
		// Real path: git's worktree root is one, and agents report theirs.
		return realpath(cwd).catch(() => cwd);
	}

	private async drive(
		run: Running,
		user: VerifiedUser,
		worktree: {
			root: string;
			path: string;
			branch: string;
			base: string;
		} | null,
	) {
		const s = run.state;
		const label = LAUNCH_HARNESSES[s.harness].label;
		if (worktree) {
			this.set(run, { step: "worktree", detail: worktree.path });
			const r = await runGit(worktree.root, [
				"worktree",
				"add",
				"-b",
				worktree.branch,
				"--",
				worktree.path,
				worktree.base,
			]);
			if (!r.ok)
				return this.fail(
					run,
					user,
					`Couldn't create the worktree: ${r.message}`,
				);
		}
		const { model, effort } = run.params;
		const configured = !!(model || effort);
		const args = configured
			? [
					"pulsar",
					"acp",
					s.harness,
					...(model ? ["--model", model] : []),
					...(effort ? ["--effort", effort] : []),
				]
			: run.resume?.args;
		this.set(run, {
			step: "starting",
			detail: configured
				? "Confirming first-turn settings with the provider"
				: null,
		});
		const started = await newSession(
			s.session!,
			s.cwd,
			[this.shell(), "-lic", this.command(s.harness, args)],
			this.d.tmux,
		);
		if (!started.ok)
			return this.fail(run, user, `Couldn't start tmux: ${started.error}`);
		const pane = started.pane;
		const shellPid = await panePid(pane, this.d.tmux);
		this.set(run, { step: "waiting" });

		const t0 = Date.now();
		/** The ready clock: from the start, or from when a dialog was answered. */
		let readyFrom = t0;
		let last = "";
		let quiet = 0;
		let named = false;
		let terminalSince: number | null = null;
		for (;;) {
			await new Promise((r) => setTimeout(r, this.t.pollMs));
			const text = await capture(pane, { ...this.d.tmux, lines: 0 });
			if (text === null || !(await panePid(pane, this.d.tmux))) {
				const tail = last.trim().split("\n").slice(-3).join(" ").trim();
				return this.fail(
					run,
					user,
					`${label} exited${configured ? " before confirming first-turn settings" : ""}${tail ? `: ${tail.slice(0, 300)}` : ""}${configured && s.prompt ? "; your message was not sent" : ""}`,
				);
			}
			quiet = text === last ? quiet + 1 : 0;
			last = text;
			const agent = await this.match(
				s,
				shellPid,
				t0,
				run.params.resumeSessionId,
				configured ? true : run.resume?.acp,
			);
			if (agent) {
				// The launcher knows the pane: Stop and typing reach it.
				if (agent.meta.tmux !== pane) agent.meta.tmux = pane;
				if (agent.id !== s.agentId) this.d.onAgent?.(agent.id);
				if (!named && run.params.name) {
					this.d.registry.setIdentity(agent, { name: run.params.name });
					named = true;
				}
			}
			const needs = agent ? this.d.registry.needsYou(agent.id) : null;
			const dialog =
				terminalDialog(text) ??
				(needs?.reason === "terminal"
					? (needs.detail?.replace(/^Waiting in the terminal:\s*/i, "") ??
						"a dialog")
					: null);
			const agentId = agent?.id ?? null;
			if (dialog) {
				terminalSince ??= Date.now();
				this.set(run, {
					step: "terminal",
					detail: `Waiting in the terminal: ${dialog}`,
					agentId,
				});
				if (Date.now() - terminalSince > this.t.terminalMs)
					return this.fail(
						run,
						user,
						`Nobody answered the ${dialog} dialog on ${s.machine}${s.prompt ? "; your message was not sent" : ""}`,
					);
				continue;
			}
			if (terminalSince !== null) {
				// Answered: the ready clock starts again.
				terminalSince = null;
				readyFrom = Date.now();
				quiet = 0;
			}
			const confirmed =
				!!agent &&
				(!model || agent.model === model) &&
				(!effort || agent.meta.acpEffort === effort);
			this.set(run, {
				step: "waiting",
				detail:
					configured && !confirmed
						? "Waiting for the provider to confirm first-turn settings"
						: null,
				agentId,
			});
			// Ready: a message would reach the session now (its Pulsar
			// connection or a push path, not only an inbox), and it is idle.
			const ready =
				confirmed &&
				(!run.params.prompt ||
					(agent.reach === "push" &&
						(agent.status === "idle" ||
							(agent.status === "unknown" && quiet >= this.t.quietPolls))));
			if (ready) break;
			if (Date.now() - readyFrom > this.t.readyMs)
				return this.fail(
					run,
					user,
					configured && !confirmed
						? `The provider did not confirm first-turn settings${s.prompt ? "; your message was not sent" : ""}.`
						: agent && agent.reach !== "push"
							? `${label} started, but Pulsar can't reach its session to send your message. Run \`pulsar doctor\` on ${s.machine}.`
							: agent
								? `${label} didn't become ready${s.prompt ? "; your message was not sent" : ""}`
								: `${label} started but didn't connect to Pulsar. Run \`pulsar doctor\` on ${s.machine}.`,
				);
		}

		const agentId = s.agentId!;
		if (run.params.prompt) {
			this.set(run, { step: "sending" });
			let state: ReceiptState | null;
			try {
				state = await this.d.send(user, agentId, run.params.prompt, configured);
			} catch (e) {
				return this.fail(
					run,
					user,
					`Couldn't send your message: ${(e as Error).message}`,
				);
			}
			// Only a message handed to the session counts as sent.
			if (!state || !HANDED.has(state))
				return this.fail(
					run,
					user,
					`Couldn't send your message (${state ?? "no receipt"})`,
				);
			this.set(run, { sent: true });
		}
		this.set(run, { step: "done", detail: null });
		this.audit(user, run, true, null);
	}

	/**
	 * The new agent: its process is the pane's (the login shell exec'd into
	 * the harness) or under it; else, with no pid, one that registered in
	 * that folder since the launch started.
	 */
	private async match(
		s: LaunchState,
		shellPid: number | null,
		since: number,
		resumeSessionId?: string,
		managed?: boolean,
	): Promise<Agent | null> {
		const candidates = this.d.registry
			.all()
			.filter(
				(a) =>
					a.harness === s.harness &&
					a.status !== "gone" &&
					(managed !== true || a.meta.acp === "1") &&
					(!resumeSessionId ||
						(a.sessionId === resumeSessionId &&
							(a.meta.acp === "1") === managed)),
			);
		if (candidates.length === 0) return null;
		if (shellPid) {
			const direct = candidates.find((a) => a.pid === shellPid);
			if (direct) return direct;
			const procs = await processSnapshot(1000, "user");
			const under = (pid: number) => {
				for (let p = pid, n = 0; p > 1 && n < 32; n++) {
					if (p === shellPid) return true;
					const next = procs.get(p)?.ppid;
					if (!next || next === p) return false;
					p = next;
				}
				return false;
			};
			const child = candidates.find((a) => a.pid !== null && under(a.pid));
			if (child) return child;
		}
		if (resumeSessionId || managed === true) return null;
		const recent = candidates.filter(
			(a) => a.pid === null && a.cwd === s.cwd && a.createdAt >= since,
		);
		return recent.length === 1 ? recent[0]! : null;
	}

	private set(run: Running, patch: Partial<LaunchState>) {
		const s = run.state;
		if (FINAL.has(s.step)) return;
		let changed = false;
		for (const [k, v] of Object.entries(patch) as [keyof LaunchState, never][])
			if (s[k] !== v) {
				(s as unknown as Record<string, unknown>)[k] = v;
				changed = true;
			}
		if (!changed) return;
		s.updatedAt = Date.now();
		this.emit(run);
	}

	private fail(run: Running, user: Principal, error: string) {
		if (FINAL.has(run.state.step)) return;
		this.set(run, { step: "failed", error: error.slice(0, 500) });
		this.audit(user, run, false, error);
	}

	private emit(run: Running) {
		this.d.events.emit("launch", { ...run.state });
	}

	/** The outcome, next to the acting op's own audit row (which ends when it returns). */
	private audit(
		user: Principal,
		run: Running,
		ok: boolean,
		error: string | null,
	) {
		const s = run.state;
		this.d.store.audit({
			at: Date.now(),
			principal: principalLabel(user),
			op: "agents.launch.result",
			target: s.agentId ?? `launch:${s.id}`,
			detail: JSON.stringify({
				harness: s.harness,
				cwd: s.cwd,
				session: s.session,
				...(error ? { error } : {}),
			}),
			ok,
		});
	}

	/** Drops finished launches past `keepMs`. */
	private prune(now = Date.now()) {
		for (const [id, r] of this.runs)
			if (FINAL.has(r.state.step) && now - r.state.updatedAt > this.t.keepMs) {
				this.runs.delete(id);
				for (const [k, v] of this.nonces) if (v === id) this.nonces.delete(k);
			}
	}

	// ------------------------------------------------------- another machine

	/**
	 * Follows a launch on another machine: reads its state there until it
	 * ends, and repeats it here as `launch` events with pool addresses.
	 */
	private follow(
		machineId: string,
		first: LaunchState,
		as: Principal,
	): LaunchState {
		const id = `${machineId}/${first.id}`;
		const held = this.runs.get(id);
		if (held) return held.state;
		const local = (r: LaunchState): LaunchState => ({
			...r,
			id,
			machineId,
			agentId: r.agentId ? `${machineId}/${r.agentId}` : null,
		});
		const run: Running = {
			state: local(first),
			params: {
				nonce: "remote",
				cwd: first.cwd,
				harness: first.harness,
				workspace: "current",
			},
			nonce: "",
		};
		this.runs.set(id, run);
		this.emit(run);
		const pool = this.d.registry.pool!;
		void (async () => {
			let misses = 0;
			let doneSeen: number | null = null;
			const until = Date.now() + this.t.readyMs + this.t.terminalMs + 60_000;
			while (!FINAL.has(run.state.step) && Date.now() < until) {
				// Every read leaves an audit row there: slower while a dialog waits.
				const wait = this.t.followMs * (run.state.step === "terminal" ? 3 : 1);
				await new Promise((r) => setTimeout(r, wait));
				try {
					const next = (await pool.launchRead?.(
						machineId,
						{ op: "launch.status", id: first.id },
						as,
					)) as LaunchState | undefined;
					if (!next) break;
					misses = 0;
					const l = local(next);
					if (l.agentId && l.agentId !== run.state.agentId)
						this.d.onAgent?.(l.agentId);
					// Done there: shown done here once this node's pool lists the
					// agent (the app opens its session next), or after a while.
					if (
						l.step === "done" &&
						l.agentId &&
						!this.d.registry.find(l.agentId)
					) {
						doneSeen ??= Date.now();
						if (Date.now() - doneSeen < 15_000) continue;
					}
					const changed =
						l.updatedAt !== run.state.updatedAt || l.step !== run.state.step;
					run.state = l;
					if (changed) this.emit(run);
				} catch {
					// A few missed reads are a slow link; many are a lost machine.
					if (++misses >= 10) break;
				}
			}
			if (!FINAL.has(run.state.step)) {
				run.state = {
					...run.state,
					step: "failed",
					error: `Lost touch with ${run.state.machine}; the agent may still start there`,
					updatedAt: Date.now(),
				};
				this.emit(run);
			}
		})();
		return { ...run.state };
	}

	// ----------------------------------------------------------------- reads

	/** `GET /machines/:m/projects` and `/refs`, here or on the machine's home node. */
	async read(
		principal: Principal,
		machine: string | null,
		req: LaunchRead,
	): Promise<unknown> {
		if (principal.kind !== "human")
			throw new RpcError("forbidden", "only the human operator starts agents");
		const m = machine ?? "";
		if (this.isHere(m)) return this.readHere(principal, req);
		const pool = this.d.registry.pool;
		const id = this.peerId(m);
		if (!pool || !id) throw new RpcError("not_found", `no machine ${m}`);
		if (!pool.launchRead)
			throw new RpcError("unreachable", "no other machines are linked");
		const r = await pool.launchRead(id, req, principal);
		if (req.op === "launch.status") {
			const s = r as LaunchState;
			return {
				...s,
				id: `${id}/${s.id}`,
				machineId: id,
				agentId: s.agentId ? `${id}/${s.agentId}` : null,
			};
		}
		return r;
	}

	/** The home node's answer to a read (federation receiver, and here). */
	async readHere(principal: Principal, req: LaunchRead): Promise<unknown> {
		if (principal.kind !== "human")
			throw new RpcError("forbidden", "only the human operator starts agents");
		switch (req.op) {
			case "launch.status": {
				const s = this.get(String(req.id));
				if (!s || s.id.includes("/"))
					throw new RpcError("not_found", `no launch ${req.id}`);
				return s;
			}
			case "launch.options":
				return this.options();
			case "launch.refs":
				return this.refs(String(req.cwd).slice(0, MAX_PATH));
			default:
				throw new RpcError("bad_request", "unknown launch read");
		}
	}

	/** Folders agents ran in here, and which harnesses are installed. */
	async options(): Promise<LaunchOptions> {
		const by = new Map<string, LaunchProject>();
		const note = (path: string, live: boolean, at: number) => {
			const p = by.get(path) ?? {
				path,
				name: basename(path) || path,
				agents: 0,
				lastSeen: 0,
			};
			if (live) p.agents++;
			p.lastSeen = Math.max(p.lastSeen, at);
			by.set(path, p);
		};
		for (const a of this.d.registry.all())
			if (a.cwd && isAbsolute(a.cwd) && !a.id.includes("/"))
				note(a.cwd, a.status !== "gone", a.lastSeen);
		for (const r of this.runs.values())
			if (!r.state.id.includes("/"))
				note(r.state.cwd, false, r.state.startedAt);
		const projects = [...by.values()]
			.sort((a, b) => b.lastSeen - a.lastSeen)
			.slice(0, 200);
		const installed = await this.installed();
		return {
			machineId: this.d.machineId(),
			machine: this.d.machine(),
			home: homedir(),
			projects,
			checked: installed !== null,
			harnesses: await Promise.all(
				HARNESS_IDS.map(async (id) => {
					const entry = LAUNCH_HARNESSES[id];
					const binary = preferredAcpBinary(id);
					const acp =
						binary !== undefined &&
						installed?.has("pulsar") &&
						installed.has(binary);
					const native = !("managed" in entry) && installed?.has(entry.bin);
					const mode = acp ? "acp" : native ? "native" : undefined;
					return {
						id,
						label: entry.label,
						installed: mode !== undefined,
						...(mode ? { mode } : {}),
						...(acp ? { settings: await this.settingHints(id) } : {}),
					};
				}),
			),
		};
	}

	private async settingHints(
		harness: LaunchHarness,
	): Promise<NonNullable<LaunchOptions["harnesses"][number]["settings"]>> {
		if (!this.d.commands) return {};
		const sample = this.d.registry
			.live()
			.find(
				(agent) =>
					agent.harness === harness &&
					agent.meta.acp === "1" &&
					agent.reach === "push",
			);
		if (!sample) return {};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const wait = new Promise<null>((done) => {
			timer = setTimeout(() => done(null), 500);
		});
		const catalog = await Promise.race([
			this.d.commands(sample.id).catch(() => null),
			wait,
		]).finally(() => clearTimeout(timer));
		const hints: Partial<
			Record<keyof LaunchSettings, { value: string; label: string }[]>
		> = {};
		for (const kind of ["model", "effort"] as const) {
			const choices = catalog?.commands.find(
				({ name }) => name === kind,
			)?.argumentChoices;
			if (choices?.length) hints[kind] = choices.slice(0, 100);
		}
		return hints;
	}

	/**
	 * Harnesses a login shell finds (the daemon's own PATH is not the
	 * operator's). Cached for a few minutes.
	 */
	/**
	 * What a login shell finds, or null while it is still looking. A read
	 * waits up to `probeWaitMs`; the shell itself may take `probeMs` (a
	 * cold rc file), and its answer is kept once it finishes.
	 */
	private async installed(): Promise<Set<string> | null> {
		const c = this.harnessCache;
		if (c && Date.now() - c.at < 5 * 60_000) return c.ids;
		// One login shell at a time: concurrent reads share its answer.
		this.probing ??= this.probe().finally(() => {
			this.probing = null;
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const wait = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), this.t.probeWaitMs);
		});
		try {
			return await Promise.race([this.probing, wait]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async probe(): Promise<Set<string> | null> {
		const r = await exec(this.shell(), ["-lic", PROBE_SCRIPT], {
			lane: "user",
			timeoutMs: this.t.probeMs,
			cwd: homedir(),
		});
		// Only a probe that finished is kept: a timed-out or failed one is
		// asked again next time.
		if (!r.ok || r.timedOut) return null;
		const ids = parseProbe(r.stdout);
		this.harnessCache = { at: Date.now(), ids };
		return ids;
	}

	/** Branches of the repo that holds `cwd` (newest first). */
	async refs(raw: string): Promise<LaunchRefs> {
		let cwd: string;
		try {
			cwd = await this.folder(raw.trim());
		} catch {
			return { root: null, current: null, branches: [] };
		}
		const root = await worktreeRoot(cwd);
		if (!root) return { root: null, current: null, branches: [] };
		const [head, list] = await Promise.all([
			runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
				mode: "read",
			}),
			runGit(
				root,
				[
					"for-each-ref",
					"--sort=-committerdate",
					"--count=500",
					"--format=%(refname)",
					"refs/heads",
					"refs/remotes",
				],
				{ mode: "read" },
			),
		]);
		const branches: LaunchRefs["branches"] = [];
		if (list.ok)
			for (const line of list.stdout.split("\n")) {
				const ref = line.trim();
				if (ref.startsWith("refs/heads/"))
					branches.push({ name: ref.slice(11), remote: false });
				else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD"))
					branches.push({ name: ref.slice(13), remote: true });
			}
		return {
			root,
			current: head.ok ? head.stdout.trim() || null : null,
			branches,
		};
	}
}

async function exists_(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
