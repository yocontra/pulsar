import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverFor } from "../src/harnesses/index.ts";
import type { HarnessDriver } from "../src/harnesses/types.ts";
import { StaticIdentity } from "../src/http/identity.ts";
import type { MessageSearchResponse } from "../src/http/wire.ts";
import { RpcError } from "../src/rpc.ts";
import { type Doc, hasFts5, MessageIndex } from "../src/search/index.ts";
import { REDACTED, redactSecrets } from "../src/search/redact.ts";
import {
	ftsExpression,
	parseQuery,
	type Query,
	score,
	snippet,
} from "../src/search/text.ts";
import { PulsarService } from "../src/service/index.ts";
import { MessageSearch, RETENTION_MS } from "../src/service/message-search.ts";
import { Store } from "../src/store.ts";
import { newParseState } from "../src/transcripts/types.ts";
import { HttpTransport } from "../src/transport/http.ts";
import type { Agent } from "../src/types.ts";
import { until } from "./helpers.ts";

const OWNER = "me@example.com";
const dirs: string[] = [];
function tempDir(name: string) {
	const d = mkdtempSync(join(tmpdir(), `pulsar-search-${name}-`));
	dirs.push(d);
	return d;
}
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const q = (text: string) => parseQuery(text) as Query;

function doc(eventId: string, text: string, extra: Partial<Doc> = {}): Doc {
	return {
		agentId: "pi:a",
		eventId,
		ts: Date.now(),
		role: "agent",
		from: null,
		text,
		cursor: null,
		...extra,
	};
}

describe("FTS5 presence", () => {
	test("Bun's SQLite has FTS5 (macOS: the system library; Linux: Bun's own build)", () => {
		const store = new Store(join(tempDir("fts"), "pulsar.db"));
		expect(hasFts5(store.db)).toBe(true);
		expect(new MessageIndex(store.db).kind).toBe("fts5");
		store.db.close();
	});

	test("the migration makes plain tables only: no FTS5 table in the schema it writes", () => {
		const store = new Store(join(tempDir("schema"), "pulsar.db"));
		const tables = (
			store.db
				.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
				.all() as { name: string; sql: string }[]
		).filter((t) => t.name.startsWith("search"));
		expect(tables.map((t) => t.name).sort()).toEqual([
			"search_docs",
			"search_state",
		]);
		store.db.close();
	});
});

describe("query text", () => {
	test("a query needs a word of 3 letters; the last word is a prefix while typing", () => {
		expect(parseQuery("")).toBeNull();
		expect(parseQuery("a b to")).toBeNull();
		expect(parseQuery("fix it")).toEqual({
			terms: ["fix", "it"],
			prefix: true,
			phrase: "fix it",
		});
		expect(parseQuery("fix it ")?.prefix).toBe(false);
		expect(parseQuery("Résumé")?.terms).toEqual(["resume"]);
	});

	test("FTS5 expressions quote every term: operators and quotes in a query are words", () => {
		const parsed = q('auth" OR NEAR(x) *');
		expect(ftsExpression(parsed)).toBe('"auth" "or" "near" "x"');
		expect(ftsExpression(q("deploy fail"))).toBe('"deploy" "fail"*');
	});

	test("snippets are plain text with match ranges, cut on word edges around the first match", () => {
		const long = `${"lorem ipsum ".repeat(40)}the deploy failed on staging ${"dolor sit ".repeat(40)}`;
		const s = snippet(q("deploy failed "), long);
		expect(s.text.startsWith("…")).toBe(true);
		expect(s.text.endsWith("…")).toBe(true);
		expect(s.text.length).toBeLessThanOrEqual(170);
		const marked = s.marks.map(([a, b]) => s.text.slice(a, b));
		expect(marked).toEqual(["deploy", "failed"]);
		const short = snippet(q("auth"), "<b>Fix</b> the  authentication\nbug");
		expect(short.text).toBe("<b>Fix</b> the authentication bug");
		expect(short.marks.map(([a, b]) => short.text.slice(a, b))).toEqual([
			"authentication",
		]);
	});

	test("scores favor recent events, the words in order, whole words and the operator's words", () => {
		const now = Date.now();
		const parsed = q("deploy staging ");
		const base = { role: "agent", ts: now };
		const inOrder = score(parsed, { ...base, text: "deploy staging now" }, now);
		const apart = score(parsed, { ...base, text: "staging, then deploy" }, now);
		const old = score(
			parsed,
			{ ...base, ts: now - 7 * 864e5, text: "deploy staging now" },
			now,
		);
		const mine = score(
			parsed,
			{ role: "user", ts: now, text: "deploy staging now" },
			now,
		);
		expect(inOrder).toBeGreaterThan(apart);
		expect(inOrder - old).toBeCloseTo(0.5, 5);
		expect(mine).toBeGreaterThan(inOrder);
	});
});

