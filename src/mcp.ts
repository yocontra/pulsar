import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "./client.ts";
import { messageText } from "./format.ts";
import { idleCompactor } from "./gc.ts";
import { gitInfoAsync } from "./git.ts";
import { ACP_IDENTITY_ENV, acpRegistration } from "./harnesses/acp-identity.ts";
import { ANTIGRAVITY_SESSION_ID } from "./harnesses/antigravity-ident.ts";
import { codexToolThreadId } from "./harnesses/codex-ident.ts";
import { IDENTS, identFor } from "./harnesses/ident.ts";
import { detectRegistration } from "./identity.ts";
import { McpStdioServer } from "./mcp-server.ts";
import {
	PULSAR_TOOL_INSTRUCTIONS,
	type PulsarToolSession,
	registerPulsarTools,
	type ToolMeta,
} from "./mcp-tools.ts";
import { stateDir } from "./paths.ts";
import { RpcError } from "./rpc.ts";
import { autoTags, envTags } from "./tags.ts";
import type { DeliveredMessage, PublicAgent, Registration } from "./types.ts";
import { PROTOCOL_VERSION } from "./types.ts";
import { VERSION } from "./version.ts";

/** This MCP process, for sessions with no pid (see `generationOf`). */
const PROCESS_GEN = `${process.pid}.${Date.now().toString(36)}`;

/** These providers multiplex tools, so a missing or foreign ID cannot borrow the ACP root. */
export function assertManagedAcpToolSession(
	registration: Pick<Registration, "harness" | "sessionId">,
	meta: ToolMeta,
) {
	if (
		registration.harness === "antigravity" &&
		meta &&
		Object.hasOwn(meta, "antigravity.google/conversation_id") &&
		meta["antigravity.google/conversation_id"] !== registration.sessionId
	)
		throw new Error("Antigravity identified a different managed conversation.");
	const context = identFor(registration.harness)?.toolSessions;
	if (registration.harness !== "codex" && !context) return;
	const nativeSession =
		registration.harness === "codex"
			? codexToolThreadId(meta)
			: context?.sessionId(meta);
	if (!nativeSession || nativeSession !== registration.sessionId)
		throw new Error(
			"The MCP host did not verify that this call belongs to the managed session.",
		);
}

/** Debug lines, appended in order without blocking (PULSAR_DEBUG only). */
let debugTail: Promise<void> = Promise.resolve();
function debug(line: string) {
	if (!process.env.PULSAR_DEBUG) return;
	const text = `${new Date().toISOString()} [${process.pid}] ${line}\n`;
	debugTail = debugTail.then(() =>
		appendFile(join(stateDir(), "mcp-debug.log"), text).catch(() => {}),
	);
}

/**
 * One agent's connection to the daemon. Usually an MCP server serves one
 * agent; OpenCode's shared server serves many, one Session per OpenCode session.
 */
export class Session {
	readonly client = new DaemonClient();
	me: PublicAgent | null = null;
	private lastUsed = Date.now();
	/** Calls still running (a long `wait` or `ask` keeps the session in use). */
	private inflight = 0;
	private connecting: Promise<void> | null = null;
	private closed = false;

	readonly registration: Registration;

	constructor(
		registration: Registration,
		onMessage: (m: DeliveredMessage) => void,
	) {
		// This server has the ack/done/nack tools: unacked asks may be redelivered.
		registration.capabilities ??= ["acks"];
		// Without a pid (OpenCode), this process's nonce tells a reconnect from a restart.
		if (!registration.pid)
			registration.meta = { ...registration.meta, gen: PROCESS_GEN };
		this.registration = registration;
		this.client.on("message", (d) => onMessage(d as DeliveredMessage));
		// Reconnect when the daemon restarts (upgrade, crash), keeping the identity.
		this.client.onClose(() => {
			this.me = null;
			// The daemon refused this session and closed: no automatic retry (the
			// next tool call tries again once the backoff allows).
			if (this.closed || this.refused) return;
			let delay = 250;
			const retry = () => {
				this.ensure().catch((e) => {
					// The daemon answered with an error (protocol too new, session
					// claimed, ...): retrying will not help. The next tool call tries
					// again and reports it.
					if (e instanceof RpcError) {
						debug(`reconnect stopped: ${e.code}: ${e.message}`);
						return;
					}
					debug(`reconnect failed: ${(e as Error).message}`);
					delay = Math.min(delay * 2, 10_000);
					setTimeout(retry, delay).unref();
				});
			};
			setTimeout(retry, delay).unref();
		});
	}

