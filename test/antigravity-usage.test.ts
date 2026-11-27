import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { antigravityModel } from "../src/harnesses/antigravity-usage.ts";
import { Store } from "../src/store.ts";
import type { Agent } from "../src/types.ts";
import { Usage } from "../src/usage/index.ts";
import { rootsIn } from "./usage-fixtures.ts";

function varint(n: number): number[] {
	return n < 128 ? [n] : [(n & 127) | 128, ...varint(Math.floor(n / 128))];
}
function num(id: number, n: number) {
	return [...varint(id * 8), ...varint(n)];
}
function field(id: number, v: string | number[]) {
	const bytes = typeof v === "string" ? [...Buffer.from(v)] : v;
	return [...varint(id * 8 + 2), ...varint(bytes.length), ...bytes];
}

test("native Antigravity prices each generation's model, including WAL appends, without rebilling replayed responses", async () => {
	const root = mkdtempSync(join(tmpdir(), "pulsar-native-usage-"));
	const session = "11111111-1111-4111-8111-111111111111";
	const db = new DatabaseSync(join(root, `${session}.db`));
	const store = new Store(join(root, "pulsar.db"));
	try {
		db.exec(
			"PRAGMA journal_mode=WAL; CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY,metadata BLOB); CREATE TABLE trajectory_meta(cascade_id TEXT)",
		);
		db.prepare("INSERT INTO trajectory_meta VALUES(?)").run(session);
		const now = Date.now();
		function add(idx: number, model: string, id: string, input = 1000000) {
			const usage = [
				...num(2, input),
				...num(3, 10),
				...num(5, 30),
				...num(9, 4),
				...num(10, 6),
				...field(7, id),
			];
			const meta = [
				...field(4, usage),
				...field(9, field(10, [...num(1, 1200), ...num(4, 512000)])),
				...field(19, model),
			];
			const gen = [
				...field(2, varint(130 + idx)),
				...field(3, "p".repeat(10000)),
				...field(1, meta),
			];
			db.prepare("INSERT OR REPLACE INTO gen_metadata VALUES(?,?)").run(
				idx,
				Uint8Array.from(gen),
			);
			db.prepare("INSERT OR REPLACE INTO steps VALUES(?,?)").run(
				130 + idx,
				Uint8Array.from(field(1, num(1, Math.floor(now / 1000)))),
			);
		}
		const usage = new Usage(store, {
			roots: () => ({ ...rootsIn(root), antigravity: root }),
		});
		const agent = {
			harness: "antigravity",
			sessionId: session,
			meta: {},
		} as Agent;
		add(0, "gemini-4-hydrogen-tiered-high", "one");
		await usage.scanner.scan(now);
		expect((await usage.localAgent(agent)).model).toBe("gemini-4-hydrogen");
		add(1, "gemini-4-neon", "two");
		add(2, "gemini-4-neon", "two");
		await usage.scanner.scan(now);
		await usage.scanner.scan(now);
		const report = await usage.localAgent(agent);
		expect(report.tokens).toMatchObject({
			input: 2000000,
			cacheRead: 60,
			output: 20,
			records: 2,
		});
		expect(report.models.map((m) => m.model).sort()).toEqual([
			"gemini-4-hydrogen",
			"gemini-4-neon",
		]);
		expect(report.context).toEqual({ used: 1200, window: 512000 });
		expect(antigravityModel(session, root)).toBe("gemini-4-neon");
		expect(usage.priceAgent(session, report).cost).toBeCloseTo(4.50023175, 7);
		// Older cursors must rebuild already counted rows without charging twice.
		store.db.exec(
			"UPDATE usage_files SET offset=17; UPDATE usage_hourly SET input=input+123",
		);
		await usage.scanner.scan(now);
		expect((await usage.localAgent(agent)).tokens.input).toBe(2000000);
		// Earlier usage can change while an incomplete invocation remains at the end.
		add(0, "gemini-4-hydrogen-tiered-high", "one", 300);
		db.prepare("INSERT INTO gen_metadata VALUES(3,?)").run(new Uint8Array());
		await usage.scanner.scan(now);
		const corrected = await usage.localAgent(agent);
		expect(corrected.tokens.input).toBe(1000300);
		expect(corrected.model).toBe("gemini-4-neon");
		const other = "22222222-2222-4222-8222-222222222222";
		const clonePath = join(root, `${other}.db`);
		db.prepare("VACUUM INTO ?").run(clonePath);
		const clone = new DatabaseSync(clonePath);
		try {
			clone.prepare("UPDATE trajectory_meta SET cascade_id=?").run(other);
		} finally {
			clone.close();
		}
		await usage.scanner.scan(now);
		const otherAgent = { ...agent, sessionId: other };
		expect((await usage.localAgent(otherAgent)).tokens.records).toBe(0);
		db.exec("DELETE FROM gen_metadata WHERE idx=0");
		await usage.scanner.scan(now);
		expect((await usage.localAgent(agent)).tokens.records).toBe(1);
		expect((await usage.localAgent(otherAgent)).tokens).toMatchObject({
			records: 1,
			input: 300,
		});
		db.exec("DELETE FROM trajectory_meta");
		expect(antigravityModel(session, root)).toBeNull();
	} finally {
		db.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
