import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Action, skillFor } from "../setup/actions.ts";
import { exists, runCli, setTomlKey, tryCli, which } from "../setup/files.ts";
import { codexTurnFailed } from "../transcripts/turn-outcome.ts";
import { MAX_BLOCK_SECONDS } from "../types.ts";
import { headAsync, lastModel, run, statAsync, tailAsync } from "../util.ts";
import { codexIdent } from "./codex-ident.ts";
import { codexPending } from "./codex-interactions.ts";
import { codexNames } from "./codex-names.ts";
import {
	codexControlAvailable,
	codexControlReady,
	codexRpc,
} from "./codex-rpc.ts";
import { codexStatuses } from "./codex-status.ts";
import { parseCodex } from "./codex-transcript.ts";
import { CodexWatch } from "./codex-watch.ts";
import { listCodexSubagents } from "./more-subagents.ts";
import type { HarnessDriver, ServerPrompt } from "./types.ts";

const codexFiles = new Map<string, string>();
/** Threads with no rollout found, and when: the folders are walked again only after `MISS_RETRY_MS`. */
const codexMisses = new Map<string, number>();
const MISS_RETRY_MS = 10_000;

/** Codex rollout: `rollout-…-<thread>.jsonl` in the last month of ~/.codex/sessions. */
async function codexRolloutAsync(threadId: string): Promise<string | null> {
	const cached = codexFiles.get(threadId);
	if (
		cached &&
		(await access(cached).then(
			() => true,
			() => false,
		))
	)
		return cached;
	const missed = codexMisses.get(threadId);
	if (missed !== undefined && Date.now() - missed < MISS_RETRY_MS) return null;
	const root = join(
		process.env.CODEX_HOME ?? join(homedir(), ".codex"),
		"sessions",
	);
	const newest = async (dir: string, n?: number) =>
		(await readdir(dir)).sort().reverse().slice(0, n);
	try {
		const days: string[] = [];
		for (const y of await newest(root, 2))
			for (const m of await newest(join(root, y), 2))
				for (const d of await newest(join(root, y, m)))
					days.push(join(root, y, m, d));
		for (const dir of days.slice(0, 31)) {
			const file = (await readdir(dir)).find((f) =>
				f.endsWith(`${threadId}.jsonl`),
			);
			if (file) {
				codexFiles.set(threadId, join(dir, file));
				codexMisses.delete(threadId);
				return join(dir, file);
			}
		}
	} catch {}
	if (codexMisses.size > 1000) codexMisses.clear();
	codexMisses.set(threadId, Date.now());
	return null;
}

/** Whether the thread's latest turn still runs, from the app-server; null when it can't tell. */
async function codexTurnRuns(threadId: string): Promise<boolean | null> {
	if (!(await codexControlReady())) return null;
	const [turns] = (await codexRpc(
		[["thread/turns/list", { threadId, limit: 1 }]],
		{ timeoutMs: 3000 },
	)) as [{ data?: Array<{ status?: string }> }];
	const status = turns.data?.[0]?.status;
	return status ? status === "inProgress" : null;
}

/** The model each rollout named last, kept while the file is unchanged. */
const modelCache = new Map<
	string,
	{ size: number; mtimeMs: number; model: string | null }
>();

let watch: CodexWatch | null = null;
/** Rollout prompts of answerable threads the app-server hasn't sent: first seen. */
const orphans = new Map<string, number>();
/** How long such a prompt waits for the app-server before its read-only card shows. */
const ORPHAN_MS = 10_000;
/** The daemon's one client on Codex's app-server (made on first use). */
const codexWatch = () => {
	watch ??= new CodexWatch();
	return watch;
};

