/**
 * Daemon state that used to grow with uptime stays bounded: each test drives
 * churn through one structure and checks it returns to a floor.
 */
import { describe, expect, setSystemTime, test } from "bun:test";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sseStream } from "../src/federation/sse.ts";
import { PoolState } from "../src/federation/state.ts";
import { pi } from "../src/harnesses/pi.ts";
import { MAX_BACKLOG, readFrames, writeFrame } from "../src/rpc.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { callEvent, MAX_PENDING_CALLS } from "../src/transcripts/summary.ts";
import {
	MAX_LIVE_LINE,
	MAX_READ,
	TranscriptTailer,
} from "../src/transcripts/tailer.ts";
import {
	newParseState,
	type TranscriptEvent,
} from "../src/transcripts/types.ts";
import type { Agent } from "../src/types.ts";
import { until } from "./helpers.ts";

function peerOf(state: PoolState) {
	return state.upsert(
		{
			nodeId: "n",
			name: "b",
			dnsName: "b.x.ts.net",
			userId: "u",
			login: "me",
			tags: [],
			online: true,
		},
		{
			fedProtocol: [1, 1],
			features: [],
			pulsarVersion: "x",
			machineId: "mb",
			name: "b",
		},
		1,
	);
}

const routes = (state: PoolState) =>
	(state as unknown as { approvalAgent: Map<string, string> }).approvalAgent
		.size;

describe("remote prompt routes", () => {
	const prompt = (requestId: string) => ({
		requestId,
		tool: "Bash",
		input: { command: "ls" },
		inputHash: "h",
		state: "pending",
		createdAt: 1,
		expiresAt: 2,
	});
	const rec = (id: string, approvals: unknown[]) => ({
		id,
		name: id,
		harness: "pi",
		tags: [],
		status: "busy",
		approvals,
	});

	test("are dropped with the prompt, the agent and the peer", () => {
		const state = new PoolState();
		state.onApproval = () => {};
		const peer = peerOf(state);
		let seq = 1;
		state.snapshot(peer, "boot", seq, []);
		// A thousand prompts come and go on one agent.
		for (let i = 0; i < 1000; i++)
			state.delta(peer, "boot", ++seq, [rec("x1", [prompt(`q${i}`)])], []);
		expect(routes(state)).toBe(1);
		expect(state.approvalRecord("mb/q999")).not.toBeNull();
		// The agent leaves.
		state.delta(peer, "boot", ++seq, [], ["x1"]);
		expect(routes(state)).toBe(0);
		// A snapshot without the agent forgets its prompts too.
		state.delta(peer, "boot", ++seq, [rec("x2", [prompt("a")])], []);
		state.snapshot(peer, "boot", ++seq, []);
		expect(routes(state)).toBe(0);
		// So does removing the peer.
		state.delta(peer, "boot", ++seq, [rec("x3", [prompt("b")])], []);
		expect(routes(state)).toBe(1);
		state.remove("mb");
		expect(routes(state)).toBe(0);
	});
});

describe("writeFrame", () => {
	test("closes a socket whose peer stopped reading", () => {
		let destroyed = false;
		let writes = 0;
		const socket = {
			destroyed: false,
			writable: true,
			writableLength: 0,
			write() {
				writes++;
				return true;
			},
			destroy() {
				destroyed = true;
			},
		} as unknown as Socket & { writableLength: number };
		writeFrame(socket, { event: "x", data: 1 });
		expect(writes).toBe(1);
		(socket as { writableLength: number }).writableLength = MAX_BACKLOG + 1;
		writeFrame(socket, { event: "x", data: 1 });
		expect(writes).toBe(1);
		expect(destroyed).toBe(true);
	});
});

describe("sseStream", () => {
	test("cuts off a reader that falls too far behind", async () => {
		let send: ((event: string, data: unknown) => boolean) | null = null;
		let stopped = false;
		const stream = sseStream(
			(s) => {
				send = s;
				return () => {
					stopped = true;
				};
			},
			60_000,
			64 * 1024,
		);
		const body = "x".repeat(1024);
		let sent = 0;
		// Nobody reads: the queue fills, then the stream gives up.
		while (send!("e", body) && sent < 10_000) sent++;
		expect(sent).toBeLessThan(100);
		expect(stopped).toBe(true);
		await expect(stream.getReader().read()).rejects.toThrow(/fell behind/);
	});

	test("a reader that keeps up is never cut off", async () => {
		let send: ((event: string, data: unknown) => boolean) | null = null;
		const stream = sseStream(
			(s) => {
				send = s;
				return () => {};
			},
			60_000,
			64 * 1024,
		);
		const reader = stream.getReader();
		for (let i = 0; i < 500; i++) {
			expect(send!("e", "x".repeat(1024))).toBe(true);
			await reader.read();
		}
	});
});

describe("send-rate log", () => {
	test("forgets senders with nothing recent", () => {
		const store = new Store(":memory:");
		const service = new PulsarService({ store, scan: false, machine: "m" });
		const mailbox = service.mailbox as unknown as {
			sendLog: Map<string, number[]>;
			recordSend(sender: Agent, broadcast: boolean): void;
		};
		try {
			const t0 = Date.now();
			setSystemTime(new Date(t0));
			// 1500 one-off senders (each with its own pid), all within a minute.
			for (let i = 0; i < 1500; i++)
				mailbox.recordSend({ id: `a${i}`, pid: 10_000 + i } as Agent, false);
			expect(mailbox.sendLog.size).toBeGreaterThan(1500);
			// Two minutes on, one more send sweeps everyone who went quiet.
			setSystemTime(new Date(t0 + 120_000));
			mailbox.recordSend({ id: "late", pid: 1 } as Agent, false);
			expect(mailbox.sendLog.size).toBe(3);
		} finally {
			setSystemTime();
			service.stop();
			store.close();
		}
	});
});

