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
	let parts: Buffer[] = [];
	let pending = 0;
	const handle = (line: string) => {
		const text = line.trim();
		if (!text) return;
		let frame: unknown;
		try {
			frame = JSON.parse(text);
		} catch {
			// Ignore malformed lines; the peer is local and same-user.
			return;
		}
		if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
		if ("event" in frame) {
			if (typeof frame.event !== "string") return;
		} else {
			if (!("id" in frame) || !Number.isSafeInteger(frame.id)) return;
			if ("method" in frame) {
				if (typeof frame.method !== "string") return;
			} else if ("error" in frame) {
				const error = frame.error;
				if (
					!error ||
					typeof error !== "object" ||
					!("code" in error) ||
					typeof error.code !== "string" ||
					!("message" in error) ||
					typeof error.message !== "string"
				)
					return;
			} else if (!("result" in frame)) return;
		}
		onFrame(frame as Frame);
	};

	socket.on("data", (data: Buffer | string) => {
		const chunk = typeof data === "string" ? Buffer.from(data) : data;
		let start = 0;
		let nl = chunk.indexOf(10);
		while (nl !== -1) {
			if (pending + nl - start > MAX_LINE) {
				parts = [];
				socket.destroy(new Error("frame too large"));
				return;
			}
			const tail = chunk.subarray(start, nl);
			const line = (
				parts.length
					? Buffer.concat([...parts, tail], pending + tail.length)
					: tail
			).toString("utf8");
			parts = [];
			pending = 0;
			handle(line);
			if (socket.destroyed) return;
			start = nl + 1;
			nl = chunk.indexOf(10, start);
		}
		if (start < chunk.length) {
			parts.push(start ? chunk.subarray(start) : chunk);
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
