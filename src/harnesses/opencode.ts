import { readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "../exec.ts";
import { lazyCrypto } from "../lazy.ts";
import { type ProcessInfo, processSnapshot } from "../processes.ts";
import { jsonAction, skillFor } from "../setup/actions.ts";
import { exists, getPath, readJsonc, which } from "../setup/files.ts";
import { type Agent, isFolderGuess } from "../types.ts";
import { headAsync } from "../util.ts";
import { listOpencodeSubagents } from "./more-subagents.ts";
import {
	opencodeGet,
	opencodeRequest,
	opencodeServiceRunning,
} from "./opencode-api.ts";
import { opencodeIdent } from "./opencode-ident.ts";
import { opencodePending, opencodeReply } from "./opencode-interactions.ts";
import {
	nativeOpencodeId,
	opencodeTranscript,
	readOpencodeSession,
} from "./opencode-transcript.ts";
import type { HarnessDriver, Scanned } from "./types.ts";

/** A session's messages from its local server, newest first; [] when unavailable. */
async function opencodeMessages(sessionId: string): Promise<unknown[]> {
	const table = await processSnapshot();
	if (!opencodeServiceRunning(table)) return [];
	const list = await opencodeGet<unknown[]>(
		table,
		`/api/session/${encodeURIComponent(sessionId)}/message`,
	);
	return Array.isArray(list) ? list : [];
}

interface SessionInfo {
	id?: string;
	directory?: string;
	location?: { directory?: string };
	title?: string;
	parentID?: string | null;
	model?: { id?: string };
	time?: { created?: number; updated?: number };
}

/** OpenCode subcommands that are not a TUI session. */
const NOT_TUI = new Set([
	"serve",
	"api",
	"run",
	"mcp",
	"auth",
	"models",
	"upgrade",
	"uninstall",
	"web",
	"export",
	"import",
	"stats",
	"debug",
	"acp",
	"github",
	"agent",
	"session",
	"completion",
]);

/**
 * OpenCode TUI processes that use the shared service: `opencode`,
 * `opencode <folder>` or `opencode attach`, never a `--standalone` one
 * (that runs its own private server, out of reach).
 */
export function opencodeTuis(table: Map<number, ProcessInfo>): ProcessInfo[] {
	const out: ProcessInfo[] = [];
	for (const p of table.values()) {
		if (!opencodeIdent.matchProcess(p.args)) continue;
		const argv = p.args.split(/\s+/);
		const sub = argv[1] ?? "";
		if (NOT_TUI.has(sub) || argv.includes("--standalone")) continue;
		out.push(p);
	}
	return out;
}

/** Working folders of processes, by pid (a process keeps its folder: cached). */
const cwdCache = new Map<number, string | null>();
async function processCwds(
	pids: number[],
): Promise<Map<number, string | null>> {
	let want = pids.filter((p) => !cwdCache.has(p));
	if (want.length > 0 && process.platform === "linux") {
		const read = await Promise.all(
			want.map((pid) => readlink(`/proc/${pid}/cwd`).catch(() => null)),
		);
		want.forEach((pid, i) => {
			if (read[i]) cwdCache.set(pid, read[i]);
		});
		// Not readable in /proc (another user, a hardened /proc): ask lsof.
		want = want.filter((_, i) => !read[i]);
	}
	if (want.length > 0) {
		// `-a -d cwd`: only the cwd entry of each process; exits 1 when one is gone.
		const r = await exec(
			"lsof",
			["-a", "-d", "cwd", "-Fpn", "-p", want.join(",")],
			{ timeoutMs: 4000 },
		);
		let pid = 0;
		for (const line of r.stdout.split("\n")) {
			if (line.startsWith("p")) pid = Number(line.slice(1));
			else if (line.startsWith("n") && pid) cwdCache.set(pid, line.slice(1));
		}
		// Unreadable now is asked again next scan, not cached as "none".
	}
	if (cwdCache.size > 500) {
		for (const pid of cwdCache.keys())
			if (!pids.includes(pid)) cwdCache.delete(pid);
	}
	return new Map(pids.map((p) => [p, cwdCache.get(p) ?? null]));
}

const dirOf = (info: SessionInfo | null) =>
	info?.location?.directory ?? info?.directory ?? null;

/** A launch argument alone becomes stale after a tab switch. Require the live
 * TUI's original ID to agree with its project's single tab as well. */
function requestedTab(args: string): string | null {
	const argv = args.split(/\s+/);
	const flag = argv.findIndex((arg) => arg === "--session" || arg === "-s");
	const id = flag > 0 ? argv[flag + 1] : undefined;
	return id && nativeOpencodeId(id) ? id : null;
}

async function soleTabs(): Promise<Map<string, string>> {
	const state =
		process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	const tabs = new Map<string, string>();
	try {
		const rows = JSON.parse(
			await headAsync(
				join(state, "opencode/latest/tui/tabs.json"),
				1024 * 1024,
			),
		);
		if (rows.global?.tabs?.length) return tabs;
		for (const [cwd, value] of Object.entries(rows.cwd ?? {})) {
			const list = (value as { tabs?: { sessionID?: string }[] } | null)?.tabs;
			const id =
				Array.isArray(list) && list.length === 1
					? list[0]?.sessionID
					: undefined;
			if (typeof id === "string" && nativeOpencodeId(id)) tabs.set(cwd, id);
		}
	} catch {}
	return tabs;
}

/**
 * OpenCode sessions, from its shared server: every root session running
 * now and explicit TUI sessions whose single native workspace tab matches the
 * requested session ID. Other idle TUIs can supply a folder guess (marked
 * `meta.sessionFrom = "folder"`) when their folder has no active session.
 */
export async function scanOpencode(): Promise<Scanned[]> {
	const table = await processSnapshot();
	// `opencode api` starts a service when none runs; only look when one already does.
	if (!opencodeServiceRunning(table)) return [];
	const active = await opencodeGet<Record<string, { type?: string }>>(
		table,
		"/api/session/active",
	);
	// Unreadable is not "no sessions": that would mark every session gone.
	if (!active || typeof active !== "object")
		throw new Error("opencode: session list unreadable");
	const out: Scanned[] = [];
	const taken = new Set<string>();
	const busyDirs = new Set<string>();
	const scanned = (
		id: string,
		info: SessionInfo | null,
		status: Scanned["status"],
		meta: Record<string, string> = {},
	): Scanned => ({
		harness: opencode.id,
		sessionId: id,
		pid: null,
		cwd: dirOf(info),
		status,
		model: info?.model?.id ?? null,
		// OpenCode titles a session itself; a rename replaces the title.
		meta: {
			...(info?.title
				? {
						title: info.title,
						harnessName: info.title,
						harnessNameSource: "auto",
					}
				: {}),
			...meta,
		},
	});
	for (const [id, state] of Object.entries(active)) {
		const info = await opencodeGet<SessionInfo>(
			table,
			`/api/session/${encodeURIComponent(id)}`,
		);
		if (info?.parentID) continue;
		taken.add(id);
		const dir = dirOf(info);
		if (dir) busyDirs.add(dir);
		// Named by the service itself: a real target again (not a folder guess).
		out.push(
			scanned(id, info, state?.type === "running" ? "busy" : "idle", {
				sessionFrom: "active",
			}),
		);
	}
	const tuis = opencodeTuis(table);
	if (tuis.length === 0) return out;
	const cwds = await processCwds(tuis.map((t) => t.pid));
	const tabs = tuis.some((t) => requestedTab(t.args))
		? await soleTabs()
		: new Map<string, string>();
	const counts = new Map<string, number>();
	for (const cwd of cwds.values())
		if (cwd) counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
	for (const tui of tuis) {
		const cwd = cwds.get(tui.pid);
		if (!cwd) continue;
		const requested = requestedTab(tui.args);
		if (requested && counts.get(cwd) === 1 && tabs.get(cwd) === requested) {
			const existing = out.find(
				(row) => row.sessionId === requested && row.cwd === cwd,
			);
			if (existing) {
				existing.meta.tuiPid = String(tui.pid);
				existing.meta.sessionFrom = "tab";
				continue;
			}
			const info = await opencodeGet<SessionInfo>(
				table,
				`/api/session/${requested}`,
			);
			if (info?.id === requested && !info.parentID && dirOf(info) === cwd) {
				taken.add(requested);
				out.push(
					scanned(requested, info, "idle", {
						tuiPid: String(tui.pid),
						sessionFrom: "tab",
					}),
				);
				continue;
			}
		}
		if (busyDirs.has(cwd)) continue;
		const list = await opencodeGet<SessionInfo[]>(
			table,
			`/api/session?directory=${encodeURIComponent(cwd)}&parentID=null&limit=10&order=desc`,
		);
		const newest = (Array.isArray(list) ? list : [])
			.filter(
				(s) => s.id && !s.parentID && !taken.has(s.id) && dirOf(s) === cwd,
			)
			.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0];
		if (!newest?.id) continue;
		taken.add(newest.id);
		out.push(
			scanned(newest.id, newest, "idle", {
				tuiPid: String(tui.pid),
				sessionFrom: "folder",
			}),
		);
	}
	return out;
}

