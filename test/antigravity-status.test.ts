import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravitySession } from "../src/harnesses/antigravity-ident.ts";
import { antigravitySummaries } from "../src/harnesses/antigravity-status.ts";

test("the active Antigravity conversation owns the process presence lock while child databases are open", async () => {
	const dir = "/home/test/.gemini/antigravity-cli";
	const parent = "11111111-1111-4111-8111-111111111111";
	const child = "22222222-2222-4222-8222-222222222222";
	const fds = `fcwd\nn/work\nf5\nn${dir}/presence/${parent}.lock\nf6\nn${dir}/conversations/${child}.db`;
	expect(
		(await antigravitySession(fds, join(dir, "conversations"))).sessionId,
	).toBe(parent);
	expect(
		(
			await antigravitySession(
				`${fds}\nf9\nn${dir}/presence/${child}.lock`,
				join(dir, "conversations"),
			)
		).sessionId,
	).toBeNull();
});

test("Antigravity reads native run status for discovered sessions", () => {
	const dir = mkdtempSync(join(tmpdir(), "pulsar-agy-status-"));
	const path = join(dir, "conversation_summaries.db");
	const { DatabaseSync } = createRequire(import.meta.url)(
		"node:sqlite",
	) as typeof import("node:sqlite");
	try {
		expect(antigravitySummaries(path, ["idle"]).size).toBe(0);
		const db = new DatabaseSync(path);
		try {
			db.exec(
				"CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, status TEXT)",
			);
			const put = db.prepare(
				"INSERT INTO conversation_summaries VALUES (?, ?)",
			);
			for (const status of [
				"idle",
				"busy",
				"running",
				"canceling",
				"unspecified",
				"other",
			])
				put.run(status, `CASCADE_RUN_STATUS_${status.toUpperCase()}`);
			expect(
				Object.fromEntries(
					antigravitySummaries(path, [
						"idle",
						"busy",
						"running",
						"canceling",
						"unspecified",
						"missing",
					]),
				),
			).toEqual({
				idle: { status: "idle" },
				busy: { status: "busy" },
				running: { status: "busy" },
				canceling: { status: "busy" },
				unspecified: { status: "unknown" },
			});
			db.exec(
				"ALTER TABLE conversation_summaries ADD COLUMN title TEXT; ALTER TABLE conversation_summaries ADD COLUMN not_fully_idle INTEGER",
			);
			db.exec(
				"UPDATE conversation_summaries SET title = 'Audit findings', not_fully_idle = 1 WHERE conversation_id = 'idle'",
			);
			expect(antigravitySummaries(path, ["idle"]).get("idle")).toEqual({
				status: "busy",
				title: "Audit findings",
			});
		} finally {
			db.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