describe("redaction", () => {
	test("token shapes, key blocks, assignments and URL passwords are replaced", () => {
		const cases = [
			"key sk-ant-api03-abcdefghijklmnopqrstuvwx done",
			"use ghp_abcdefghijklmnopqrstuvwxyz0123 here",
			"github_pat_11ABCDEFG0123456789_abcdefghijkl",
			"xoxb-1234567890-abcdefghij",
			"AKIAABCDEFGHIJKLMNOP",
			"Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
			"PASSWORD=hunter2hunter2",
			'"client_secret": "s3cr3tvalue123"',
			"postgres://admin:supersecret@db.local/app",
			"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		];
		for (const c of cases) {
			const out = redactSecrets(c);
			expect(out).toContain(REDACTED);
		}
		expect(redactSecrets("postgres://admin:supersecret@db.local/app")).toBe(
			`postgres://admin:${REDACTED}@db.local/app`,
		);
		expect(redactSecrets("PASSWORD=hunter2hunter2")).toBe(
			`PASSWORD=${REDACTED}`,
		);
	});

	test("ordinary prose about tokens and passwords is kept", () => {
		for (const text of [
			"the token management code needs a refactor",
			"reset the password flow and add a test",
			"sk-learn is a library",
			"secret: no",
		])
			expect(redactSecrets(text)).toBe(text);
	});
});

describe.each(["fts5", "memory"] as const)("index engine: %s", (engine) => {
	let store: Store;
	let index: MessageIndex;
	beforeAll(() => {
		store = new Store(join(tempDir(engine), "pulsar.db"));
		index = new MessageIndex(store.db, { engine });
	});
	afterAll(() => store.db.close());

	test("finds rows with every term; the last term as a prefix; accents folded", () => {
		expect(index.kind).toBe(engine);
		index.upsert([
			doc("e1", "Fixed the authentication bug in session.ts"),
			doc("e2", "The deploy to staging failed twice"),
			doc("e3", "Café menu: résumé of the day"),
			doc("e4", "authentic sourdough", { agentId: "pi:b" }),
		]);
		const ids = (text: string, agentId?: string) =>
			index
				.find(q(text), agentId ? { agentId } : {})
				.map((d) => d.eventId)
				.sort();
		expect(ids("authent")).toEqual(["e1", "e4"]);
		expect(ids("authent ")).toEqual([]);
		expect(ids("authentication bug")).toEqual(["e1"]);
		expect(ids("deploy auth")).toEqual([]);
		expect(ids("resume cafe")).toEqual(["e3"]);
		expect(ids("authent", "pi:b")).toEqual(["e4"]);
		expect(ids('" OR "auth')).toEqual([]);
	});

	test("an event seen again replaces its text; a null cursor keeps a known one", () => {
		index.upsert([doc("g1", "streaming partial", { cursor: "4096" })]);
		index.upsert([doc("g1", "streaming partial reply about kubernetes")]);
		const [hit] = index.find(q("kubernetes"));
		expect(hit?.eventId).toBe("g1");
		expect(hit?.cursor).toBe("4096");
		expect(index.find(q("streaming")).length).toBe(1);
		index.upsert([doc("g1", "rewritten entirely")]);
		expect(index.find(q("kubernetes"))).toEqual([]);
		expect(index.find(q("rewritten")).map((d) => d.eventId)).toEqual(["g1"]);
	});

	test("forgetting an agent and pruning old rows remove them from results", async () => {
		index.upsert([
			doc("p1", "ancient history entry", { ts: 1000 }),
			doc("p2", "fresh history entry"),
		]);
		expect(await index.prune(10_000)).toBe(1);
		expect(index.find(q("history")).map((d) => d.eventId)).toEqual(["p2"]);
		await index.forgetAgent("pi:b");
		expect(index.find(q("sourdough"))).toEqual([]);
		expect(index.count("pi:b")).toBe(0);
	});

	test("clear forgets every row; later writes are found again", () => {
		index.clear();
		expect(index.count()).toBe(0);
		expect(index.find(q("history"))).toEqual([]);
		index.upsert([doc("c1", "history after clearing")]);
		expect(index.find(q("history")).map((d) => d.eventId)).toEqual(["c1"]);
	});
});

test("the fallback engine loads rows already stored, in the background", async () => {
	const path = join(tempDir("load"), "pulsar.db");
	const first = new Store(path);
	new MessageIndex(first.db, { engine: "fts5" }).upsert(
		Array.from({ length: 2500 }, (_, i) =>
			doc(`l${i}`, `stored row ${i} jaguar`),
		),
	);
	first.db.close();
	const store = new Store(path);
	const index = new MessageIndex(store.db, { engine: "memory" });
	await until(
		() => index.find(q("jaguar"), { limit: 5000 }).length === 2500,
		5000,
	);
	expect(index.find(q("stored 1234 ")).map((d) => d.eventId)).toEqual([
		"l1234",
	]);
	store.db.close();
});

test("rows written without FTS5 are found once a runtime with FTS5 opens the database", () => {
	const path = join(tempDir("switch"), "pulsar.db");
	const older = new Store(path);
	// A first open with FTS5, then Node 22.13-style writes without it.
	new MessageIndex(older.db, { engine: "fts5" }).upsert([
		doc("s1", "written with fts kubernetes"),
	]);
	const fallback = new MessageIndex(older.db, { engine: "memory" });
	fallback.upsert([doc("s2", "written without fts kubernetes")]);
	fallback.upsert([doc("s1", "rewritten without fts helm")]);
	older.db.close();
	const newer = new Store(path);
	const index = new MessageIndex(newer.db);
	expect(index.kind).toBe("fts5");
	expect(
		index
			.find(q("kubernetes"))
			.map((d) => d.eventId)
			.sort(),
	).toEqual(["s2"]);
	expect(index.find(q("helm")).map((d) => d.eventId)).toEqual(["s1"]);
	newer.db.close();
});

// --- The service: backfill, live tap, ranking and the HTTP route ---

const parse = (driverFor("pi") as HarnessDriver).transcript!.parse;

function piLine(
	id: string,
	role: "user" | "assistant",
	text: string,
	ts = Date.now(),
) {
	const content = role === "user" ? text : [{ type: "text", text }];
	return `${JSON.stringify({
		type: "message",
		id,
		timestamp: new Date(ts).toISOString(),
		message: { role, content },
	})}\n`;
}

function piToolCall(id: string, command: string) {
	return `${JSON.stringify({
		type: "message",
		id,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "thinking about zebras" },
				{
					type: "toolCall",
					id: `call-${id}`,
					name: "bash",
					arguments: { command },
				},
			],
		},
	})}\n`;
}

describe("message search service", () => {
	let dir: string;
	let store: Store;
	let service: PulsarService;
	let http: HttpTransport;
	let base: string;
	const files = new Map<string, string>();

	function addAgent(sessionId: string, body: string): Agent {
		const file = join(dir, `${sessionId}.jsonl`);
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: "/work/demo" })}\n${body}`,
		);
		files.set(sessionId, file);
		return service.registry.upsert({
			harness: "pi",
			sessionId,
			pid: null,
			cwd: "/work/demo",
			project: "demo",
			branch: "main",
			tags: [],
			meta: {},
			registered: false,
		});
	}

	async function get(path: string) {
		const res = await fetch(`${base}/api/v1${path}`, {
			headers: { "X-Pulsar": "1" },
		});
		return { status: res.status, body: (await res.json()) as unknown };
	}

	beforeAll(async () => {
		dir = tempDir("svc");
		store = new Store(join(dir, "pulsar.db"));
		service = new PulsarService({
			store,
			scan: false,
			machine: "studio",
			// Backfill runs by hand here.
			search: { backfillMs: 3600_000 },
			transcripts: {
				pollMs: 20,
				resolve: (agent) => {
					const path = agent.sessionId ? files.get(agent.sessionId) : undefined;
					return path ? { source: { kind: "file", path }, parse } : null;
				},
			},
		});
		http = new HttpTransport(service, {
			identity: new StaticIdentity(OWNER, "phone"),
			owner: OWNER,
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
			hub: { coalesceMs: 60_000 },
		});
		await http.listen();
		base = `http://127.0.0.1:${http.port}`;
	});

	afterAll(async () => {
		await http.close();
		service.stop();
		store.db.close();
	});

	test("backfill indexes prompts, replies and tool titles; never thinking, tool output or old events", async () => {
		const agent = addAgent(
			"bf-1",
			piLine(
				"old1",
				"user",
				"ancient walrus request",
				Date.now() - RETENTION_MS - 864e5,
			) +
				piLine("u1", "user", "please fix the walrus parser") +
				piToolCall("t1", "grep -rn walrus src") +
				piLine("a1", "assistant", "Fixed the walrus parser; tests pass."),
		);
		await service.messages.backfillAgent(agent.id);
		const local = service.messages.local("walrus");
		expect(local.hits.map((h) => [h.eventId, h.role]).sort()).toEqual(
			[
				["a1#0", "agent"],
				["t1#1", "tool"],
				["u1", "user"],
			].sort(),
		);
		expect(service.messages.local("zebras").hits).toEqual([]);
	});

	test("a hit's cursor opens a page that holds its event, also after the log grew", async () => {
		const many = Array.from({ length: 450 }, (_, i) =>
			piLine(`m${i}`, "assistant", `filler message number ${i} about llamas`),
		).join("");
		const agent = addAgent(
			"bf-cursor",
			piLine("needle", "user", "the quokka migration plan") + many,
		);
		await service.messages.backfillAgent(agent.id);
		appendFileSync(
			files.get("bf-cursor")!,
			piLine("later", "assistant", "more llamas later"),
		);
		const [hit] = service.messages.local("quokka").hits;
		expect(hit?.eventId).toBe("needle");
		expect(hit?.cursor).not.toBeNull();
		const page = await service.transcripts.page(agent.id, hit!.cursor);
		expect(page.events.some((e) => e.id === "needle")).toBe(true);
	});

	test("backfill resumes where it stopped, reads only what is new, and starts over when a log shrinks", async () => {
		const agent = addAgent(
			"bf-resume",
			piLine("r1", "user", "first okapi note"),
		);
		const pages = () => {
			let n = 0;
			const original = service.transcripts.page.bind(service.transcripts);
			service.transcripts.page = async (...args) => {
				n++;
				return original(...args);
			};
			return {
				count: () => n,
				restore: () => {
					service.transcripts.page = original;
				},
			};
		};
		await service.messages.backfillAgent(agent.id);
		const spy = pages();
		try {
			expect(await service.messages.backfillAgent(agent.id)).toBe(0);
			expect(spy.count()).toBe(0);
			appendFileSync(
				files.get("bf-resume")!,
				piLine("r2", "assistant", "second okapi note"),
			);
			await service.messages.backfillAgent(agent.id);
			expect(spy.count()).toBe(1);
		} finally {
			spy.restore();
		}
		expect(service.messages.local("okapi").hits.length).toBe(2);
		// Resume survives a restart: the state is in the database.
		expect(service.messages.index.state(agent.id)?.top).toBe(
			statSync(files.get("bf-resume")!).size,
		);
		// The log was replaced by a shorter one: index it again.
		writeFileSync(
			files.get("bf-resume")!,
			piLine("n1", "user", "a fresh okapi start"),
		);
		await service.messages.backfillAgent(agent.id);
		expect(service.messages.local("okapi").hits.map((h) => h.eventId)).toEqual([
			"n1",
		]);
	});

	test("the live tail feeds the index as events arrive, redacted", async () => {
		const agent = addAgent("live-1", piLine("l0", "user", "hello there"));
		const off = service.transcripts.subscribe(agent.id, () => {});
		try {
			await service.transcripts.ready(agent.id);
			appendFileSync(
				files.get("live-1")!,
				piLine("l1", "user", "deploy narwhal with token=abcdefghijklmnop1234"),
			);
			await until(() => service.messages.local("narwhal").hits.length > 0);
		} finally {
			off();
		}
		const [hit] = service.messages.local("narwhal").hits;
		expect(hit?.cursor).toBeNull();
		expect(hit?.snippet).toBe(`deploy narwhal with token=${REDACTED}`);
		const stored = store.db
			.prepare("SELECT text FROM search_docs WHERE event_id = 'l1'")
			.get() as { text: string };
		expect(stored.text).not.toContain("abcdefghijklmnop1234");
		// A later backfill gives the live event its page cursor.
		await service.messages.backfillAgent(agent.id);
		expect(service.messages.local("narwhal").hits[0]?.cursor).not.toBeNull();
	});

	test("GET /search/messages: ranked hits with agent rows; short queries find nothing", async () => {
		addAgent(
			"rank-1",
			piLine(
				"x1",
				"assistant",
				"pangolin cache warmed",
				Date.now() - 3 * 864e5,
			) + piLine("x2", "user", "warm the pangolin cache"),
		);
		await service.messages.backfill();
		const r = await get(
			`/search/messages?q=${encodeURIComponent("pangolin cache")}`,
		);
		expect(r.status).toBe(200);
		const body = r.body as MessageSearchResponse;
		expect(body.hits.map((h) => h.eventId)).toEqual(["x2", "x1#0"]);
		expect(body.hits[0]!.role).toBe("user");
		expect(body.hits[0]!.marks.length).toBe(2);
		expect(body.agents.map((a) => a.id)).toEqual([body.hits[0]!.agentId]);
		expect(body.partial).toBeUndefined();
		const short = await get("/search/messages?q=pa");
		expect((short.body as MessageSearchResponse).hits).toEqual([]);
		const tooLong = await get(`/search/messages?q=${"a".repeat(201)}`);
		expect(tooLong.status).toBe(400);
	});

	test("GET /search/messages?agent=: one agent's hits, oldest first, past the per-agent cap", async () => {
		const agent = addAgent(
			"find-1",
			Array.from({ length: 12 }, (_, i) =>
				piLine(
					`f${i}`,
					"assistant",
					`step ${i} of the tapir rollout`,
					Date.now() - (12 - i) * 1000,
				),
			).join(""),
		);
		addAgent("find-2", piLine("g0", "user", "tapir elsewhere"));
		await service.messages.backfill();
		const all = await get(`/search/messages?q=tapir`);
		expect(
			(all.body as MessageSearchResponse).hits.filter(
				(h) => h.agentId === agent.id,
			).length,
		).toBe(5);
		const r = await get(
			`/search/messages?q=tapir&agent=${encodeURIComponent(agent.id)}`,
		);
		const body = r.body as MessageSearchResponse;
		expect(body.hits.map((h) => h.eventId)).toEqual(
			Array.from({ length: 12 }, (_, i) => `f${i}#0`),
		);
		expect(body.agents.map((a) => a.id)).toEqual([agent.id]);
		const unknown = await get("/search/messages?q=tapir&agent=pi%3Anope");
		expect((unknown.body as MessageSearchResponse).hits).toEqual([]);
	});

	test("an agent finds only its own transcript's events", async () => {
		const mine = addAgent(
			"own-1",
			piLine("o1", "user", "capybara secrets mine"),
		);
		addAgent("own-2", piLine("o2", "user", "capybara secrets theirs"));
		await service.messages.backfill();
		const asAgent = await service.messages.search("capybara", {
			kind: "agent",
			agentId: mine.id,
		} as never);
		expect(asAgent.hits.map((h) => h.agentId)).toEqual([mine.id]);
		const asOperator = await service.messages.search("capybara", {
			kind: "human",
			login: OWNER,
			node: "phone",
		} as never);
		expect(asOperator.hits.length).toBe(2);
		expect(
			service.app.hello({ kind: "human", login: OWNER, node: "phone" } as never)
				.features,
		).toContain("search");
	});
});

