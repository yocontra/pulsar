import { connect, type Socket } from "node:net";
import { VERSION } from "../version.ts";
import { codexQuestions } from "./codex-interactions.ts";
import {
	codexControlSocket,
	frame,
	handshake,
	takeFrames,
} from "./codex-rpc.ts";
import type { ServerPrompt, ServerReply } from "./types.ts";

/**
 * Answers Codex prompts from the app: one long-lived client on the Codex
 * app-server daemon's control socket (the daemon a Codex TUI runs its
 * threads in). A client that rejoins a running thread (`thread/resume`)
 * gets that thread's server requests too, the pending ones replayed, and
 * the first answer from any client wins; every client then hears
 * `serverRequest/resolved`. So a prompt shows in the TUI and in the app at
 * once, and either can answer it.
 *
 * Rules that keep the TUI's thread safe:
 * - Only threads the daemon already runs (`thread/loaded/list`) are
 *   rejoined: resuming any other thread would load a second live copy of it.
 * - Resume passes nothing but the thread id: no policy or config overrides.
 * - Nothing is ever sent back but the operator's answer to a prompt the app
 *   showed, bound to that prompt's item id. Other server requests are left
 *   to the TUI.
 */

type Id = number | string;

interface Request {
	id: Id;
	method: string;
	threadId: string;
	params: Record<string, unknown>;
	/** Stable across replays: the thread, the method and the item (or callback) id. */
	key: string;
	/** The connection it was last seen on (replayed after a reconnect). */
	gen: number;
	/** Syncs since a reconnect it wasn't replayed in (dropped after a few). */
	misses: number;
}

/** What `reply` needs to send the answer back (ServerPrompt.data). */
interface ReplyData {
	key: string;
	itemId: string;
}

const APPROVAL = "item/commandExecution/requestApproval";
const PATCH = "item/fileChange/requestApproval";
const QUESTION = "item/tool/requestUserInput";
/** Prompts shown read-only (answered in the TUI). */
const SHOWN = new Set([
	"item/permissions/requestApproval",
	"mcpServer/elicitation/request",
]);

/** Syncs a request from an earlier connection survives without a replay. */
const MAX_MISSES = 2;
/** How long a reply waits for `serverRequest/resolved`. */
const RESOLVED_MS = 5000;
/** How long to leave the socket alone after it couldn't be reached. */
const RECONNECT_MS = 10_000;
/** Threads rejoined per sync, at most. */
const RESUMES_PER_SYNC = 8;

/** A Codex server request as a card. Null for requests the app doesn't show. */
export function codexPrompt(
	method: string,
	params: Record<string, unknown>,
): Omit<ServerPrompt, "sessionId" | "key"> | null {
	const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
	if (method === APPROVAL) {
		const command = text(params.command);
		const input = {
			...(command ? { command } : {}),
			...(text(params.cwd) ? { cwd: text(params.cwd) } : {}),
			...(text(params.reason) ? { reason: text(params.reason) } : {}),
		};
		return {
			kind: "permission",
			tool: "exec",
			input,
			prompt: null,
			// Allow once only: what Codex's "for the session" covers isn't
			// known exactly, and the card must list what an answer allows.
			sessionRules: null,
			// Input to a running command, or a command the user typed: the TUI.
			...(params.kind && params.kind !== "command" ? { readOnly: true } : {}),
		};
	}
	if (method === PATCH)
		return {
			kind: "permission",
			tool: "apply_patch",
			input: {
				...(text(params.reason) ? { reason: text(params.reason) } : {}),
				...(text(params.grantRoot)
					? { grantRoot: text(params.grantRoot) }
					: {}),
			},
			prompt: null,
			sessionRules: null,
		};
	if (method === QUESTION) {
		const prompt = codexQuestions(params.questions);
		return prompt
			? {
					kind: "question",
					tool: "request_user_input",
					input: {},
					prompt,
					sessionRules: null,
				}
			: null;
	}
	if (SHOWN.has(method))
		return {
			kind: "permission",
			tool: method.split("/")[1] ?? method,
			input: text(params.reason) ? { reason: text(params.reason) } : {},
			prompt: null,
			sessionRules: null,
			readOnly: true,
		};
	return null;
}

/** The app's answer as the JSON-RPC result Codex expects; null if it has none. */
export function codexResult(method: string, r: ServerReply): unknown | null {
	if (method === APPROVAL || method === PATCH) {
		if (r.decision === "allow-once") return { decision: "accept" };
		if (r.decision === "allow-session") return { decision: "acceptForSession" };
		if (r.decision === "deny") return { decision: "decline" };
		return null;
	}
	if (method === QUESTION) {
		if (r.answer?.kind === "question")
			return {
				answers: Object.fromEntries(
					Object.entries(r.answer.answers).map(([id, a]) => [
						id,
						{ answers: a },
					]),
				),
			};
		// Dismissed in the app: no answers.
		if (r.decision === "deny" || r.answer?.kind === "cancel")
			return { answers: {} };
	}
	return null;
}

