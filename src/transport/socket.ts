import { access, chmod, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import {
	antigravityMcpHost,
	antigravityProcess,
	legacyMcpGeneration,
} from "../harnesses/antigravity-ident.ts";
import { freshProcessSnapshot } from "../processes.ts";
import { type Frame, RpcError, readFrames, writeFrame } from "../rpc.ts";
import type { Caller } from "../service/caller.ts";
import type { PulsarService } from "../service/index.ts";
import { PROTOCOL_VERSION, type Registration } from "../types.ts";
import { VERSION } from "../version.ts";

/** Open connections in all; past it, new ones are refused with `too_many_connections`. */
export const MAX_CONNECTIONS = 1024;

/**
 * The local Unix-socket RPC (newline-delimited JSON): the MCP server, the
 * extension and the CLI. Each connection is one Caller. It starts as the
 * operator (a plain terminal CLI) and becomes an agent when it says hello
 * with that agent's registration.
 */
export class SocketTransport {
	private server: Server | null = null;
	private sockets = new Set<Socket>();
	private readonly service: PulsarService;
	readonly path: string;

	constructor(service: PulsarService, path: string) {
		this.service = service;
		this.path = path;
	}

	/** Binds the socket. Resolves false when another live daemon already owns it. */
	async listen(): Promise<boolean> {
		const exists = await access(this.path).then(
			() => true,
			() => false,
		);
		if (exists) {
			const alive = await new Promise<boolean>((resolve) => {
				const probe = connect(this.path);
				probe.once("connect", () => {
					probe.destroy();
					resolve(true);
				});
				probe.once("error", () => resolve(false));
			});
			if (alive) return false;
			await unlink(this.path).catch(() => {});
		}
		this.server = createServer((socket) => this.accept(socket));
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.path, () => resolve());
		});
		try {
			await chmod(this.path, 0o600);
		} catch (e) {
			// Only this user may talk to the daemon; never serve a socket others can open.
			const server = this.server;
			this.server = null;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await unlink(this.path).catch(() => {});
			throw new Error(
				`could not restrict ${this.path} to this user: ${(e as Error).message}`,
			);
		}
		return true;
	}

	/** Drops every connection, stops listening and removes the socket file. */
	async close() {
		for (const s of this.sockets) s.destroy();
		await new Promise<void>((resolve) =>
			this.server ? this.server.close(() => resolve()) : resolve(),
		);
		await unlink(this.path).catch(() => {});
	}

	/**
	 * Lets go without touching the path, which another daemon owns now:
	 * drops every connection and stops keeping the process alive, but does
	 * not close the server (closing a Unix-socket server unlinks its path).
	 * The process is expected to exit.
	 */
	abandon() {
		for (const s of this.sockets) s.destroy();
		this.server?.unref();
		this.server = null;
	}

	get connections() {
		return this.sockets.size;
	}

	private accept(socket: Socket) {
		if (this.sockets.size >= MAX_CONNECTIONS) return this.refuse(socket);
		const closed = new AbortController();
		const caller: Caller = {
			principal: { kind: "terminal" },
			closed: closed.signal,
			emit: (event, data) => writeFrame(socket, { event, data }),
			close: (reason) => {
				writeFrame(socket, { event: "closed", data: { reason } });
				socket.destroy();
			},
		};
		this.sockets.add(socket);
		this.service.attach(caller);
		readFrames(socket, (frame) => void this.onFrame(socket, caller, frame));
		socket.on("error", () => {});
		socket.on("close", () => {
			this.sockets.delete(socket);
			closed.abort();
		});
	}

	/**
	 * Too many connections: answers the first request with a clear error and
	 * closes, so the client fails fast instead of waiting on a dead socket.
	 */
	private refuse(socket: Socket) {
		socket.on("error", () => {});
		const timer = setTimeout(() => socket.destroy(), 2000);
		timer.unref();
		readFrames(socket, (frame) => {
			if (!("method" in frame)) return;
			writeFrame(socket, {
				id: frame.id,
				error: {
					code: "too_many_connections",
					message: `the pulsar daemon has ${MAX_CONNECTIONS} open connections; a client is leaking them (see \`pulsar doctor\`)`,
				},
			});
			socket.end();
		});
		socket.on("close", () => clearTimeout(timer));
	}

	private async onFrame(socket: Socket, caller: Caller, frame: Frame) {
		if (!("method" in frame)) return;
		this.service.touch();
		try {
			const params = (frame.params ?? {}) as Record<string, unknown>;
			const result =
				frame.method === "hello"
					? await this.hello(caller, params)
					: await this.service.handle(caller, frame.method, params);
			writeFrame(socket, { id: frame.id, result });
		} catch (e) {
			const err =
				e instanceof RpcError
					? e
					: new RpcError("internal", (e as Error).message);
			writeFrame(socket, {
				id: frame.id,
				error: { code: err.code, message: err.message },
			});
			// A refused hello leaves the connection with nothing to do; close it so
			// a client that retries on a new connection can't pile up descriptors.
			if (frame.method === "hello") socket.end();
		}
	}

	/**
	 * Decides who this connection is. No registration, or a CLI with no agent
	 * around it: the operator. A CLI run from an agent's shell: that agent,
	 * borrowed. An MCP server or extension: its agent, registered.
	 */
	private async hello(caller: Caller, p: Record<string, unknown>) {
		this.service.authorize(caller.principal, "hello");
		const protocol = Number(p.protocol ?? 0);
		if (protocol > PROTOCOL_VERSION) {
			throw new RpcError(
				"protocol_too_new",
				`client speaks protocol ${protocol}, daemon ${PROTOCOL_VERSION}`,
			);
		}
		let reg = p.registration as Registration | undefined;
		if (
			reg?.role === "mcp" &&
			reg.harness === "unknown" &&
			!reg.pid &&
			reg.cwd &&
			legacyMcpGeneration(reg.meta?.gen)
		) {
			const table = await freshProcessSnapshot();
			const pid =
				table && (await antigravityMcpHost(reg.meta?.gen, reg.cwd, table));
			if (pid) {
				const detected = await antigravityProcess(pid);
				if (detected.cwd === reg.cwd) {
					reg = {
						...reg,
						harness: "antigravity",
						pid,
						sessionId: detected.sessionId,
						tags: [
							...(reg.tags ?? []).filter((tag) => !tag.startsWith("harness:")),
							"harness:antigravity",
						],
					};
				}
			}
		} else if (
			reg?.role === "mcp" &&
			reg.harness === "antigravity" &&
			reg.meta?.acp !== "1" &&
			reg.pid &&
			!reg.sessionId
		) {
			// An already-running MCP client may reconnect with only its host PID.
			const detected = await antigravityProcess(reg.pid);
			if (detected.sessionId && detected.cwd === reg.cwd)
				reg = { ...reg, sessionId: detected.sessionId };
		}
		if (caller.closed.aborted)
			throw new RpcError("closed", "Connection closed during identification");
		this.service.setRole(caller, reg?.role ?? "cli");
		// One live MCP connection owns a session id; a second claimant (two Codex
		// threads in one app-server) is told to pick another thread.
		if (reg) this.service.checkClaim(caller, reg);
		const none = {
			version: VERSION,
			protocol: PROTOCOL_VERSION,
			agent: null,
			ompChildMessaging: true,
		};
		if (!reg) return none;
		if (reg.subagent !== undefined) {
			const agent = await this.service.registerOmpChild(caller, reg);
			return { ...none, agent: this.service.publicAgent(agent) };
		}
		const child = await this.service.bindNativeChild(caller, reg);
		if (child) return { ...none, agent: this.service.publicAgent(child) };
		if (reg.role === "cli") {
			// `pulsar send` run by an agent's shell speaks as that agent, never as the operator.
			if (
				reg.harness === "cli" ||
				reg.harness === "unknown" ||
				(!reg.sessionId && !reg.pid)
			)
				return none;
			const agent = this.service.borrowAgent(caller, reg);
			return {
				version: VERSION,
				protocol: PROTOCOL_VERSION,
				agent: this.service.publicAgent(agent),
			};
		}
		const agent = this.service.registerAgent(caller, reg);
		return {
			version: VERSION,
			protocol: PROTOCOL_VERSION,
			agent: this.service.publicAgent(agent),
		};
	}
}