export const codex: HarnessDriver = {
	...codexIdent,

	push: {
		canPush(agent) {
			return agent.harness === codex.id && !!agent.sessionId;
		},
		async deliver(agent, text) {
			try {
				await run("codex", [
					"queue",
					"--thread",
					agent.sessionId!,
					"--message",
					text,
					"--resume",
				]);
				return { ok: true, via: "codex-queue" };
			} catch (e) {
				return { ok: false, via: "codex-queue", detail: (e as Error).message };
			}
		},
	},

	// The TUI's turns run in the shared app-server daemon (unless started in
	// embedded mode, which has no control socket to reach).
	canInterrupt(agent) {
		return (
			agent.harness === codex.id && !!agent.sessionId && codexControlAvailable()
		);
	},
	async interrupt(agent) {
		const via = "codex-app-server";
		if (!agent.sessionId || !(await codexControlReady()))
			return { result: "unsupported", via, detail: "no app-server socket" };
		const threadId = agent.sessionId;
		try {
			const [turns] = (await codexRpc([
				["thread/turns/list", { threadId, limit: 1 }],
			])) as [{ data?: Array<{ id: string; status?: string }> }];
			const turn = turns.data?.[0];
			if (turn?.status !== "inProgress") return { result: "not-running", via };
			await codexRpc([["turn/interrupt", { threadId, turnId: turn.id }]]);
			return { result: "interrupted", via };
		} catch (e) {
			const msg = (e as Error).message;
			// The turn ended between the two calls.
			if (/no active turn|expected active turn/.test(msg))
				return { result: "not-running", via };
			// Not loaded in the daemon: an embedded-mode TUI, or not open at all.
			return { result: "unsupported", via, detail: msg };
		}
	},

	/** The model in the thread's latest turn context (long rollouts state it near the start). */
	async model(agent) {
		const file = agent.sessionId
			? await codexRolloutAsync(agent.sessionId)
			: null;
		const st = file ? await statAsync(file) : null;
		if (!file || !st) return null;
		const hit = modelCache.get(file);
		if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs)
			return hit.model;
		const model =
			lastModel(await tailAsync(file, 512 * 1024)) ??
			lastModel(await headAsync(file));
		if (modelCache.size > 1000) modelCache.clear();
		modelCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, model });
		return model;
	},

	transcript: {
		async locate(agent) {
			const file = agent.sessionId
				? await codexRolloutAsync(agent.sessionId)
				: null;
			return file ? { kind: "file", path: file } : null;
		},
		parse: parseCodex,
		turnFailed: codexTurnFailed,
	},

	// Spawned threads; their transcript is the thread's own (`transcript.locate`).
	subagents: { list: listCodexSubagents },

	// Threads in the app-server daemon: answered from the app (codex-watch.ts).
	// Others (`--no-daemon`): read from the rollout, answered in the terminal.
	serverInteractions: {
		intervalMs: 2000,
		async pending(agents) {
			const live = agents.filter((a) => a.sessionId && a.status !== "gone");
			await codexWatch()
				.sync(live.map((a) => a.sessionId!))
				.catch(() => false);
			const out: ServerPrompt[] = [];
			const covered = new Map<string, Set<string>>();
			for (const a of live)
				if (codexWatch().covers(a.sessionId!)) {
					covered.set(a.sessionId!, codexWatch().callIds(a.sessionId!));
					for (const p of codexWatch().prompts(a.sessionId!))
						out.push({ ...p, sessionId: a.sessionId! });
				}
			const now = Date.now();
			const seen = new Set<string>();
			for (const p of await codexPending(live, codexRolloutAsync)) {
				const calls = covered.get(p.sessionId);
				if (!calls) {
					out.push(p);
					continue;
				}
				// A call the app-server never sent this client: shown read-only
				// after a while, so a prompt never goes missing.
				if (calls.has(p.key)) continue;
				const id = `${p.sessionId}:${p.key}`;
				seen.add(id);
				const since = orphans.get(id) ?? now;
				orphans.set(id, since);
				if (now - since >= ORPHAN_MS) out.push(p);
			}
			for (const id of orphans.keys()) if (!seen.has(id)) orphans.delete(id);
			return out;
		},
		reply: (p, r) => codexWatch().reply(p, r),
	},

	names: { intervalMs: 5000, read: (agents) => codexNames(agents) },

	liveStatus: {
		intervalMs: 3000,
		read: (agents) => codexStatuses(agents, codexRolloutAsync, codexTurnRuns),
	},

	async sessionLog(agent) {
		const file = agent.sessionId
			? await codexRolloutAsync(agent.sessionId)
			: null;
		return file ? tailAsync(file, 512 * 1024) : "";
	},

	setup: {
		detect: (path) =>
			!!which("codex", path) || exists(join(homedir(), ".codex")),
		configured: () => {
			try {
				return runCli("codex", ["mcp", "get", "pulsar"]).includes("pulsar");
			} catch {
				return false;
			}
		},
		plan: (ctx) => [
			...(ctx.mcp
				? [
						{
							client: "codex",
							describe: "codex mcp add pulsar",
							apply: () => {
								tryCli("codex", ["mcp", "remove", "pulsar"]);
								runCli("codex", [
									"mcp",
									"add",
									"pulsar",
									"--",
									ctx.node,
									ctx.cli,
									"mcp",
								]);
								// pulsar's tools only message other agents: approve them, and let send await_reply / wait block past 60s.
								const toml = join(homedir(), ".codex", "config.toml");
								setTomlKey(
									toml,
									"mcp_servers.pulsar",
									"default_tools_approval_mode",
									'"approve"',
								);
								setTomlKey(
									toml,
									"mcp_servers.pulsar",
									"tool_timeout_sec",
									String(MAX_BLOCK_SECONDS + 100),
								);
							},
							undo: {
								type: "cli",
								cmd: "codex",
								args: ["mcp", "remove", "pulsar"],
							},
						} satisfies Action,
					]
				: []),
			...skillFor("codex", join(homedir(), ".codex", "skills"), ctx),
		],
	},
};
