import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { DaemonClient } from "../client.ts";
import {
	type Checks as CheckList,
	Checks,
	checkLine,
	type DoctorJson,
} from "../diagnostics/checks.ts";
import { exec } from "../exec.ts";
import { CLIENTS } from "../harnesses/index.ts";
import { envPort } from "../http/config.ts";
import type { DiagFacts, DiagHarness } from "../http/wire.ts";
import type { LagStats } from "../service/jobs.ts";
import type { PoolMachine } from "../service/pool.ts";
import { PROTOCOL_VERSION } from "../types.ts";
import { newer } from "../util.ts";
import { VERSION } from "../version.ts";
import { which } from "./files.ts";
import { loadJsonc } from "./jsonc.ts";
import type { MeshFacts } from "./mesh-doctor.ts";

interface Status {
	version: string;
	protocol: number;
	pid: number;
	agents: number;
	/** Absent on older daemons. */
	eventLoop?: LagStats;
	/** Claude sessions on a hook without `--timeout`; absent on older daemons. */
	oldHookSessions?: { name: string; pid: number | null }[];
}

async function latestVersion(): Promise<string | null> {
	try {
		const res = await fetch("https://registry.npmjs.org/pulsar/latest", {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) return null;
		return ((await res.json()) as { version?: string }).version ?? null;
	} catch {
		return null;
	}
}

/**
 * The PATH to check the `pulsar` command against. In a terminal, this
 * process's. With `json` (the service daemon's child), the operator's
 * login shell's: the service's own PATH lacks ~/.local/bin and the like,
 * so checking it would report a problem the operator doesn't have. Null
 * when that shell couldn't be read (the check is skipped, not failed).
 */
export function commandPath(
	json: boolean,
	shellPath: string | null,
	envPath = process.env.PATH ?? "",
): string | null {
	return json ? shellPath : envPath;
}

/**
 * The harnesses on this machine. In a terminal, found on this process's
 * PATH. With `json` (the service daemon's child), on the login shell's
 * PATH: the service's own PATH misses harnesses in ~/.local/bin and the
 * like. Without that PATH, the service's own still finds some, and
 * `partial` says the list may be short (never a false "not installed").
 */
export function detectHarnesses<C extends { detect(path?: string): boolean }>(
	clients: readonly C[],
	json: boolean,
	shellPath: string | null,
): { detected: C[]; partial: boolean } {
	const path = json ? (shellPath ?? undefined) : undefined;
	return {
		detected: clients.filter((c) => c.detect(path)),
		partial: json && shellPath === null,
	};
}

/** A harness's `--version`: its first version number, else its first line. */
export function parseVersion(out: string): string | null {
	const m = out.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
	return m ? m[0] : out.split("\n")[0]?.trim().slice(0, 60) || null;
}

/** `PULSAR_BIN:<command>:<path>` and `PULSAR_PATH:<PATH>` lines from a shell's output. */
export function parseBinLines(stdout: string): {
	bins: Map<string, string>;
	path: string | null;
} {
	const bins = new Map<string, string>();
	for (const m of stdout.matchAll(/PULSAR_BIN:([a-z]+):(\/[^\r\n]*)/g))
		bins.set(m[1]!, m[2]!.trim());
	const path = stdout.match(/PULSAR_PATH:(\/[^\r\n]*)/)?.[1]?.trim();
	return { bins, path: path || null };
}

/**
 * Where a login shell finds each command: the operator's PATH, which the
 * daemon's service PATH is not. Null when the shell fails.
 */
async function loginShellPaths(
	bins: string[],
): Promise<ReturnType<typeof parseBinLines> | null> {
	let shell: string | undefined;
	try {
		shell = userInfo().shell ?? undefined;
	} catch {}
	shell ||= process.env.SHELL;
	if (!shell || !isAbsolute(shell)) shell = "/bin/sh";
	// Fixed command names only (driver ids), never input.
	const script = `for c in ${bins.join(" ")}; do p=$(command -v "$c" 2>/dev/null) && printf '\\nPULSAR_BIN:%s:%s\\n' "$c" "$p"; done; printf '\\nPULSAR_PATH:%s\\n' "$PATH"; exit 0`;
	const r = await exec(shell, ["-lic", script], {
		timeoutMs: 15_000,
		cwd: homedir(),
	});
	return r.ok && !r.timedOut ? parseBinLines(r.stdout) : null;
}

async function harnessVersion(
	path: string | null,
	shellPath: string | null,
): Promise<string | null> {
	if (!path) return null;
	// With the login shell's PATH: a wrapper script may need its tools.
	const r = await exec(path, ["--version"], {
		timeoutMs: 4000,
		...(shellPath ? { env: { ...process.env, PATH: shellPath } } : {}),
	});
	return r.ok ? parseVersion(r.stdout || r.stderr || "") : null;
}

/**
 * Checks the daemon and every harness integration. Returns an exit code.
 * Prints each check as it runs; with `json` (the daemon's Diagnostics,
 * src/diagnostics/local.ts) prints one `DoctorJson` instead and asks npm
 * for nothing.
 */
export async function runDoctor(
	opts: { quiet?: boolean; meshOnly?: boolean; json?: boolean } = {},
): Promise<number> {
	await loadJsonc();
	let shown = "daemon";
	const checks = new Checks(
		opts.json
			? undefined
			: (c) => {
					// The mesh checks under their own heading, as before.
					if (c.group === "mesh" && shown !== "mesh" && !opts.meshOnly)
						console.log("agent mesh");
					shown = c.group;
					console.log(`  ${checkLine(c)}`);
				},
	);
	if (!opts.json) console.log(`Pulsar ${VERSION} doctor`);
	const facts = await doctorChecks(checks, opts);
	if (opts.json) {
		const out: DoctorJson = { version: VERSION, checks: checks.list, facts };
		console.log(JSON.stringify(out));
	}
	return checks.problems ? 1 : 0;
}

/** The one list of doctor checks (the CLI and the app both show it). */
async function doctorChecks(
	checks: CheckList,
	opts: { quiet?: boolean; meshOnly?: boolean; json?: boolean },
): Promise<DiagFacts> {
	const { ok, bad, note } = checks;
	const facts: DiagFacts = { tailscale: null, certDays: null, harnesses: [] };
	const mesh = async () => {
		checks.group = "mesh";
		const m = await runMeshChecks(checks);
		if (m) {
			facts.tailscale = m.tailscale;
			facts.certDays = m.certDays;
		}
	};
	if (opts.meshOnly) {
		// Read-only: no daemon is started.
		await mesh();
		return facts;
	}
	checks.group = "daemon";
	let oldHooks: Status["oldHookSessions"] = [];
	const client = new DaemonClient();
	try {
		await client.connect(true);
		await client.call("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
			registration: { role: "cli" },
		});
		const s = await client.call<Status>("status");
		oldHooks = s.oldHookSessions ?? [];
		ok(`daemon ${s.version} running (pid ${s.pid}), ${s.agents} live agent(s)`);
		const lag = s.eventLoop;
		if (lag) {
			const line = `event loop: p99 ${lag.p99} ms, max ${lag.max} ms`;
			if (lag.lastStall) {
				const c = lag.causes;
				const causes = c
					? ` (${c.busy} JS, ${c.gc} GC, ${c.starved} starved of CPU)`
					: "";
				const top = lag.lastStall.cause?.top.length
					? `; top: ${lag.lastStall.cause.top.join(", ")}`
					: "";
				note(
					`${line}; ${lag.stalls} stall(s) over 200 ms${causes}, last ${lag.lastStall.ms} ms at ${lag.lastStall.at} (running: ${lag.lastStall.culprit}${top})`,
				);
			} else ok(line);
			if (lag.gc?.long)
				note(
					`garbage collection: ${lag.gc.long} pause(s) of 50 ms or more, longest ${lag.gc.maxMs} ms`,
				);
		}
		if (s.version !== VERSION)
			note(
				`daemon runs ${s.version}; it switches to ${VERSION} after \`pulsar stop\``,
			);
		client.close();
	} catch (e) {
		bad(`daemon: ${(e as Error).message}`);
	}

	checks.group = "harnesses";
	// For the app (the CLI never asked): the PATH the operator's commands
	// run with (the service's own PATH is not it), and harness versions.
	const paths = opts.json
		? await loginShellPaths(
				CLIENTS.map((c) => c.id).filter((id) => /^[a-z]+$/.test(id)),
			)
		: null;
	const { detected, partial } = detectHarnesses(
		CLIENTS,
		opts.json === true,
		paths?.path ?? null,
	);
	if (partial)
		note(
			"harnesses: only those found without your login shell are listed (its PATH couldn't be read)",
		);
	const found: Promise<DiagHarness>[] = [];
	for (const c of detected) {
		const configured = c.configured();
		if (configured) ok(`${c.label}: configured`);
		else
			note(
				`${c.label}: found, not configured`,
				`run \`pulsar setup --client ${c.id}\``,
			);
		if (opts.json)
			found.push(
				harnessVersion(
					paths?.bins.get(c.id) ?? which(c.id, paths?.path ?? undefined),
					paths?.path ?? null,
				).then((version) => ({
					id: c.id,
					label: c.label,
					version,
					configured,
				})),
			);
	}
	facts.harnesses = await Promise.all(found);

	if (CLIENTS.some((c) => c.id === "opencode" && c.detect())) {
		// The daemon runs `opencode api`; its PATH may find an old OpenCode first.
		const { staleOpencodeOnPath, OPENCODE_HOME_BIN } = await import(
			"../harnesses/opencode-api.ts"
		);
		const { serviceVariables } = await import("./service.ts");
		const daemonPath = serviceVariables(process.env, process.execPath).PATH;
		const stale = await staleOpencodeOnPath(daemonPath ?? "");
		if (stale)
			note(
				`OpenCode: the daemon's PATH finds ${stale.path} (${stale.version}), too old for \`opencode api\`; Pulsar uses the running service's own executable (or ${OPENCODE_HOME_BIN()}) instead`,
				"update or remove the old one",
			);
	}

	checks.group = "daemon";
	const { shimStatus } = await import("./shim.ts");
	const operatorPath = commandPath(opts.json === true, paths?.path ?? null);
	if (operatorPath === null)
		note(
			"`pulsar` command: not checked (your login shell's PATH couldn't be read)",
		);
	else {
		const shim = shimStatus(homedir(), operatorPath);
		if (shim.ok) ok(shim.message);
		else bad(shim.message);
	}

	checks.group = "approvals";
	const { installedApprovalHook } = await import("../harnesses/claude.ts");
	const hook = installedApprovalHook();
	if (hook) {
		// The command is `<node> <cli> hook claude-permission`; both files must exist.
		const missing = hook
			.split(/\s+/)
			.slice(0, 2)
			.map((p) => p.replace(/^'|'$/g, ""))
			.filter((p) => p.startsWith("/") && !existsSync(p));
		if (missing.length)
			bad(
				`Claude Code approvals: the hook runs ${missing.join(", ")}, which is missing`,
				"re-run `pulsar setup`",
			);
		else {
			const { remoteConfig } = await import("../http/config.ts");
			const { localPasskeyCount, NO_LOCAL_PASSKEY } = await import(
				"./passkey-hint.ts"
			);
			if (remoteConfig().mode === "off")
				note(
					"Claude Code approvals: hook installed, but the agent mesh is off on this machine, so prompts stay in the terminal",
					"run `pulsar mesh on`",
				);
			else if ((await localPasskeyCount()) === 0)
				note(`Claude Code approvals: ${NO_LOCAL_PASSKEY}`);
			else ok("Claude Code approvals: permission prompts relay to the app");
			const { installedApprovalHookTimeout, APPROVAL_HOOK_TIMEOUT_S } =
				await import("../harnesses/claude.ts");
			const timeout = installedApprovalHookTimeout();
			if (timeout !== null && timeout < APPROVAL_HOOK_TIMEOUT_S)
				note(
					`Claude Code approvals: the hook times out after ${timeout} s, so a question or plan left for the app longer ends in the terminal`,
					`re-run \`pulsar setup\` (${APPROVAL_HOOK_TIMEOUT_S} s)`,
				);
			else if (!hook.includes("--timeout"))
				note(
					"Claude Code approvals: the hook doesn't pass its timeout, so the app has 9 minutes to answer a permission prompt",
					"re-run `pulsar setup` to give it a day",
				);
			if (oldHooks.length)
				note(
					`Claude Code approvals: ${oldHooks.length} running session(s) started before the hook passed its timeout (${oldHooks
						.map((o) => (o.pid ? `${o.name}, pid ${o.pid}` : o.name))
						.join("; ")}); the app has 9 minutes to answer their prompts`,
					"restart these sessions to give the app a day to answer",
				);
		}
	} else if (
		CLIENTS.some((c) => c.id === "claude" && c.detect()) &&
		(await import("../http/config.ts")).meshIsOn()
	)
		note(
			"Claude Code approvals: off",
			"run `pulsar mesh on` to answer permission prompts from the app",
		);

	const { readSettings, remoteConfig, tailnetUrl, tlsSetting } = await import(
		"../http/config.ts"
	);
	const remote = remoteConfig();
	checks.group = "remote access";
	if (remote.mode === "tailscale") {
		const { BRING_CERT_HINT, ENABLE_HTTPS_HINT, runTailscale, tailscaleSelf } =
			await import("../http/identity.ts");
		const self = await tailscaleSelf();
		// The operator's own certificate replaces `tailscale cert` (the mesh checks inspect it).
		const ownCert = tlsSetting(readSettings()) !== null;
		if (!self) bad("remote access: Tailscale is not running or not logged in");
		else if (!self.ownerLogin)
			bad("remote access: this node has no Tailscale user (a tagged node)");
		else if (!ownCert && !self.certDomains.includes(self.dnsName)) {
			const { readControlPlane } = await import("../http/control.ts");
			const { magicDnsSuffix } = await import("../federation/tailnet.ts");
			const control = await readControlPlane(
				runTailscale,
				magicDnsSuffix(self.dnsName),
			);
			bad(
				`remote access: ${control.kind === "custom" ? BRING_CERT_HINT : ENABLE_HTTPS_HINT}`,
			);
		} else
			ok(
				`remote access: ${tailnetUrl(self.dnsName, remote.port)} for ${self.ownerLogin}`,
			);
	} else if (remote.mode === "dev")
		note(
			`remote access: dev mode for ${remote.login} on http://127.0.0.1:${remote.port}/`,
		);
	if (remote.mode !== "off") await mesh();
	else if (!opts.quiet) {
		// Setup (quiet) prints its own line about the mesh at the end.
		const { MESH_OFF_HINT } = await import("./mesh-cli.ts");
		checks.group = "mesh";
		note(MESH_OFF_HINT);
	}

	checks.group = "daemon";
	if (!existsSync(process.execPath))
		bad(`node binary ${process.execPath} is missing`, "re-run `pulsar setup`");

	// The daemon's report asks npm for nothing (the app compares the pool's versions).
	if (!opts.quiet && !opts.json) {
		const latest = await latestVersion();
		if (latest && newer(latest, VERSION))
			note(`Pulsar ${latest} is available`, "run `npx pulsar@latest setup`");
	}
	return facts;
}

