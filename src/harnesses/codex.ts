import { access, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve, sep } from "node:path";
import { lazyCrypto } from "../lazy.ts";
import { type Action, cliUndo, skillFor } from "../setup/actions.ts";
import { exists, runCli, setTomlKey, tryCli, which } from "../setup/files.ts";
import { codexTurnFailed } from "../transcripts/turn-outcome.ts";
import { MAX_BLOCK_SECONDS } from "../types.ts";
import { headAsync, lastModel, run, statAsync, tailAsync } from "../util.ts";
import { codexRolloutIdentity } from "./codex-child-ident.ts";
import { CODEX_THREAD_ID, codexIdent } from "./codex-ident.ts";
import { codexPending } from "./codex-interactions.ts";
import { codexNames } from "./codex-names.ts";
import {
	CodexRpcError,
	codexControlAvailable,
	codexControlReady,
	codexHome,
	codexRpc,
} from "./codex-rpc.ts";
import { codexStatuses } from "./codex-status.ts";
import { codexThreadHistory } from "./codex-thread-history.ts";
import { parseCodex } from "./codex-transcript.ts";
import { CodexWatch } from "./codex-watch.ts";
import { listCodexSubagents } from "./more-subagents.ts";
import type { HarnessDriver, ServerPrompt } from "./types.ts";

const codexFiles = new Map<string, string>();
/** Threads with no rollout found, and when: the folders are walked again only after `codexMissRetry.ms`. */
const codexMisses = new Map<string, number>();
/**
 * Shorter than the app's wait before it says a transcript is missing
 * (web/src/session/TranscriptMissing.tsx): a new thread's rollout shows
 * before that. Tests shorten it.
 */
export const codexMissRetry = { ms: 2000 };

/** Codex rollout: `rollout-…-<thread>.jsonl` in the last month of ~/.codex/sessions. */
export async function codexRolloutAsync(
	threadId: string,
): Promise<string | null> {
	const root = join(codexHome(), "sessions");
	const cacheKey = `${root}\0${threadId}`;
	const cached = codexFiles.get(cacheKey);
	if (
		cached &&
		(await access(cached).then(
			() => true,
			() => false,
		))
	)
		return cached;
	const missed = codexMisses.get(cacheKey);
	if (missed !== undefined && Date.now() - missed < codexMissRetry.ms)
		return null;
	const indexed = CODEX_THREAD_ID.test(threadId)
		? indexedRollout(threadId)
		: null;
	if (indexed && (await statAsync(indexed))) {
		codexFiles.set(cacheKey, indexed);
		return indexed;
	}
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
				codexFiles.set(cacheKey, join(dir, file));
				codexMisses.delete(cacheKey);
				return join(dir, file);
			}
		}
	} catch {}
	if (codexMisses.size > 1000) codexMisses.clear();
	codexMisses.set(cacheKey, Date.now());
	return null;
}

async function latestTurn(threadId: string) {
	const [turns] = (await codexRpc(
		[["thread/turns/list", { threadId, limit: 1 }]],
		{ timeoutMs: 3000 },
	)) as [{ data?: Array<{ id?: string; status?: string }> }];
	return turns.data?.[0];
}

/** Whether the thread's latest turn still runs, from the app-server; null when it can't tell. */
async function codexTurnRuns(threadId: string): Promise<boolean | null> {
	if (!(await codexControlReady())) return null;
	const status = (await latestTurn(threadId))?.status;
	return status ? status === "inProgress" : null;
}