describe("fullGc", () => {
	const script = `
		const { fullGc } = await import(${JSON.stringify(`${import.meta.dir}/../src/gc.ts`)});
		let junk = Array.from({ length: 200_000 }, (_, i) => ({ i, s: "x" + i }));
		const before = process.memoryUsage().heapUsed;
		junk = null;
		fullGc(true);
		fullGc();
		const after = process.memoryUsage().heapUsed;
		process.stdout.write(String(before - after));
	`;
	for (const runtime of ["node", "bun"])
		test(`collects under ${runtime}`, () => {
			const r = Bun.spawnSync([
				runtime === "bun" ? process.execPath : "node",
				"--input-type=module",
				"-e",
				script,
			]);
			expect(r.exitCode).toBe(0);
			// 200k small objects are several MB; most of it must be gone.
			expect(Number(r.stdout.toString())).toBeGreaterThan(4 * 1024 * 1024);
		});
});

describe("transcripts", () => {
	test("a parse state forgets the oldest unanswered tool calls", () => {
		const state = newParseState();
		const base = { id: "e", ts: 0 } as unknown as Parameters<
			typeof callEvent
		>[1];
		for (let i = 0; i < MAX_PENDING_CALLS * 4; i++)
			callEvent(state, base, "write", `c${i}`, { content: "x".repeat(1000) });
		expect(state.calls.size).toBe(MAX_PENDING_CALLS);
		expect(state.calls.has(`c${MAX_PENDING_CALLS * 4 - 1}`)).toBe(true);
		expect(state.calls.has("c0")).toBe(false);
	});

	const line = (id: string, text: string) =>
		`${JSON.stringify({
			type: "message",
			id,
			timestamp: "2026-11-10T12:00:00.000Z",
			message: { role: "user", content: text },
		})}\n`;

	test("a file found late is caught up in bounded reads; only a giant line is skipped", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pulsar-mem-tail-"));
		const file = join(dir, "pi.jsonl");
		const tailer = new TranscriptTailer({
			resolve: () => ({
				source: { kind: "file", path: file },
				parse: pi.transcript!.parse,
				cwd: dir,
			}),
			pollMs: 20,
		});
		try {
			writeFileSync(file, "");
			const events: TranscriptEvent[] = [];
			tailer.subscribe("p", (batch) => events.push(...batch));
			await tailer.ready("p");
			// 2.5 chunks of lines (few enough not to overflow the subscriber's
			// queue), a line longer than a chunk (an inline image: read), one
			// longer than any line may be (skipped), then one more.
			const body = "z".repeat(40_000);
			const count = Math.ceil((MAX_READ * 2.5) / 40_100);
			let text = "";
			for (let i = 0; i < count; i++) text += line(`a${i}`, body);
			text += line("long", "l".repeat(MAX_READ + 10));
			text += line("huge", "h".repeat(MAX_LIVE_LINE + 10));
			text += line("after", "ok");
			appendFileSync(file, text);
			void tailer.poke();
			await until(() => events.some((e) => e.id === "after"), 10_000);
			const ids = events
				.filter((e) => !e.id.startsWith("gap:"))
				.map((e) => e.id);
			expect(ids).toHaveLength(count + 2);
			expect(ids[count - 1]).toBe(`a${count - 1}`);
			expect(ids[count]).toBe("long");
			expect(ids.includes("huge")).toBe(false);
			expect(events.some((e) => e.id.startsWith("gap:"))).toBe(true);
		} finally {
			tailer.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("readFrames", () => {
	function fakeSocket() {
		const s = new EventEmitter() as EventEmitter & {
			destroyed: boolean;
			setEncoding(): void;
			destroy(): void;
		};
		s.destroyed = false;
		s.setEncoding = () => {};
		s.destroy = () => {
			s.destroyed = true;
		};
		return s;
	}

	test("joins frames split over many chunks, and splits several per chunk", () => {
		const socket = fakeSocket();
		const got: unknown[] = [];
		readFrames(socket as unknown as Socket, (f) => got.push(f));
		const big = JSON.stringify({ event: "x", data: "y".repeat(300_000) });
		const text = `${big}\n{"event":"a","data":1}\n\n{"event":"b","data":2}\nnot json\n{"event":"c"`;
		for (let i = 0; i < text.length; i += 65_536)
			socket.emit("data", text.slice(i, i + 65_536));
		expect(got.length).toBe(3);
		expect((got[0] as { data: string }).data.length).toBe(300_000);
		socket.emit("data", ',"data":3}\n');
		expect(got.at(-1)).toEqual({ event: "c", data: 3 });
		expect(socket.destroyed).toBe(false);
	});

	test("closes the socket on a line over the limit", () => {
		const socket = fakeSocket();
		readFrames(socket as unknown as Socket, () => {});
		for (let i = 0; i < 40 && !socket.destroyed; i++)
			socket.emit("data", "z".repeat(65_536));
		expect(socket.destroyed).toBe(true);
	});
});
