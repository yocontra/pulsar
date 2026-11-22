import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverFor } from "../src/harnesses/index.ts";
import type { HarnessDriver } from "../src/harnesses/types.ts";
import { StaticIdentity } from "../src/http/identity.ts";
import type { AgentRow } from "../src/http/wire.ts";
import {
	callTouches,
	parseQuestion,
	rank,
	workFrom,
} from "../src/service/ask-core.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { newParseState } from "../src/transcripts/types.ts";
import { HttpTransport } from "../src/transport/http.ts";

const FIX = join(import.meta.dir, "fixtures", "transcripts");
const CLAUDE_LOG = join(FIX, "claude", "session.jsonl");
const CODEX_LOG = join(
	FIX,
	"codex",
	"rollout-2026-11-10T11-00-00-0000bbbb-1111-4222-8333-444455556666.jsonl",
);

function parsed(harness: string, file: string) {
	const support = (driverFor(harness) as HarnessDriver).transcript!;
	return support.parse(
		readFileSync(file, "utf8"),
		newParseState({ atStart: true }),
	);
}

describe("touched files from transcript tool calls", () => {
	test("Claude Edit counts, Read does not", () => {
		const w = workFrom(parsed("claude", CLAUDE_LOG), "/work/demo");
		expect(w.touches.map((t) => [t.verb, t.path])).toEqual([
			["Edited", "/work/demo/src/auth/session.ts"],
		]);
		expect(w.lastText).toBeTruthy();
	});

	test("Codex apply_patch names its files, relative to the folder", () => {
		const w = workFrom(parsed("codex", CODEX_LOG), "/work/demo");
		expect(w.touches.map((t) => [t.verb, t.path])).toEqual([
			["Patched", "/work/demo/src/net.ts"],
		]);
	});

	test("other harnesses' edit tools, and apply_patch run through a shell", () => {
		expect(callTouches("edit", { path: "src/a.ts" }, "/w")).toEqual([
			{ path: "/w/src/a.ts", verb: "Edited" },
		]);
		expect(callTouches("write", { filePath: "/x/b.md" }, "/w")).toEqual([
			{ path: "/x/b.md", verb: "Wrote" },
		]);
		expect(
			callTouches("MultiEdit", { file_path: "../c.ts", edits: [] }, "/w/sub"),
		).toEqual([{ path: "/w/c.ts", verb: "Edited" }]);
		expect(
			callTouches(
				"exec_command",
				{
					cmd: "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: d.ts\n+x\n*** Delete File: e.ts\n*** End Patch\nEOF",
				},
				"/w",
			),
		).toEqual([
			{ path: "/w/d.ts", verb: "Wrote" },
			{ path: "/w/e.ts", verb: "Deleted" },
		]);
		expect(callTouches("Read", { file_path: "/w/a.ts" }, "/w")).toEqual([]);
		expect(callTouches("bash", { command: "ls" }, "/w")).toEqual([]);
	});
});

describe("question parsing", () => {
	const rows = [
		{ name: "fixer", project: "demo", machine: "studio", branch: "fix-1378" },
	] as AgentRow[];
	test("paths, numbers, known names, state", () => {
		expect(
			parseQuestion("who is editing src/auth/session.ts on demo?", rows),
		).toMatchObject({ paths: ["src/auth/session.ts"], projects: ["demo"] });
		expect(parseQuestion("who has PR 1402 or #1378", rows).numbers).toEqual([
			"1402",
			"1378",
		]);
		expect(parseQuestion("what is fixer doing", rows).agents).toEqual([
			"fixer",
		]);
		expect(parseQuestion("who's idle on studio", rows)).toMatchObject({
			state: "idle",
			machines: ["studio"],
		});
		expect(parseQuestion("anyone on fix-1378", rows).branches).toEqual([
			"fix-1378",
		]);
		expect(parseQuestion("who touched package.json", rows).paths).toEqual([
			"package.json",
		]);
	});

	test("a scope-only question lists who is there; nothing else matches nothing", () => {
		const r = (over: Partial<AgentRow>) =>
			({
				name: "a",
				id: "a",
				project: "demo",
				machine: "m",
				branch: null,
				tags: [],
				state: "idle",
				lastSeen: 0,
				activity: null,
				cwd: null,
				...over,
			}) as AgentRow;
		const list = [r({ id: "1" }), r({ id: "2", state: "busy" })];
		const q = "who is idle on demo";
		const res = rank(q, parseQuestion(q, list), list, () => null);
		expect(res.matches.map((m) => m.agent.id)).toEqual(["1"]);
		const none = "who works on quantum";
		expect(rank(none, parseQuestion(none, list), list, () => null).total).toBe(
			0,
		);
	});

	test("evidence names the field that matched (a tag, not 'branch null')", () => {
		const row = {
			name: "rev",
			id: "rev",
			project: "demo",
			machine: "m",
			branch: null,
			tags: ["role:reviewer"],
			state: "idle",
			lastSeen: 0,
			activity: null,
			cwd: null,
		} as unknown as AgentRow;
		const q = "who is the reviewer";
		const res = rank(q, parseQuestion(q, [row]), [row], () => null);
		const evidence = res.matches[0]?.evidence ?? [];
		expect(evidence).toContain("tag role:reviewer");
		expect(evidence.join(" ")).not.toContain("branch null");
	});
});

