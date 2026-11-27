import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	antigravitySource,
	readAntigravitySession,
} from "../src/harnesses/antigravity.ts";
import { antigravityChildSupport } from "../src/harnesses/antigravity-children.ts";
import { agentRecord } from "./subagent-fixtures.ts";

test("native Antigravity lists only explicit descendants, including nested children", async () => {
	const { DatabaseSync } = createRequire(import.meta.url)(
		"node:sqlite",
	) as typeof import("node:sqlite");
	const base = mkdtempSync(join(tmpdir(), "pulsar-agy-children-"));
	const conversations = join(base, "conversations");
	mkdirSync(conversations);
	const root = "11111111-1111-4111-8111-111111111111";
	const child = "22222222-2222-4222-8222-222222222222";
	const grandchild = "33333333-3333-4333-8333-333333333333";
	const unrelated = "44444444-4444-4444-8444-444444444444";
	const summary = new DatabaseSync(join(base, "conversation_summaries.db"));
	try {
		summary.exec(`CREATE TABLE conversation_summaries (
			conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT,
			title TEXT, agent_name TEXT, last_modified_time TEXT, status TEXT,
			not_fully_idle INTEGER, killed INTEGER
		)`);
		const insert = summary.prepare(
			"INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?)",
		);
		const now = new Date().toISOString();
		insert.run(root, "", "Parent", "", now, "CASCADE_RUN_STATUS_IDLE", 0, 0);
		insert.run(
			child,
			root,
			"Review results",
			"Reviewer",
			now,
			"CASCADE_RUN_STATUS_IDLE",
			1,
			0,
		);
		insert.run(
			grandchild,
			child,
			"Parse changes",
			"",
			now,
			"CASCADE_RUN_STATUS_IDLE",
			0,
			1,
		);
		insert.run(
			unrelated,
			"",
			"Workspace task",
			"",
			now,
			"CASCADE_RUN_STATUS_RUNNING",
			0,
			0,
		);
		insert.run(
			"../escape",
			root,
			"Invalid",
			"",
			now,
			"CASCADE_RUN_STATUS_RUNNING",
			0,
			0,
		);
		const childPath = join(conversations, `${child}.db`);
		const trajectory = new DatabaseSync(childPath);
		trajectory.exec("CREATE TABLE trajectory_meta(cascade_id TEXT)");
		trajectory.prepare("INSERT INTO trajectory_meta VALUES (?)").run(child);
		trajectory.close();
		symlinkSync(childPath, join(conversations, `${grandchild}.db`));

		const agent = agentRecord({ harness: "antigravity", sessionId: root });
		const support = antigravityChildSupport(
			() => conversations,
			async (id, file) =>
				(await readAntigravitySession(id, dirname(file)))
					? { source: antigravitySource(file, id), parse: () => [] }
					: null,
		);
		expect(await support.stamp!(agent)).toBeString();
		const children = await support.list(agent);
		expect(children).toMatchObject([
			{
				key: child,
				name: "Review results",
				agentType: "Reviewer",
				state: "running",
				parentKey: null,
				fileAvailable: true,
			},
			{
				key: grandchild,
				name: "Parse changes",
				state: "done",
				parentKey: child,
				fileAvailable: false,
			},
		]);
		expect(await support.transcript!(agent, children[0]!)).toMatchObject({
			source: { kind: "poll" },
		});
		expect(await support.transcript!(agent, children[1]!)).toBeNull();
		expect(support.direct).toBeUndefined();
		expect(support.interruptBySession).toBeUndefined();
	} finally {
		summary.close();
		rmSync(base, { recursive: true, force: true });
	}
});