	/** Session ids another connection already serves (two Codex threads in one app-server). */
	private readonly claimed = new Set<string>();

	private async hello(): Promise<void> {
		try {
			const r = await this.client.call<{ agent: PublicAgent }>("hello", {
				protocol: PROTOCOL_VERSION,
				version: VERSION,
				registration: this.registration,
			});
			this.me = r.agent;
			const reg = this.registration;
			if (reg.meta?.acp !== "1")
				void identFor(reg.harness)
					?.onSessionReady?.(reg)
					.catch((err) =>
						debug(`native delivery setup failed: ${(err as Error).message}`),
					);
		} catch (e) {
			const reg = this.registration;
			const late =
				reg.meta?.acp === "1" || reg.meta?.nativeToolContext === "1"
					? null
					: identFor(reg.harness)?.lateSession;
			if (
				(e as { code?: string }).code !== "session_claimed" ||
				!late ||
				!reg.sessionId
			)
				throw e;
			// Another session of this process has that id: take the next candidate,
			// on a fresh connection (the daemon closes one whose hello it refused).
			this.claimed.add(reg.sessionId);
			await late.adopt(reg, await late.find(reg, this.claimed));
			await this.client.connect(true);
			return this.hello();
		}
	}

	/** The daemon's last refusal (session claimed, protocol too new), and until when to hold off. */
	private refused: { error: Error; until: number; delay: number } | null = null;

	ensure(): Promise<void> {
		if (this.closed)
			return Promise.reject(new RpcError("closed", "this session was closed"));
		if (this.client.connected && this.me) return Promise.resolve();
		const r = this.refused;
		if (r && Date.now() < r.until) return Promise.reject(r.error);
		this.connecting ??= (async () => {
			try {
				if (!this.client.connected) await this.client.connect(true);
				await this.hello();
				this.refused = null;
			} catch (e) {
				if (e instanceof RpcError) {
					// Back off: 1 s, 2 s, ... up to a minute between tries.
					const delay = Math.min((r?.delay ?? 500) * 2, 60_000);
					this.refused = { error: e, until: Date.now() + delay, delay };
				}
				throw e;
			} finally {
				this.connecting = null;
			}
		})();
		return this.connecting;
	}

	/**
	 * Some harnesses name the session after starting MCP servers (Codex creates
	 * its thread later). Once the id appears, say hello again: the daemon moves
	 * this agent to it, which the harness's push path can reach.
	 */
	async refresh() {
		const reg = this.registration;
		if (reg.meta?.acp === "1" || reg.meta?.nativeToolContext === "1") return;
		const ident = identFor(reg.harness);
		// The process moved to another session (Claude's /resume, /clear).
		if (reg.sessionId && reg.role === "mcp" && ident?.currentSession) {
			const now = await ident.currentSession(reg);
			if (now && now !== reg.sessionId) {
				debug(`session switched: ${reg.sessionId} -> ${now}`);
				reg.sessionId = now;
				// The harness's name and inbox are the new session's.
				const found = await ident.identify?.({
					pid: reg.pid,
					cwd: reg.cwd ?? process.cwd(),
					sessionId: now,
					env: process.env,
				});
				const {
					claudeName: _n,
					harnessName: _h,
					harnessNameSource: _s,
					...meta
				} = reg.meta ?? {};
				reg.meta = { ...meta, ...found?.meta };
				await this.hello();
			}
			return;
		}
		const late = ident?.lateSession;
		if (!late || reg.sessionId) return;
		const found = await late.find(reg, this.claimed);
		if (!found) return;
		await late.adopt(reg, found);
		await this.hello();
	}

	async call<T>(
		method: string,
		params?: unknown,
		timeoutMs?: number,
	): Promise<T> {
		this.inflight++;
		try {
			await this.ensure();
			await this.refresh();
			return await this.client.call<T>(method, params, timeoutMs);
		} finally {
			this.inflight--;
			this.lastUsed = Date.now();
		}
	}

	/** No call running and none for `idleMs`. */
	idle(now: number, idleMs: number): boolean {
		return this.inflight === 0 && now - this.lastUsed > idleMs;
	}

	close() {
		this.closed = true;
		this.client.close();
	}
}