export class CodexWatch {
	private sock: Socket | null = null;
	private connecting: Promise<boolean> | null = null;
	private failedAt = 0;
	private gen = 0;
	private nextId = 1;
	private calls = new Map<Id, (msg: Record<string, unknown>) => void>();
	/** Threads rejoined on this connection. */
	private subscribed = new Set<string>();
	private requests = new Map<string, Request>();
	/** Replies waiting for `serverRequest/resolved`, by request key. */
	private resolved = new Map<string, () => void>();
	private readonly socketPath: () => string;
	private readonly timeoutMs: number;
	private readonly now: () => number;

	constructor(
		opts: {
			socket?: () => string;
			timeoutMs?: number;
			now?: () => number;
		} = {},
	) {
		this.socketPath = opts.socket ?? codexControlSocket;
		this.timeoutMs = opts.timeoutMs ?? 5000;
		this.now = opts.now ?? Date.now;
	}

	/** Whether this thread's prompts come from here (answerable), not the rollout. */
	covers(threadId: string): boolean {
		if (this.subscribed.has(threadId)) return true;
		// Reconnecting: its prompts stay up a few syncs, waiting for the replay.
		for (const r of this.requests.values())
			if (r.threadId === threadId) return true;
		return false;
	}

	/**
	 * Rejoins the live threads the daemon runs and leaves those that ended.
	 * False when the daemon can't be reached (every thread falls back to the
	 * rollout).
	 */
	async sync(threadIds: readonly string[]): Promise<boolean> {
		this.age();
		if (!(await this.connect())) return false;
		const want = new Set(threadIds);
		let loaded: Set<string>;
		try {
			loaded = new Set(loadedIds(await this.call("thread/loaded/list", {})));
		} catch {
			return false;
		}
		for (const t of [...this.subscribed])
			if (!want.has(t) || !loaded.has(t)) {
				this.subscribed.delete(t);
				this.dropThread(t);
				if (loaded.has(t))
					await this.call("thread/unsubscribe", { threadId: t }).catch(
						() => {},
					);
			}
		let resumes = 0;
		for (const t of want) {
			if (this.subscribed.has(t) || !loaded.has(t)) continue;
			if (resumes++ >= RESUMES_PER_SYNC) break;
			// Subscribed before the answer: the replayed requests arrive with it.
			this.subscribed.add(t);
			try {
				// Only the id: no overrides of the TUI's policy, sandbox or model.
				await this.call("thread/resume", { threadId: t, excludeTurns: true });
			} catch {
				// Not resumable yet (no rollout before its first turn): next sync.
				this.subscribed.delete(t);
				this.dropThread(t);
			}
		}
		return true;
	}

	/** The thread's pending prompts, as cards. */
	prompts(threadId: string): Omit<ServerPrompt, "sessionId">[] {
		const out: Omit<ServerPrompt, "sessionId">[] = [];
		for (const r of this.requests.values()) {
			if (r.threadId !== threadId) continue;
			const p = codexPrompt(r.method, r.params);
			if (!p) continue;
			const data: ReplyData = { key: r.key, itemId: itemOf(r.params) };
			out.push({ ...p, key: r.key, data });
		}
		return out;
	}