test("PULSAR_NO_SEARCH: nothing is indexed, searches find nothing, and the stored copy is deleted on start", async () => {
	const dir = tempDir("off");
	const store = new Store(join(dir, "pulsar.db"));
	new MessageIndex(store.db).upsert([doc("k1", "kept before off")]);
	const file = join(dir, "off.jsonl");
	writeFileSync(file, piLine("o1", "user", "lemur notes"));
	const service = new PulsarService({
		store,
		scan: false,
		machine: "studio",
		search: { off: true },
		transcripts: {
			pollMs: 20,
			resolve: () => ({ source: { kind: "file", path: file }, parse }),
		},
	});
	service.start();
	try {
		expect(service.messages.index.count()).toBe(0);
		expect(service.transcripts.tailer.tap).toBeNull();
		const human = { kind: "human", login: OWNER, node: "phone" } as never;
		expect(service.app.hello(human).features).not.toContain("search");
		const agent = service.registry.upsert({
			harness: "pi",
			sessionId: "off-1",
			pid: null,
			cwd: "/work/demo",
			project: "demo",
			branch: "main",
			tags: [],
			meta: {},
			registered: false,
		});
		expect(service.messages.local("lemur").hits).toEqual([]);
		expect(agent.id).toBeTruthy();
	} finally {
		service.stop();
		store.db.close();
	}
});