/** Null means Codex has not accepted a steer, so normal queue delivery is safe. */
async function steerCodexTurn(threadId: string, text: string) {
	if (!(await codexControlReady())) return null;
	const turn = await latestTurn(threadId).catch(() => null);
	if (turn?.status !== "inProgress" || !turn.id) return null;
	const via = "codex-steer";
	try {
		const [receipt] = (await codexRpc([
			[
				"turn/steer",
				{
					threadId,
					expectedTurnId: turn.id,
					input: [{ type: "text", text, text_elements: [] }],
					clientUserMessageId: lazyCrypto().randomUUID(),
				},
			],
		])) as [{ turnId?: string }];
		return receipt?.turnId === turn.id
			? { ok: true, via }
			: {
					ok: false,
					via,
					uncertain: true,
					detail: "Codex did not confirm steering the active turn.",
				};
	} catch (error) {
		// Only retry via the queue after a definitive refusal. A lost response
		// may mean the original turn already received the message.
		if (
			error instanceof CodexRpcError &&
			(error.code === -32601 ||
				/no active turn|expected active turn|turn id mismatch|turn is not steerable/i.test(
					error.message,
				))
		)
			return null;
		return {
			ok: false,
			via,
			uncertain: !(error instanceof CodexRpcError),
			detail: (error as Error).message,
		};
	}
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

/** Only a loaded child that grants direct input can receive this addressed queue submission. */
async function deliverCodexSubagent(
	threadId: string | null,
	text: string,
	urgent: boolean,
) {
	const via = "codex-queue";
	if (
		!threadId ||
		!CODEX_THREAD_ID.test(threadId) ||
		!(await codexControlReady())
	)
		return {
			ok: false,
			via,
			detail: "Codex subagent is not on the local app server.",
		};
	let submitting = false;
	try {
		const [result] = (await codexRpc(
			[["thread/read", { threadId, includeTurns: false }]],
			{ experimental: true },
		)) as [
			{
				thread?: {
					id?: string;
					parentThreadId?: string | null;
					canAcceptDirectInput?: boolean;
					status?: { type?: string };
				};
			},
		];
		const thread = result?.thread;
		if (
			thread?.id !== threadId ||
			!thread.parentThreadId ||
			thread.canAcceptDirectInput !== true ||
			!["active", "idle"].includes(thread.status?.type ?? "")
		)
			return {
				ok: false,
				via,
				detail: "This Codex subagent no longer accepts direct input.",
			};
		if (urgent) {
			const steered = await steerCodexTurn(threadId, text);
			if (steered) return steered;
		}
		submitting = true;
		const [receipt] = (await codexRpc(
			[
				[
					"thread/queue/add",
					{
						threadId,
						input: [{ type: "text", text, text_elements: [] }],
						clientUserMessageId: lazyCrypto().randomUUID(),
					},
				],
			],
			{ experimental: true },
		)) as [{ queuedSubmission?: { id?: string } }];
		return receipt?.queuedSubmission?.id
			? { ok: true, via }
			: {
					ok: false,
					via,
					uncertain: true,
					detail: "Codex did not return a queue receipt.",
				};
	} catch (e) {
		return {
			ok: false,
			via,
			...(submitting && !(e instanceof CodexRpcError) && { uncertain: true }),
			detail: (e as Error).message,
		};
	}
}

/** Older threads can fall outside the recent rollout search. Use the native thread index. */
function indexedRollout(id: string): string | null {
	try {
		const { DatabaseSync } = createRequire(import.meta.url)(
			"node:sqlite",
		) as typeof import("node:sqlite");
		const db = new DatabaseSync(join(codexHome(), "state_5.sqlite"), {
			readOnly: true,
		});
		try {
			const row = db
				.prepare(
					"SELECT rollout_path FROM threads WHERE id = ? AND archived = 0",
				)
				.get(id);
			const file = row?.rollout_path;
			return typeof file === "string" &&
				file === resolve(file) &&
				file.startsWith(`${join(codexHome(), "sessions")}${sep}`) &&
				file.endsWith(`-${id}.jsonl`)
				? file
				: null;
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}

export const codex: HarnessDriver = {
	...codexIdent,
	nativeResume: {
		valid: (id) => CODEX_THREAD_ID.test(id),
		args: (id) => ["codex", "resume", id],
		async loaded(id, cwd) {
			if (!CODEX_THREAD_ID.test(id) || !(await codexControlReady()))
				return null;
			const [result] = (await codexRpc(
				[["thread/read", { threadId: id, includeTurns: false }]],
				{ experimental: true, timeoutMs: 2500 },
			)) as [
				{
					thread?: {
						id?: string;
						cwd?: string;
						parentThreadId?: string | null;
						status?: { type?: string };
					};
				},
			];
			const thread = result?.thread;
			if (thread?.id !== id || thread.parentThreadId || thread.cwd !== cwd)
				throw new Error("Codex returned a different thread or workspace");
			switch (thread.status?.type) {
				case "notLoaded":
					return null;
				case "idle":
					return "idle";
				case "active":
					return "busy";
				default:
					throw new Error("Codex could not confirm the thread's state");
			}
		},
	},
	async readSession(id) {
		if (!CODEX_THREAD_ID.test(id)) return null;
		const file = await codexRolloutAsync(id);
		if (!file) return null;
		const header = codexRolloutIdentity(
			id,
			(await headAsync(file, 1024 * 1024)).split("\n", 1)[0] ?? "",
		);
		const stamp =
			header?.cwd && !header.parentId ? await statAsync(file) : null;
		return stamp && header
			? { cwd: header.cwd, lastSeen: stamp.mtimeMs, sessionFile: file }
			: null;
	},

	push: {
		canPush(agent) {
			return (
				agent.harness === codex.id &&
				!!agent.sessionId &&
				agent.meta.subagentOutboundOnly !== "1"
			);
		},
		canSteer(agent) {
			return this.canPush(agent) && codexControlAvailable();
		},
		async deliver(agent, text, priority) {
			if (agent.meta.subagentOf)
				return deliverCodexSubagent(
					agent.sessionId,
					text,
					priority === "urgent",
				);
			if (priority === "urgent" && agent.sessionId) {
				const steered = await steerCodexTurn(agent.sessionId, text);
				if (steered) return steered;
			}
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
			const turn = await latestTurn(threadId);
			if (turn?.status !== "inProgress" || !turn.id)
				return { result: "not-running", via };
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
		needsSession: true,
		parse: parseCodex,
		turnFailed: codexTurnFailed,
	},

	// Spawned threads; their transcript is the thread's own (`transcript.locate`).
	subagents: {
		list: listCodexSubagents,
		interruptBySession: true,
		async transcript(parent, sub) {
			// The server can return archived rollout paths outside the recent file search.
			const id = sub.sessionId;
			if (!id || !CODEX_THREAD_ID.test(id)) return null;
			const file =
				(sub.file && isAbsolute(sub.file) ? sub.file : null) ??
				(await codexRolloutAsync(id));
			if (!file || !(await statAsync(file))) {
				if (!(await codexControlReady())) return null;
				return {
					source: {
						kind: "poll",
						intervalMs: 3000,
						fetch: (cursor) =>
							codexThreadHistory(id, cursor, sub.cwd ?? parent.cwd),
					},
					parse: parseCodex,
				};
			}
			const raw = await headAsync(file, 1024 * 1024);
			const header = codexRolloutIdentity(id, raw.split("\n", 1)[0] ?? "");
			if (
				!header?.parentId ||
				header.parentId !== (sub.parentKey ?? parent.sessionId)
			)
				return null;
			return { source: { kind: "file", path: file }, parse: parseCodex };
		},
	},

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
		detect: (path) => !!which("codex", path) || exists(codexHome()),
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
								const toml = join(codexHome(), "config.toml");
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
							undo: cliUndo("codex", ["mcp", "remove", "pulsar"]),
						} satisfies Action,
					]
				: []),
			...skillFor("codex", join(codexHome(), "skills"), ctx),
		],
	},
};
