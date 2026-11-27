import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	opencodeDbPath,
	opencodeTranscript,
} from "../src/harnesses/opencode-transcript.ts";

test("OpenCode history reads only the selected session, pages before a sequence, and follows in-place tool updates", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pulsar-opencode-"));
	const previous = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = dir;
	mkdirSync(join(dir, "opencode"));
	const db = new DatabaseSync(opencodeDbPath());
	try {
		db.exec(
			"CREATE TABLE session_v2(id TEXT PRIMARY KEY); CREATE TABLE session_message(id TEXT,session_id TEXT,seq INTEGER,time_created INTEGER,time_updated INTEGER,type TEXT,data TEXT); INSERT INTO session_v2 VALUES ('child'),('parent')",
		);
		const add = db.prepare(
			"INSERT INTO session_message VALUES (?,?,?,?,?,?,?)",
		);
		for (let i = 0; i < 42; i++)
			add.run(
				`u${i}`,
				"child",
				i,
				i,
				i,
				"user",
				JSON.stringify({ text: `Message ${i}` }),
			);
		add.run("parent", "parent", 0, 0, 0, "user", '{"text":"Parent private"}');
		const tool = (done: boolean) =>
			JSON.stringify({
				model: { id: "local" },
				content: [
					{
						type: "tool",
						name: "bash",
						id: "call",
						state: done
							? {
									status: "completed",
									input: { command: "pwd" },
									content: [{ type: "text", text: "/work" }],
								}
							: { status: "running", input: { command: "pwd" } },
					},
				],
			});
		add.run("a", "child", 42, 50, 50, "assistant", tool(false));
		const locate = (sessionId: string) =>
			opencodeTranscript.locate({
				harness: "opencode",
				sessionId,
				cwd: "/work",
			});
		expect(await locate("missing")).toBeNull();
		const source = await locate("child");
		if (source?.kind !== "poll" || !source.poll)
			throw new Error("Expected live transcript");
		const page = await source.fetch(null);
		expect(page.events).toHaveLength(40);
		expect(page.events.at(-1)).toMatchObject({
			kind: "tool_call",
			model: "local",
			tool: { callId: "call" },
		});
		expect((await source.fetch(page.cursor)).events.map((e) => e.text)).toEqual(
			["Message 0", "Message 1", "Message 2"],
		);
		await source.poll();
		expect(await source.poll()).toBeNull();
		db.prepare(
			"UPDATE session_message SET data=?,time_updated=51 WHERE id='a'",
		).run(tool(true));
		const updated = await source.poll();
		expect(updated?.events.at(-2)).toMatchObject({
			id: page.events.at(-1)!.id,
			tool: { done: true },
		});
		expect(updated?.events.at(-1)).toMatchObject({
			kind: "tool_result",
			text: "/work",
		});
	} finally {
		db.close();
		if (previous === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