function opencodeConfigDir(): string {
	return (
		process.env.OPENCODE_CONFIG_DIR ||
		join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
	);
}

function opencodeConfig(): string {
	if (process.env.OPENCODE_CONFIG) return process.env.OPENCODE_CONFIG;
	const dir = opencodeConfigDir();
	const jsonc = join(dir, "opencode.jsonc");
	return exists(jsonc) || !exists(join(dir, "opencode.json"))
		? jsonc
		: join(dir, "opencode.json");
}

function hasOpenCodeTarget(agent: Agent): boolean {
	return (
		agent.harness === "opencode" && !!agent.sessionId && !isFolderGuess(agent)
	);
}

export const opencode: HarnessDriver = {
	...opencodeIdent,
	readSession: readOpencodeSession,
	nativeResume: {
		valid: nativeOpencodeId,
		args: (id) => ["opencode", "--session", id],
	},
	transcript: opencodeTranscript,

	scan: { intervalMs: 20_000, sessions: scanOpencode },

	serverInteractions: {
		intervalMs: 1500,
		pending: opencodePending,
		reply: opencodeReply,
	},

	// Child sessions. `session.prompt` on a child's own id lands in that
	// session and starts its turn (verified live with OpenCode 2.2.5).
	subagents: {
		list: listOpencodeSubagents,
		direct: true,
		interruptBySession: true,
	},

	push: {
		// A folder guess is never woken or resumed: the operator may not be
		// using it. Its messages wait in the inbox (the TUI's pulsar tools
		// read them).
		canPush: hasOpenCodeTarget,
		canSteer: hasOpenCodeTarget,
		async deliver(agent, text, priority) {
			const table = await processSnapshot(2000, "user");
			if (!opencodeServiceRunning(table))
				return {
					ok: false,
					via: "opencode-api",
					detail: "OpenCode service is not running",
				};
			const id = `msg_pulsar_${lazyCrypto().randomUUID()}`;
			const r = await opencodeRequest(
				table,
				"POST",
				`/api/session/${encodeURIComponent(agent.sessionId!)}/prompt`,
				{
					body: {
						id,
						text,
						delivery: priority === "urgent" ? "steer" : "queue",
						resume: true,
					},
					timeoutMs: 20_000,
					lane: "user",
				},
			);
			const via = "opencode-api";
			if (!r.ok)
				return { ok: false, via, detail: r.error, uncertain: r.uncertain };
			type PromptReceipt = { id?: string; sessionID?: string; type?: string };
			const body = r.body as (PromptReceipt & { data?: PromptReceipt }) | null;
			const receipt = body?.data ?? body;
			if (
				receipt?.id === id &&
				receipt.sessionID === agent.sessionId &&
				receipt.type === "user"
			)
				return { ok: true, via };
			return {
				ok: false,
				via,
				uncertain: true,
				detail:
					"OpenCode did not confirm the submitted prompt on this session.",
			};
		},
	},

	// Runs owned by the OpenCode service stop with `session.interrupt`; a
	// `--standalone` TUI runs in its own server and answers false.
	canInterrupt: hasOpenCodeTarget,
	async interrupt(agent) {
		const via = "opencode-api";
		if (!hasOpenCodeTarget(agent))
			return {
				result: "unsupported",
				via,
				detail: "No confirmed OpenCode session",
			};
		const table = await processSnapshot();
		if (!agent.sessionId || !opencodeServiceRunning(table))
			return {
				result: "unsupported",
				via,
				detail: "OpenCode service is not running",
			};
		const r = await opencodeRequest(
			table,
			"POST",
			`/api/session/${encodeURIComponent(agent.sessionId)}/interrupt`,
			{ timeoutMs: 20_000, lane: "user" },
		);
		if (!r.ok) {
			if (r.status === 404 || /404|SessionNotFound/i.test(r.error))
				return { result: "not-running", via, detail: "no such session" };
			return { result: "unsupported", via, detail: r.error };
		}
		const body = r.body as {
			interrupted?: boolean;
			data?: { interrupted?: boolean };
		} | null;
		const interrupted = body?.interrupted ?? body?.data?.interrupted;
		return { result: interrupted ? "interrupted" : "not-running", via };
	},

	/** The model of the session's newest assistant message. */
	async model(agent) {
		if (!agent.sessionId) return null;
		for (const m of (await opencodeMessages(agent.sessionId)) as Array<{
			type?: string;
			model?: { id?: string };
		}>) {
			if (m.type === "assistant" && m.model?.id) return m.model.id;
		}
		return null;
	},

	async sessionLog(agent) {
		if (!agent.sessionId) return "";
		return JSON.stringify(
			(await opencodeMessages(agent.sessionId)).slice(0, 50),
		);
	},

	setup: {
		detect: (path) =>
			!!which("opencode", path) ||
			exists(opencodeConfigDir()) ||
			exists(opencodeConfig()),
		configured: () => {
			const cfg = readJsonc(opencodeConfig());
			return !!(
				getPath(cfg, ["mcp", "servers", "pulsar"]) ??
				getPath(cfg, ["mcp", "pulsar"])
			);
		},
		plan: (ctx) => {
			const file = opencodeConfig();
			const cfg = readJsonc(file);
			const mcp = getPath(cfg, ["mcp"]) as Record<string, unknown> | undefined;
			// OpenCode 2 nests servers under mcp.servers; older configs put them right under mcp.
			const path =
				!mcp || "servers" in mcp
					? ["mcp", "servers", "pulsar"]
					: ["mcp", "pulsar"];
			return [
				...(ctx.mcp
					? [
							jsonAction("opencode", file, path, {
								type: "local",
								command: [ctx.node, ctx.cli, "mcp"],
								enabled: true,
							}),
						]
					: []),
				...skillFor("opencode", join(opencodeConfigDir(), "skills"), ctx),
			];
		},
	},
};