	/**
	 * Sends the app's answer for a prompt still pending on this connection,
	 * on its request id. True once Codex says it was resolved.
	 */
	async reply(p: ServerPrompt, r: ServerReply): Promise<boolean> {
		const data = p.data as ReplyData | undefined;
		const req = data ? this.requests.get(data.key) : undefined;
		// Gone, or not (yet) replayed on this connection: never answer blind.
		if (!req || !data || req.gen !== this.gen || !this.sock) return false;
		if (itemOf(req.params) !== data.itemId) return false;
		const result = codexResult(req.method, r);
		if (result === null) return false;
		const done = new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.resolved.delete(req.key);
				resolve(false);
			}, RESOLVED_MS);
			timer.unref();
			this.resolved.set(req.key, () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
		this.send({ jsonrpc: "2.0", id: req.id, result });
		return done;
	}

	close() {
		this.sock?.destroy();
		this.sock = null;
	}

	/** Requests from an earlier connection: dropped after a few syncs without a replay. */
	private age() {
		for (const [key, r] of this.requests)
			if (r.gen !== this.gen && ++r.misses > MAX_MISSES)
				this.requests.delete(key);
	}

	private dropThread(threadId: string) {
		for (const [key, r] of this.requests)
			if (r.threadId === threadId) this.requests.delete(key);
	}

	private connect(): Promise<boolean> {
		if (this.sock) return Promise.resolve(true);
		if (this.connecting) return this.connecting;
		if (this.now() - this.failedAt < RECONNECT_MS)
			return Promise.resolve(false);
		this.connecting = this.open().then(
			(ok) => {
				this.connecting = null;
				if (!ok) this.failedAt = this.now();
				return ok;
			},
			() => {
				this.connecting = null;
				this.failedAt = this.now();
				return false;
			},
		);
		return this.connecting;
	}

	private open(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const sock = connect(this.socketPath());
			sock.unref();
			let buf: Buffer = Buffer.alloc(0);
			let upgraded = false;
			const timer = setTimeout(() => {
				sock.destroy();
				resolve(false);
			}, this.timeoutMs);
			timer.unref();
			sock.on("error", () => {});
			sock.on("close", () => {
				clearTimeout(timer);
				resolve(false);
				if (this.sock === sock) this.lost();
			});
			sock.on("data", (chunk) => {
				buf = Buffer.concat([buf, chunk]);
				if (!upgraded) {
					const end = buf.indexOf("\r\n\r\n");
					if (end < 0) return;
					if (!/^HTTP\/1\.1 101/.test(buf.subarray(0, end).toString())) {
						sock.destroy();
						return;
					}
					upgraded = true;
					buf = buf.subarray(end + 4);
					this.sock = sock;
					this.gen++;
					void this.call("initialize", {
						clientInfo: { name: "pulsar", version: VERSION },
						// requestUserInput is experimental: ask for it.
						capabilities: { experimentalApi: true },
					}).then(
						() => {
							clearTimeout(timer);
							this.send({ jsonrpc: "2.0", method: "initialized" });
							resolve(true);
						},
						() => sock.destroy(),
					);
				}
				const { texts, rest } = takeFrames(buf);
				buf = rest;
				for (const t of texts) {
					try {
						this.onMessage(JSON.parse(t) as Record<string, unknown>);
					} catch {}
				}
			});
			sock.write(handshake());
		});
	}

	/** The connection closed: requests wait (a few syncs) to be replayed on the next one. */
	private lost() {
		this.sock = null;
		this.subscribed.clear();
		for (const c of this.calls.values())
			c({ error: { message: "codex app-server closed" } });
		this.calls.clear();
	}

	private onMessage(msg: Record<string, unknown>) {
		const method = typeof msg.method === "string" ? msg.method : null;
		if (method && "id" in msg) {
			const params = (msg.params ?? {}) as Record<string, unknown>;
			const threadId =
				typeof params.threadId === "string" ? params.threadId : null;
			if (!threadId || !this.subscribed.has(threadId)) return;
			if (!codexPrompt(method, params)) return;
			const key = `${threadId}:${method}:${itemOf(params)}`;
			this.requests.set(key, {
				id: msg.id as Id,
				method,
				threadId,
				params,
				key,
				gen: this.gen,
				misses: 0,
			});
			return;
		}
		if (method === "serverRequest/resolved") {
			const p = (msg.params ?? {}) as {
				threadId?: unknown;
				requestId?: unknown;
			};
			for (const [key, r] of this.requests)
				if (
					r.threadId === p.threadId &&
					r.id === p.requestId &&
					r.gen === this.gen
				) {
					this.requests.delete(key);
					this.resolved.get(key)?.();
					this.resolved.delete(key);
				}
			return;
		}
		if (!method && "id" in msg) {
			const c = this.calls.get(msg.id as Id);
			this.calls.delete(msg.id as Id);
			c?.(msg);
		}
	}

	private send(o: unknown) {
		this.sock?.write(frame(JSON.stringify(o)));
	}

	private call(method: string, params: unknown): Promise<unknown> {
		if (!this.sock) return Promise.reject(new Error("not connected"));
		const id = `pulsar-${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.calls.delete(id);
				reject(new Error(`${method} timed out`));
			}, this.timeoutMs);
			timer.unref();
			this.calls.set(id, (msg) => {
				clearTimeout(timer);
				const err = msg.error as { message?: string } | undefined;
				if (err) reject(new Error(err.message ?? "error"));
				else resolve(msg.result);
			});
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}
}

/** The prompt's own id: the callback id when one item has several, else the item. */
function itemOf(params: Record<string, unknown>): string {
	const v = params.approvalId ?? params.itemId;
	return typeof v === "string" ? v : "";
}

/** `thread/loaded/list`: `{data: [threadId, …]}`. */
function loadedIds(result: unknown): string[] {
	const data = (result as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return [];
	return data.flatMap((d) =>
		typeof d === "string"
			? [d]
			: typeof (d as { id?: unknown })?.id === "string"
				? [(d as { id: string }).id]
				: [],
	);
}
