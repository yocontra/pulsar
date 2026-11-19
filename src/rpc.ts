import type { Socket } from "node:net";

/** Newline-delimited JSON frames over a stream socket. */
export type Frame =
	| { id: number; method: string; params?: unknown }
	| { id: number; result: unknown }
	| { id: number; error: { code: string; message: string } }
	| { event: string; data: unknown };

const MAX_LINE = 2 * 1024 * 1024;

/**
 * Unsent bytes a peer may leave queued before its socket is closed: a
 * client that stops reading (a stuck `tail`) can't grow the writer's memory.
 */
export const MAX_BACKLOG = 16 * 1024 * 1024;

export function writeFrame(socket: Socket, frame: Frame) {
	if (socket.destroyed || !socket.writable) return;
	if (socket.writableLength > MAX_BACKLOG) {
		socket.destroy(new Error("peer is not reading"));
		return;
	}
	socket.write(`${JSON.stringify(frame)}\n`);
}

/**
 * Calls `onFrame` for each complete JSON line. Oversized lines close the
 * socket. Only each new chunk is searched for newlines: a large frame in
 * many chunks is joined once, not rescanned (and copied) per chunk.
 */
export function readFrames(socket: Socket, onFrame: (f: Frame) => void) {
	let parts: string[] = [];
	let pending = 0;
	const handle = (line: string) => {
		const text = line.trim();
		if (!text) return;
		let frame: Frame;
		try {
			frame = JSON.parse(text) as Frame;
		} catch {
			// Ignore malformed lines; the peer is local and same-user.
			return;
		}
		onFrame(frame);
	};
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		let start = 0;
		let nl = chunk.indexOf("\n");
		while (nl !== -1) {
			const tail = chunk.slice(start, nl);
			const line = parts.length ? parts.join("") + tail : tail;
			parts = [];
			pending = 0;
			handle(line);
			if (socket.destroyed) return;
			start = nl + 1;
			nl = chunk.indexOf("\n", start);
		}
		if (start < chunk.length) {
			parts.push(start ? chunk.slice(start) : chunk);
			pending += chunk.length - start;
			if (pending > MAX_LINE) {
				parts = [];
				socket.destroy(new Error("frame too large"));
			}
		}
	});
}

export class RpcError extends Error {
	readonly code: string;
	/** Extra detail for transports that can carry it (HTTP); never sent on the socket. */
	readonly data: unknown;
	constructor(code: string, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
		this.name = "RpcError";
	}
}
