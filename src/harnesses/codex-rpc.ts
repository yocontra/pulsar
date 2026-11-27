import { access } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { lazyCrypto } from "../lazy.ts";

/**
 * A minimal client for the Codex app-server daemon: JSON-RPC 2.0 in
 * WebSocket text frames over its unix control socket (the transport
 * `codex queue` uses). Enough for one short request/response exchange.
 */

export function codexHome(): string {
	return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function codexControlSocket(): string {
	return join(codexHome(), "app-server-control", "app-server-control.sock");
}

/** Whether the app-server's control socket exists (checked without blocking). */
export async function codexControlReady(): Promise<boolean> {
	const path = codexControlSocket();
	const ok = await access(path).then(
		() => true,
		() => false,
	);
	known.set(path, { at: Date.now(), ok });
	return ok;
}

const known = new Map<string, { at: number; ok: boolean }>();

/**
 * The last answer of `codexControlReady`, for `canInterrupt` (it runs for
 * every row shown): a missing or stale one is refreshed in the background,
 * and the row offers Stop once the socket is seen.
 */
export function codexControlAvailable(): boolean {
	const hit = known.get(codexControlSocket());
	if (!hit || Date.now() - hit.at > 5000) {
		known.set(codexControlSocket(), { at: Date.now(), ok: hit?.ok ?? false });
		void codexControlReady();
	}
	return hit?.ok ?? false;
}

export class CodexRpcError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

/** One text frame, masked (clients must mask). */
export function frame(text: string): Buffer {
	const data = Buffer.from(text);
	const n = data.length;
	const head =
		n < 126
			? Buffer.from([0x81, 0x80 | n])
			: n < 65536
				? Buffer.from([0x81, 0x80 | 126, n >> 8, n & 0xff])
				: Buffer.concat([
						Buffer.from([0x81, 0x80 | 127]),
						(() => {
							const b = Buffer.alloc(8);
							b.writeBigUInt64BE(BigInt(n));
							return b;
						})(),
					]);
	const mask = lazyCrypto().randomBytes(4);
	const body = Buffer.alloc(n);
	for (let i = 0; i < n; i++) body[i] = data[i]! ^ mask[i % 4]!;
	return Buffer.concat([head, mask, body]);
}

/** The upgrade request for the control socket. */
export function handshake(): string {
	return (
		"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		`Sec-WebSocket-Key: ${lazyCrypto().randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`
	);
}

/** The complete text frames at the start of `buf` (server frames are unmasked), and the rest. */
export function takeFrames(buf: Buffer): { texts: string[]; rest: Buffer } {
	const texts: string[] = [];
	for (;;) {
		if (buf.length < 2) break;
		const op = buf[0]! & 0x0f;
		let n = buf[1]! & 0x7f;
		let off = 2;
		if (n === 126) {
			if (buf.length < 4) break;
			n = buf.readUInt16BE(2);
			off = 4;
		} else if (n === 127) {
			if (buf.length < 10) break;
			n = Number(buf.readBigUInt64BE(2));
			off = 10;
		}
		if (buf.length < off + n) break;
		if (op === 1) texts.push(buf.subarray(off, off + n).toString());
		buf = buf.subarray(off + n);
	}
	return { texts, rest: buf };
}

/**
 * Opens a session, runs `calls` in order (each after the previous answer)
 * and closes. Resolves with each call's result; rejects on the first error.
 */
export async function codexRpc(
	calls: Array<[method: string, params: unknown]>,
	opts: { socket?: string; timeoutMs?: number; experimental?: boolean } = {},
): Promise<unknown[]> {
	const path = opts.socket ?? codexControlSocket();
	const sock: Socket = connect(path);
	const timeout = opts.timeoutMs ?? 5000;
	let buf: Buffer = Buffer.alloc(0);
	let upgraded = false;
	let waiting: ((msg: Record<string, unknown>) => void) | null = null;
	let fail: (e: Error) => void = () => {};
	const failed = new Promise<never>((_, reject) => {
		fail = reject;
	});
	failed.catch(() => {});
	const timer = setTimeout(() => {
		fail(new Error("codex app-server timed out"));
		sock.destroy();
	}, timeout);
	sock.on("error", (e) => fail(e));
	sock.on("close", () => fail(new Error("codex app-server closed")));
	const opened = new Promise<void>((resolve) => {
		sock.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			if (!upgraded) {
				const end = buf.indexOf("\r\n\r\n");
				if (end < 0) return;
				const head = buf.subarray(0, end).toString();
				if (!/^HTTP\/1\.1 101/.test(head)) {
					fail(new Error(`codex app-server refused: ${head.split("\r\n")[0]}`));
					return;
				}
				upgraded = true;
				buf = buf.subarray(end + 4);
				resolve();
			}
			const { texts, rest } = takeFrames(buf);
			buf = rest;
			for (const payload of texts)
				try {
					const msg = JSON.parse(payload) as Record<string, unknown>;
					if ("id" in msg && !("method" in msg)) waiting?.(msg);
				} catch {}
		});
	});
	const send = (o: unknown) => sock.write(frame(JSON.stringify(o)));
	const ask = (id: number, method: string, params: unknown) =>
		Promise.race([
			failed,
			new Promise<unknown>((resolve, reject) => {
				waiting = (msg) => {
					if (msg.id !== id) return;
					const err = msg.error as
						| { code?: number; message?: string }
						| undefined;
					if (err)
						reject(new CodexRpcError(err.code ?? 0, err.message ?? "error"));
					else resolve(msg.result);
				};
				send({ jsonrpc: "2.0", id, method, params });
			}),
		]);
	try {
		sock.write(handshake());
		await Promise.race([failed, opened]);
		await ask(0, "initialize", {
			clientInfo: { name: "pulsar", version: "1" },
			// Experimental methods (thread/settings/update) need the opt-in.
			...(opts.experimental && { capabilities: { experimentalApi: true } }),
		});
		send({ jsonrpc: "2.0", method: "initialized" });
		const out: unknown[] = [];
		for (const [i, [method, params]] of calls.entries())
			out.push(await ask(i + 1, method, params));
		return out;
	} finally {
		clearTimeout(timer);
		sock.destroy();
	}
}
