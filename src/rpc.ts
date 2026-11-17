import type { Socket } from "node:net";

/** Newline-delimited JSON frames over a stream socket. */
export type Frame =
	| { id: number; method: string; params?: unknown }
	| { id: number; result: unknown }
	| { id: number; error: { code: string; message: string } }
	| { event: string; data: unknown };

const MAX_LINE = 2 * 1024 * 1024;

export function writeFrame(socket: Socket, frame: Frame) {
	if (socket.destroyed || !socket.writable) return;
	socket.write(`${JSON.stringify(frame)}\n`);
}

/** Calls `onFrame` for each complete JSON line. Oversized lines close the socket. */
export function readFrames(socket: Socket, onFrame: (f: Frame) => void) {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		if (buffer.length > MAX_LINE && !buffer.includes("\n")) {
			socket.destroy(new Error("frame too large"));
			return;
		}
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (line) {
				try {
					onFrame(JSON.parse(line) as Frame);
				} catch {
					// Ignore malformed lines; the peer is local and same-user.
				}
			}
			nl = buffer.indexOf("\n");
		}
	});
}

export class RpcError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "RpcError";
	}
}