/**
 * Turns off V8's optimizing tiers for this process. The MCP server is idle
 * and I/O bound, so optimized code buys nothing, but its code and feedback
 * stay resident: over a long session that is a few MB per agent. Node only
 * (Bun has no V8 flags); never in the extension, whose process is the host's.
 */
function leanJit() {
	if (process.versions.bun) return;
	try {
		const v8 = process.getBuiltinModule("node:v8") as typeof import("node:v8");
		v8.setFlagsFromString("--no-opt --no-maglev --no-sparkplug");
	} catch {}
}

/** Quiet time after the last tool call or message before compacting the heap. */
const IDLE_GC_MS = 30_000;

/** Runs the stdio MCP server for one agent session (or one per OpenCode session). */
export async function runMcp() {
	leanJit();
	const active = idleCompactor(IDLE_GC_MS);
	const managed = !!process.env[ACP_IDENTITY_ENV];
	const base = managed ? null : await detectRegistration("mcp");
	if (base?.harness === "antigravity") base.nativeHostToken = randomUUID();
	const server = new McpStdioServer(
		{ name: "pulsar", version: VERSION },
		PULSAR_TOOL_INSTRUCTIONS,
	);
	server.cliArgs = identFor(base?.harness ?? "unknown")?.cliArgs === true;

	const onMessage = (m: DeliveredMessage) => {
		active();
		server.sendResourceUpdated("pulsar://inbox");
		// Antigravity shares one transport between a parent and its children.
		if (base?.harness === "antigravity") return;
		server.sendLog(
			"notice",
			"pulsar",
			`Message from ${m.from.name}: ${m.body.slice(0, 200)}`,
		);
	};

	let baseSession = base ? new Session(base, onMessage) : null;
	const perSession = new Map<string, Session>();
	// OpenCode keeps one MCP process for all its sessions (`toolSessions`). A session that has not
	// called pulsar for a while lets go of its connection, so finished sessions
	// leave the list (the scanner still shows ones that are running).
	const SESSION_IDLE_MS = 20 * 60_000;
	setInterval(() => {
		for (const [id, s] of perSession) {
			if (s.idle(Date.now(), SESSION_IDLE_MS)) {
				s.close();
				perSession.delete(id);
			}
		}
	}, 60_000).unref();

	/** Sessions being created, so concurrent first calls share one. */
	const creating = new Map<string, Promise<Session>>();

	async function claudeChild(
		proof: unknown,
		tool: string | undefined,
	): Promise<PulsarToolSession> {
		if (
			base?.harness !== "claude" ||
			typeof proof !== "string" ||
			!/^[0-9a-f]{32,64}$/.test(proof) ||
			!tool
		)
			throw new Error("Invalid Claude child tool proof.");
		const client = new DaemonClient();
		try {
			await client.connect(true);
			const registration = { ...base, role: "cli", capabilities: [] };
			await client.call("hello", {
				protocol: PROTOCOL_VERSION,
				version: VERSION,
				registration,
			});
			const { agent } = await client.call<{ agent: PublicAgent }>(
				"claude.subagent.bind",
				{ proof, tool },
			);
			if (!agent?.id.includes("/sub:"))
				throw new Error("Pulsar could not bind the Claude child.");
			return {
				me: agent,
				call(method, params, timeoutMs) {
					if (!client.connected)
						throw new RpcError(
							"closed",
							"Claude child tool connection closed.",
						);
					return client.call(method, params, timeoutMs);
				},
				closeTool: () => client.close(),
			};
		} catch (e) {
			client.close();
			throw e;
		}
	}

	/** The session a tool call belongs to. Some harnesses (OpenCode) name it in `_meta`. */
	async function sessionFor(
		meta: ToolMeta,
		args?: unknown,
		tool?: string,
	): Promise<PulsarToolSession> {
		if (args && typeof args === "object" && Object.hasOwn(args, "sourceProof"))
			return claudeChild((args as { sourceProof?: unknown }).sourceProof, tool);
		if (!base) {
			const registration = await acpRegistration("mcp");
			if (!registration)
				throw new Error("The managed ACP session is unavailable");
			assertManagedAcpToolSession(registration, meta);
			baseSession ??= new Session(registration, onMessage);
			return baseSession;
		}
		const agy =
			base.harness === "antigravity" &&
			meta &&
			Object.hasOwn(meta, "antigravity.google/conversation_id");
		if (
			agy ||
			(base.harness === "codex" && meta && Object.hasOwn(meta, "threadId"))
		) {
			const id = agy
				? meta["antigravity.google/conversation_id"]
				: codexToolThreadId(meta);
			const root = agy ? meta["antigravity.google/root_conversation_id"] : null;
			if (
				typeof id !== "string" ||
				!id ||
				(agy &&
					(!ANTIGRAVITY_SESSION_ID.test(id) ||
						typeof root !== "string" ||
						!ANTIGRAVITY_SESSION_ID.test(root)))
			)
				throw new Error(
					agy
						? "Antigravity did not identify the invoking conversation."
						: "Codex did not supply a valid invoking thread ID.",
				);
			if (agy) {
				await baseSession?.ensure();
				if (baseSession && !baseSession.registration.sessionId) {
					await baseSession.refresh();
				}
				if (baseSession?.registration.sessionId !== root)
					throw new Error("Antigravity did not verify the root conversation.");
				if (id === root) return baseSession!;
			}
			const key = `${base.harness}:${id}`;
			const existing = perSession.get(key);
			if (existing) return existing;
			if (!agy && baseSession?.me && baseSession.registration.sessionId === id)
				return baseSession;
			const session = new Session(
				{
					...base,
					sessionId: id,
					meta: {
						...base.meta,
						nativeToolContext: "1",
						...(typeof root === "string" ? { nativeRootSessionId: root } : {}),
					},
				},
				onMessage,
			);
			perSession.set(key, session);
			return session;
		}
		for (const driver of IDENTS) {
			const tool = driver.toolSessions;
			if (!tool || (base.harness !== driver.id && base.harness !== "unknown"))
				continue;
			const sessionId = tool.sessionId(meta);
			if (!sessionId) continue;
			const key = `${driver.id}:${sessionId}`;
			const known = perSession.get(key);
			if (known) return known;
			let pending = creating.get(key);
			if (!pending) {
				pending = (async () => {
					const nativeCwd = await tool.cwd(sessionId);
					if (!nativeCwd && base.harness === "unknown")
						throw new Error(
							"The invoking OpenCode session could not be verified.",
						);
					const cwd = nativeCwd ?? base.cwd;
					const git = await gitInfoAsync(cwd, { lane: "user" });
					const s = new Session(
						{
							harness: driver.id,
							sessionId,
							pid: null,
							cwd,
							project: git.project,
							branch: git.branch,
							tags: [...autoTags(driver.id, git), ...envTags()],
							role: "mcp",
						},
						onMessage,
					);
					perSession.set(key, s);
					return s;
				})().finally(() => creating.delete(key));
				creating.set(key, pending);
			}
			return pending;
		}
		if (base.harness === "antigravity" && tool)
			throw new Error(
				"Antigravity did not supply the tool call's conversation ID.",
			);
		if (identFor(base.harness)?.toolSessions)
			throw new Error(
				"OpenCode did not identify the calling session. Call Pulsar from a session using a host that supplies its session ID.",
			);
		return baseSession!;
	}

	registerPulsarTools((tool) => server.tool(tool), sessionFor, active);

	server.resource({
		uri: "pulsar://inbox",
		name: "inbox",
		title: "Pulsar inbox",
		description: "Messages waiting for this agent",
		mimeType: "text/plain",
		read: async (meta) => {
			const r = await (await sessionFor(meta, undefined, "inbox")).call<{
				messages: DeliveredMessage[];
			}>("inbox", { markRead: false });
			return r.messages.length
				? r.messages.map(messageText).join("\n")
				: "No unread messages.";
		},
	});

	// A shared server (OpenCode) is not an agent itself; its sessions register on first use.
	if (
		base &&
		base.harness !== "codex" &&
		!identFor(base.harness)?.toolSessions
	) {
		await baseSession?.ensure().catch((e) => {
			process.stderr.write(
				`pulsar: could not reach the daemon yet (${(e as Error).message}); retrying on first use\n`,
			);
		});
	}

	// The harness owns this process: when it closes stdin, exit (the daemon keeps running).
	const exit = () => {
		baseSession?.close();
		for (const s of perSession.values()) s.close();
		process.exit(0);
	};
	process.stdin.on("end", exit);
	process.stdin.on("close", exit);
	server.listen();
	// Startup leaves garbage too (identity, the handshake).
	active();
}
