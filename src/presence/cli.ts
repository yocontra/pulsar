import type { DaemonClient } from "../client.ts";

/** Longer than the daemon's own wait for the person (src/service/presence.ts). */
const CALL_TIMEOUT_MS = 4 * 60_000;

/**
 * Calls a sensitive op that the daemon confirms with the person first, and
 * says where to confirm while it waits. Works without a terminal: an agent
 * can run the command, and the human confirms with Touch ID or in the app.
 * On a machine with neither (a headless server over SSH), the daemon writes
 * a word to this terminal instead, and this reads it back.
 */
export async function callConfirmed<T>(
	client: DaemonClient,
	method: string,
	params: Record<string, unknown>,
	out: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): Promise<T> {
	let stopTyping: (() => void) | null = null;
	client.on("presence", (data) => {
		const d = data as { action?: string; methods?: string[]; ticket?: string };
		const where = (d.methods ?? []).join(" or ");
		out(
			`pulsar: waiting for you to confirm "${d.action ?? method}"${where ? ` (${where})` : ""}…`,
		);
		if (d.ticket) stopTyping = typeWord(d.ticket, out);
	});
	try {
		// The pid only says which terminal a last-resort word goes to.
		return await client.call<T>(
			method,
			{ ...params, pid: process.pid },
			CALL_TIMEOUT_MS,
		);
	} finally {
		(stopTyping as (() => void) | null)?.();
	}
}

/**
 * Reads the word the daemon wrote to this terminal and sends it on a second
 * connection (the first is waiting on the op). Returns a stop function.
 */
function typeWord(ticket: string, out: (line: string) => void): () => void {
	if (!process.stdin.isTTY) {
		out("pulsar: run this in your own terminal to type the word.");
		return () => {};
	}
	const ac = new AbortController();
	void readWord(ticket, out, ac.signal);
	return () => ac.abort();
}

async function readWord(
	ticket: string,
	out: (line: string) => void,
	signal: AbortSignal,
) {
	const { createInterface } = await import("node:readline/promises");
	const { DaemonClient } = await import("../client.ts");
	const { PROTOCOL_VERSION } = await import("../types.ts");
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	const second = new DaemonClient();
	signal.addEventListener("abort", () => {
		rl.close();
		second.close();
	});
	try {
		await second.connect(false);
		await second.call("hello", {
			protocol: PROTOCOL_VERSION,
			registration: { role: "cli" },
		});
		for (let i = 0; i < 3; i++) {
			const word = await rl.question("Word: ", { signal });
			const r = await second.call<{ ok: boolean }>("presence.word", {
				ticket,
				word,
			});
			if (r.ok) return;
			out("That's not the word.");
		}
	} catch (e) {
		if (!signal.aborted) out(`pulsar: ${(e as Error).message}`);
	} finally {
		rl.close();
		second.close();
	}
}
