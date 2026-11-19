import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
	appendFileSync,
	mkdtempSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONFIRM_MS,
	codexRolloutStatus,
	codexStatuses,
	codexStatusStats,
	QUIET_MS,
	STALE_MS,
} from "../src/harnesses/codex-status.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { longestLoopBlock } from "./loop-probe.ts";

/** Lines shaped like Codex 0.170's rollouts (keys in its order; content made up). */
const T0 = Date.parse("2026-11-18T16:00:00.000Z");
let ordinal = 0;
const ev = (at: number, type: string, extra: object = {}) =>
	`${JSON.stringify({
		timestamp: new Date(at).toISOString(),
		ordinal: ordinal++,
		type: "event_msg",
		payload: { type, turn_id: "t1", root_turn_id: "t1", ...extra },
	})}\n`;
const filler = (at: number, text = "x".repeat(200)) =>
	`${JSON.stringify({
		timestamp: new Date(at).toISOString(),
		ordinal: ordinal++,
		type: "response_item",
		payload: { type: "custom_tool_call_output", call_id: "c", output: text },
	})}\n`;

const dirs: string[] = [];
function rollout(text: string) {
	const dir = mkdtempSync(join(tmpdir(), "pulsar-codex-status-"));
	dirs.push(dir);
	const file = join(dir, "rollout-2026-11-18T16-00-00-thr.jsonl");
	writeFileSync(file, text);
	return file;
}
afterEach(() => {
	setSystemTime();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** "Now" just after the file was written (it was not quiet). */
const fresh = () => Date.now() + 1000;

describe("Codex status from the rollout's turn events", () => {
	test("a started turn is busy since it started; completed is idle since it ended", async () => {
		const file = rollout(
			ev(T0 - 60_000, "task_started") +
				filler(T0 - 50_000) +
				ev(T0 - 40_000, "task_complete", { last_agent_message: "done" }) +
				ev(T0, "task_started") +
				filler(T0 + 1000),
		);
		expect(await codexRolloutStatus(file, null, fresh())).toEqual({
			status: "busy",
			since: T0,
		});
		appendFileSync(file, ev(T0 + 5000, "task_complete"));
		expect(await codexRolloutStatus(file, null, fresh())).toEqual({
			status: "idle",
			since: T0 + 5000,
		});
	});

	test("an aborted turn is idle", async () => {
		const file = rollout(
			ev(T0, "task_started") +
				ev(T0 + 2, "turn_aborted", { reason: "interrupted" }),
		);
		expect(await codexRolloutStatus(file, null, fresh())).toEqual({
			status: "idle",
			since: T0 + 2,
		});
	});

	test("a rollout with no turn event has no status", async () => {
		const file = rollout(filler(T0));
		expect(await codexRolloutStatus(file, null, fresh())).toBeNull();
	});

	test("a turn event quoted inside a tool output does not count", async () => {
		// A tool that printed a rollout line: escaped inside the JSON string.
		const file = rollout(
			ev(T0, "task_complete") + filler(T0 + 1, ev(T0 + 1, "task_started")),
		);
		expect((await codexRolloutStatus(file, null, fresh()))?.status).toBe(
			"idle",
		);
	});

	test("a crash mid-turn: quiet past the stale limit is idle; the app-server is asked first", async () => {
		const file = rollout(ev(T0, "task_started") + filler(T0 + 1000));
		const mtime = Date.now();
		// Quiet, but not stale: still busy, and no app-server to ask.
		expect(
			(await codexRolloutStatus(file, null, mtime + QUIET_MS + 1000))?.status,
		).toBe("busy");
		// Stale with no app-server: the turn died.
		const stale = await codexRolloutStatus(file, null, mtime + STALE_MS + 1000);
		expect(stale?.status).toBe("idle");
		expect(stale!.since).toBeGreaterThanOrEqual(T0);

		// The app-server says the turn still runs (a long tool call): busy,
		// asked at most once per CONFIRM_MS.
		let asked = 0;
		const runs = async () => {
			asked++;
			return true;
		};
		const t = mtime + STALE_MS + 2000;
		expect(await codexRolloutStatus(file, runs, t)).toEqual({
			status: "busy",
			since: T0,
		});
		await codexRolloutStatus(file, runs, t + 1000);
		expect(asked).toBe(1);
		await codexRolloutStatus(file, runs, t + CONFIRM_MS);
		expect(asked).toBe(2);
		// It says the turn ended: idle, without waiting for the stale limit.
		const ended = await codexRolloutStatus(
			file,
			async () => false,
			t + 2 * CONFIRM_MS,
		);
		expect(ended?.status).toBe("idle");
	});

	test("a huge rollout: searched once from the end, then only new bytes; the loop stays free", async () => {
		// The turn started 50 MB ago and is still writing.
		const chunk = Array.from({ length: 2000 }, (_, i) => filler(T0 + i)).join(
			"",
		);
		const file = rollout(ev(T0, "task_started"));
		for (let n = 0; n < 50 * 1024 * 1024; n += chunk.length)
			appendFileSync(file, chunk);
		const block = await longestLoopBlock(async () => {
			expect(await codexRolloutStatus(file, null, fresh())).toEqual({
				status: "busy",
				since: T0,
			});
			const read = codexStatusStats.bytes;
			for (let i = 0; i < 20; i++)
				await codexRolloutStatus(file, null, fresh());
			// Unchanged: nothing read.
			expect(codexStatusStats.bytes).toBe(read);
			// It grows by one line: about that much is read, and the turn ends.
			const end = ev(T0 + 9000, "task_complete");
			appendFileSync(file, end);
			expect(await codexRolloutStatus(file, null, fresh())).toEqual({
				status: "idle",
				since: T0 + 9000,
			});
			expect(codexStatusStats.bytes - read).toBeLessThan(end.length + 1024);
		});
		// No stretch of JS between two timer ticks takes 50 ms of CPU (wall
		// time would also count the OS starving a loaded machine).
		expect(block.cpuMs).toBeLessThan(25);
	});

	test("a turn event split across the search's 1 MB chunks is found", async () => {
		const start = ev(T0, "task_started");
		const pattern = '"type":"event_msg","payload":{"type":"task_started"';
		const mid = start.indexOf(pattern) + Math.floor(pattern.length / 2);
		// The first chunk read (the last 1 MB) begins in the middle of the pattern.
		const after = 1024 * 1024 - (start.length - mid);
		const file = rollout(filler(T0 - 1) + start + "z".repeat(after));
		expect(await codexRolloutStatus(file, null, fresh())).toEqual({
			status: "busy",
			since: T0,
		});
	});

	test("a rollout rewritten shorter is searched again", async () => {
		const file = rollout(ev(T0, "task_started") + filler(T0 + 1));
		expect((await codexRolloutStatus(file, null, fresh()))?.status).toBe(
			"busy",
		);
		truncateSync(file, 0);
		appendFileSync(file, ev(T0 + 5, "task_complete"));
		expect((await codexRolloutStatus(file, null, fresh()))?.status).toBe(
			"idle",
		);
	});
});

describe("Codex status in the registry", () => {
	test("a registered Codex agent shows busy since its turn began, then idle since it ended", async () => {
		const store = new Store(":memory:");
		const svc = new PulsarService({ store, scan: false, machine: "t" });
		try {
			setSystemTime(new Date(T0 - 4 * 3600_000));
			const a = svc.registry.upsert({
				harness: "codex",
				sessionId: "thr",
				pid: 1,
				cwd: null,
				project: null,
				branch: null,
				tags: [],
				meta: {},
				registered: true,
			});
			expect(a.status).toBe("unknown");
			setSystemTime();
			const file = rollout(ev(T0, "task_started"));
			const apply = async () => {
				for (const r of await codexStatuses([a], async () => file, null))
					svc.registry.applyLiveStatus(r.agent, r.status, r.since);
			};
			await apply();
			let row = svc.app.views.row(a);
			expect(row.state).toBe("busy");
			expect(row.stateSince).toBe(T0);
			appendFileSync(file, ev(T0 + 60_000, "task_complete"));
			await apply();
			row = svc.app.views.row(a);
			expect(row.state).toBe("idle");
			expect(row.stateSince).toBe(T0 + 60_000);
		} finally {
			svc.stop();
			store.close();
		}
	});
});