describe("ask on a daemon (askPool)", () => {
	let dir: string;
	let store: Store;
	let service: PulsarService;
	let http: HttpTransport;
	let base: string;
	const logs = new Map<string, string>();

	// What socket `lookup` (`pulsar ask`, MCP `list_agents question`) runs.
	const ask = async (question: string, selector?: string) => ({
		body: await service.askPool(
			{ question, ...(selector ? { selector } : {}) },
			{ kind: "human", login: "me@example.com", node: "phone" },
		),
	});

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-ask-"));
		store = new Store(join(dir, "pulsar.db"));
		for (const [id, src] of [
			["c1", CLAUDE_LOG],
			["x1", CODEX_LOG],
		] as const) {
			const file = join(dir, `${id}.jsonl`);
			copyFileSync(src, file);
			logs.set(id, file);
		}
		service = new PulsarService({
			store,
			scan: false,
			machine: "studio",
			transcripts: {
				resolve: (agent) => {
					const path = agent.sessionId ? logs.get(agent.sessionId) : undefined;
					const support = driverFor(agent.harness)?.transcript;
					return path && support
						? {
								source: { kind: "file", path },
								parse: support.parse,
								cwd: agent.cwd,
							}
						: null;
				},
			},
		});
		const add = (
			harness: string,
			sessionId: string,
			name: string,
			tags: string[] = [],
		) =>
			service.registry.upsert({
				harness,
				sessionId,
				pid: null,
				cwd: "/work/demo",
				project: "demo",
				branch: name === "netter" ? "fix-1378" : "main",
				tags,
				name,
				meta: {},
				registered: false,
				status: "idle",
			});
		add("claude", "c1", "fixer", ["pr:1402"]);
		add("codex", "x1", "netter");
		add("pi", "p1", "bystander");
		http = new HttpTransport(service, {
			identity: new StaticIdentity("me@example.com", "phone"),
			owner: "me@example.com",
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
		});
		await http.listen();
		base = `http://127.0.0.1:${http.port}`;
	});

	afterAll(async () => {
		await http.close();
		service.stop();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("who is editing a file: from the logs, with evidence, nobody woken", async () => {
		const r = await ask("who is editing src/auth/session.ts?");
		expect(r.body.matches.map((m) => m.agent.name)).toEqual(["fixer"]);
		expect(r.body.matches[0]!.evidence[0]).toMatch(
			/^Edited src\/auth\/session\.ts \d+[smhd] ago$/,
		);
		const net = await ask("who touched net.ts");
		expect(net.body.matches[0]!.agent.name).toBe("netter");
		expect(net.body.matches[0]!.evidence[0]).toMatch(/^Patched src\/net\.ts/);
		// Nothing was sent.
		expect(store.auditLog(5)).toEqual([]);
	});

	test("agents get no transcript text from other agents; the user does", async () => {
		const q = { question: "what is fixer doing" };
		const asUser = await service.askPool(q, {
			kind: "human",
			login: "me@example.com",
			node: "phone",
		});
		expect(
			asUser.matches[0]!.evidence.some((e) => e.startsWith("last said: ")),
		).toBe(true);
		const asAgent = await service.askPool(q, {
			kind: "agent",
			agentId: "pi:p1",
		});
		expect(asAgent.matches[0]!.agent.name).toBe("fixer");
		expect(
			asAgent.matches[0]!.evidence.some((e) => e.startsWith("last said: ")),
		).toBe(false);
	});

	test("logs are re-read only when they change", async () => {
		await ask("who touched net.ts");
		const before = service.ask.reads;
		await ask("who touched net.ts");
		expect(service.ask.reads).toBe(before);
		appendFileSync(logs.get("x1")!, "\n");
		await ask("who touched net.ts");
		expect(service.ask.reads).toBeGreaterThan(before);
	});

	test("PR numbers, branches, agents by name, idle on a project, selectors", async () => {
		expect((await ask("who has PR 1402")).body.matches[0]).toMatchObject({
			agent: { name: "fixer" },
			evidence: ["PR #1402"],
		});
		expect(
			(await ask("who is on issue 1378")).body.matches[0]!.evidence,
		).toContain("branch fix-1378");
		const doing = (await ask("what is fixer doing")).body.matches[0]!;
		expect(doing.agent.name).toBe("fixer");
		expect(doing.evidence.some((e) => e.startsWith("last said: "))).toBe(true);
		expect((await ask("who is idle on demo")).body.total).toBe(3);
		expect((await ask("who touched net.ts", "harness=claude")).body.total).toBe(
			0,
		);
	});

	test("the app's HTTP ask route is gone", async () => {
		const res = await fetch(`${base}/api/v1/ask`, {
			method: "POST",
			headers: { "X-Pulsar": "1", "Content-Type": "application/json" },
			body: JSON.stringify({ question: "who touched net.ts" }),
		});
		expect(res.status).toBe(404);
	});
});