describe("every harness's transcript feeds the index", () => {
	const FIXTURES: [string, string][] = [
		["claude", "claude/session.jsonl"],
		[
			"codex",
			"codex/rollout-2026-11-10T11-00-00-0000bbbb-1111-4222-8333-444455556666.jsonl",
		],
		[
			"pi",
			"pi/2026-11-10T12-00-00-000Z_0000dddd-1111-4222-8333-444455556666.jsonl",
		],
		[
			"omp",
			"omp/2026-11-10T13-00-00-000Z_0000eeee-1111-4222-8333-444455556666.jsonl",
		],
	];
	test.each(FIXTURES)(
		"%s: prompts and replies, no thinking or tool output",
		(harness, rel) => {
			const support = (driverFor(harness) as HarnessDriver).transcript!;
			const text = readFileSync(
				join(import.meta.dir, "fixtures", "transcripts", rel),
				"utf8",
			);
			const events = support.parse(text, newParseState({ atStart: true }));
			const newest = events.reduce((m, e) => Math.max(m, e.ts || 0), 0);
			const store = new Store(join(tempDir(harness), "pulsar.db"));
			const search = new MessageSearch({
				store,
				transcripts: null as never,
				registry: null as never,
				views: null as never,
				now: () => newest + 1000,
			});
			const docs = search.docsFrom("a", events, null);
			const roles = new Set(docs.map((d) => d.role));
			expect(roles.has("user")).toBe(true);
			expect(roles.has("agent")).toBe(true);
			const kept = new Set(docs.map((d) => d.eventId));
			for (const e of events)
				if (
					e.kind === "thinking" ||
					e.kind === "tool_result" ||
					e.kind === "system"
				)
					expect(kept.has(e.id)).toBe(false);
			store.db.close();
		},
	);

	test("events without a usable time, subagent events and team notices", () => {
		const store = new Store(join(tempDir("edge"), "pulsar.db"));
		const search = new MessageSearch({
			store,
			transcripts: null as never,
			registry: null as never,
			views: null as never,
		});
		const now = Date.now();
		const docs = search.docsFrom(
			"a",
			[
				{ id: "z", ts: 0, role: "user", kind: "text", text: "no time" },
				{
					id: "n",
					ts: Number.NaN,
					role: "user",
					kind: "text",
					text: "bad time",
				},
				{
					id: "s",
					ts: now,
					role: "assistant",
					kind: "text",
					text: "sub",
					sidechain: "x",
				},
				{
					id: "t",
					ts: now,
					role: "user",
					kind: "text",
					text: "teammate result",
					notice: { type: "message" },
				},
				{
					id: "k",
					ts: now,
					role: "user",
					kind: "text",
					text: `${"x ".repeat(3993)}ghp_abcdefghijklmnopqrstuvwxyz0123456789`,
				},
			],
			null,
		);
		expect(docs.map((d) => [d.eventId, d.role])).toEqual([
			["t", "peer"],
			["k", "user"],
		]);
		expect(docs[1]!.text).not.toContain("ghp_");
		store.db.close();
	});
});

test("one remote agent's search on an older home node finds nothing instead of failing", async () => {
	const store = new Store(join(tempDir("old-peer"), "pulsar.db"));
	const address = "m2/pi:x";
	const agent = { id: address } as Agent;
	let reason = "unsupported";
	const search = new MessageSearch({
		store,
		transcripts: null as never,
		views: { row: (a: Agent) => ({ id: a.id }) } as never,
		registry: {
			find: (id: string) => (id === address ? agent : undefined),
			pool: {
				get: (id: string) => (id === address ? agent : undefined),
				searchAgentMessages: async () => {
					throw new RpcError(reason, "unknown action search.messages");
				},
			},
		} as never,
	});
	const as = { kind: "human", login: OWNER, node: "phone" } as never;
	const r = await search.search("walrus", as, { agent: address });
	expect(r.hits).toEqual([]);
	reason = "unreachable";
	await expect(
		search.search("walrus", as, { agent: address }),
	).rejects.toThrow();
	store.db.close();
});
