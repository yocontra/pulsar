/** Server-Sent Events on both ends of a federation link. */

const encoder = new TextEncoder();

/**
 * A server-side event stream: `send` frames until the reader goes away,
 * or until `end` closes it from this side.
 * A reader that falls `maxQueued` bytes behind is cut off (it reconnects
 * and resyncs), so a stalled peer can't grow this node's memory. Readers
 * refuse frames over 16 MB (`readSse`), so a healthy one is never cut off
 * by one big snapshot.
 */
export function sseStream(
	start: (
		send: (event: string, data: unknown) => boolean,
		end: () => void,
	) => () => void,
	keepaliveMs = 15_000,
	maxQueued = 64 * 1024 * 1024,
): ReadableStream<Uint8Array> {
	let stop: (() => void) | null = null;
	let timer: NodeJS.Timeout | null = null;
	let closed = false;
	const cleanup = () => {
		if (closed) return;
		closed = true;
		if (timer) clearInterval(timer);
		stop?.();
	};
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				const write = (chunk: string) => {
					if (closed) return false;
					try {
						if ((controller.desiredSize ?? 1) <= 0) {
							cleanup();
							controller.error(new Error("reader fell behind"));
							return false;
						}
						controller.enqueue(encoder.encode(chunk));
						return true;
					} catch {
						cleanup();
						return false;
					}
				};
				const send = (event: string, data: unknown) =>
					write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
				// A comment line first, so the response headers flush at once.
				write(": ok\n\n");
				timer = setInterval(() => write(": keepalive\n\n"), keepaliveMs);
				timer.unref?.();
				const end = () => {
					if (closed) return;
					cleanup();
					try {
						controller.close();
					} catch {}
				};
				try {
					stop = start(send, end);
				} catch (e) {
					cleanup();
					throw e;
				}
			},
			cancel() {
				cleanup();
			},
		},
		new ByteLengthQueuingStrategy({ highWaterMark: maxQueued }),
	);
}

/**
 * Reads an event stream until it ends, errors, or `signal` aborts. Frames
 * larger than `maxFrame` characters end the stream (a misbehaving peer).
 */
export async function readSse(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: string, data: string) => void,
	signal?: AbortSignal,
	maxFrame = 16 * 1024 * 1024,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const abort = () => void reader.cancel().catch(() => {});
	signal?.addEventListener("abort", abort, { once: true });
	let buf = "";
	try {
		for (;;) {
			if (signal?.aborted) return;
			const { done, value } = await reader.read();
			if (done) return;
			buf += decoder.decode(value, { stream: true });
			for (;;) {
				const end = buf.indexOf("\n\n");
				if (end === -1) break;
				const frame = buf.slice(0, end);
				buf = buf.slice(end + 2);
				let event = "message";
				const data: string[] = [];
				for (const line of frame.split("\n")) {
					if (line.startsWith(":")) continue;
					const colon = line.indexOf(":");
					const field = colon === -1 ? line : line.slice(0, colon);
					const value =
						colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
					if (field === "event") event = value;
					else if (field === "data") data.push(value);
				}
				if (data.length) onEvent(event, data.join("\n"));
			}
			if (buf.length > maxFrame) throw new Error("event too large");
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		reader.releaseLock?.();
	}
}
