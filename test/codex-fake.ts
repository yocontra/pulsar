import { createServer, type Server, type Socket } from "node:net";

/**
 * A fake Codex app-server control socket: WebSocket text frames carrying
 * JSON-RPC, with the parts of the thread API the app relies on. Server
 * requests go to every client that resumed the thread (pending ones are
 * replayed on resume); the first response wins and every subscriber hears
 * `serverRequest/resolved`.
 */

type Msg = Record<string, unknown>;

interface Pending {
	id: number;
	method: string;
	params: Msg & { threadId: string };
}

class Conn {
	buf: Buffer = Buffer.alloc(0);
	upgraded = false;
	threads = new Set<string>();
	init: Msg | null = null;
	readonly sock: Socket;
	constructor(sock: Socket) {
		this.sock = sock;
	}
	send(o: unknown) {
		const data = Buffer.from(JSON.stringify(o));
		const n = data.length;
		const head =
			n < 126
				? Buffer.from([0x81, n])
				: n < 65536
					? Buffer.from([0x81, 126, n >> 8, n & 0xff])
					: (() => {
							const b = Buffer.alloc(10);
							b[0] = 0x81;
							b[1] = 127;
							b.writeBigUInt64BE(BigInt(n), 2);
							return b;
						})();
		this.sock.write(Buffer.concat([head, data]));
	}
}

export class FakeCodex {
	readonly handlers = new Map<string, (params: Msg) => unknown>();
	readonly calls: { method: string; params: Msg }[] = [];
	/** Responses to server requests: [request id, result, which client]. */
	readonly answers: { id: unknown; result: unknown }[] = [];
	loaded = new Set<string>();
	/** Threads `thread/resume` refuses (no rollout yet). */
	unresumable = new Set<string>();
	private pending: Pending[] = [];
	private conns = new Set<Conn>();
	private nextId = 0;
	private server: Server;
	readonly path: string;

	constructor(path: string) {
		this.path = path;
		this.server = createServer((s) => this.accept(s));
	}

	listen(): Promise<void> {
		return new Promise((r) => this.server.listen(this.path, () => r()));
	}

	close(): Promise<void> {
		for (const c of this.conns) c.sock.destroy();
		return new Promise((r) => this.server.close(() => r()));
	}

	/** Drops every client (an app-server restart that keeps its threads). */
	dropClients() {
		for (const c of this.conns) c.sock.destroy();
		this.conns.clear();
	}

	get clients() {
		return this.conns.size;
	}

	/** The thread asks a question of its clients; returns the request id. */
	request(method: string, params: Msg & { threadId: string }): number {
		const p: Pending = { id: this.nextId++, method, params };
		this.pending.push(p);
		for (const c of this.conns)
			if (c.threads.has(params.threadId))
				c.send({ jsonrpc: "2.0", id: p.id, method, params });
		return p.id;
	}

	/** The TUI (another client) answers first. */
	answerElsewhere(id: number) {
		this.resolve(id, { decision: "accept" }, false);
	}

	isPending(id: number) {
		return this.pending.some((p) => p.id === id);
	}

	inits(): Msg[] {
		return [...this.conns].flatMap((c) => (c.init ? [c.init] : []));
	}

	private resolve(id: unknown, result: unknown, record = true) {
		const i = this.pending.findIndex((p) => p.id === id);
		if (i < 0) return;
		const [p] = this.pending.splice(i, 1);
		if (record) this.answers.push({ id, result });
		for (const c of this.conns)
			if (c.threads.has(p!.params.threadId))
				c.send({
					jsonrpc: "2.0",
					method: "serverRequest/resolved",
					params: { threadId: p!.params.threadId, requestId: id },
				});
	}

	private accept(sock: Socket) {
		const c = new Conn(sock);
		this.conns.add(c);
		sock.on("error", () => {});
		sock.on("close", () => this.conns.delete(c));
		sock.on("data", (chunk) => {
			c.buf = Buffer.concat([c.buf, chunk]);
			if (!c.upgraded) {
				const end = c.buf.indexOf("\r\n\r\n");
				if (end < 0) return;
				c.upgraded = true;
				c.buf = c.buf.subarray(end + 4);
				sock.write(
					"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
				);
			}
			for (;;) {
				const b = c.buf;
				if (b.length < 2) return;
				let n = b[1]! & 0x7f;
				let off = 2;
				if (n === 126) {
					if (b.length < 4) return;
					n = b.readUInt16BE(2);
					off = 4;
				} else if (n === 127) {
					if (b.length < 10) return;
					n = Number(b.readBigUInt64BE(2));
					off = 10;
				}
				if (b.length < off + 4 + n) return;
				const mask = b.subarray(off, off + 4);
				const body = Buffer.alloc(n);
				for (let i = 0; i < n; i++) body[i] = b[off + 4 + i]! ^ mask[i % 4]!;
				c.buf = b.subarray(off + 4 + n);
				this.onMessage(c, JSON.parse(body.toString()) as Msg);
			}
		});
	}

	private onMessage(c: Conn, msg: Msg) {
		const method = msg.method as string | undefined;
		if (!method) {
			// A client's response to a server request.
			if ("result" in msg) this.resolve(msg.id, msg.result);
			return;
		}
		const params = (msg.params ?? {}) as Msg;
		this.calls.push({ method, params });
		if (!("id" in msg)) return;
		const ok = (result: unknown) =>
			c.send({ jsonrpc: "2.0", id: msg.id, result });
		const fail = (message: string) =>
			c.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message } });
		const handler = this.handlers.get(method);
		if (handler) {
			try {
				return ok(handler(params));
			} catch (error) {
				return fail(String(error));
			}
		}
		switch (method) {
			case "initialize":
				c.init = params;
				return ok({ userAgent: "fake" });
			case "thread/loaded/list":
				return ok({ data: [...this.loaded], nextCursor: null });
			case "thread/resume": {
				const t = String(params.threadId);
				if (!this.loaded.has(t) || this.unresumable.has(t))
					return fail(`no rollout found for thread id ${t}`);
				c.threads.add(t);
				ok({ thread: { id: t } });
				for (const p of this.pending)
					if (p.params.threadId === t)
						c.send({
							jsonrpc: "2.0",
							id: p.id,
							method: p.method,
							params: p.params,
						});
				return;
			}
			case "thread/unsubscribe":
				c.threads.delete(String(params.threadId));
				return ok({});
			default:
				return fail(`unknown method ${method}`);
		}
	}
}