async function runMeshChecks(checks: CheckList): Promise<MeshFacts | null> {
	const { ok, bad, note } = checks;
	const { readSettings, remoteConfig, tlsSetting } = await import(
		"../http/config.ts"
	);
	const settings = readSettings();
	const { runTailscale } = await import("../http/identity.ts");
	const { meshChecks } = await import("./mesh-doctor.ts");
	const { runCommand, serviceEnv } = await import("./service.ts");
	const remote = remoteConfig();
	if (remote.mode === "dev") {
		note(
			`remote access: dev mode for ${remote.login} on http://127.0.0.1:${remote.port}/`,
		);
		return null;
	}
	return await meshChecks(
		{
			tailscale: runTailscale,
			run: runCommand,
			fetch,
			service: serviceEnv(),
			remoteOn: remote.mode === "tailscale",
			port: envPort(),
			tls: tlsSetting(settings),
			...(settings.rpId ? { rpId: settings.rpId } : {}),
			allowed: (await import("../federation/config.ts")).readPoolConfig().allow,
			// The daemon's own view of each peer's link (its federation).
			pool: async () => {
				const { DaemonClient } = await import("../client.ts");
				const client = new DaemonClient();
				try {
					await client.connect(false);
					const s = await client.call<{ pool?: PoolMachine[] }>("status", {});
					return s.pool ?? null;
				} catch {
					return null;
				} finally {
					client.close?.();
				}
			},
		},
		{ ok, bad, note },
	);
}
