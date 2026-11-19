import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	copyFileSync,
	mkdtempSync,
	rmSync,
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverFor } from "../src/harnesses/index.ts";
import type { HarnessDriver } from "../src/harnesses/types.ts";
import { StaticIdentity } from "../src/http/identity.ts";
import type { ChangesSummary, FileDiff } from "../src/http/wire.ts";
import { authorize } from "../src/service/authorize.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import type { Agent } from "../src/types.ts";
import { cleanupRepos, gitRepo, tmpFolder } from "./git-repo.ts";
import { until } from "./helpers.ts";

const OWNER = "me@example.com";
const PI = join(
	import.meta.dir,
	"fixtures",
	"transcripts",
	"pi",
	"2026-11-10T12-00-00-000Z_0000dddd-1111-4222-8333-444455556666.jsonl",
);

let dir: string;
let store: Store;
let service: PulsarService;
let http: HttpTransport;
let base: string;
const files = new Map<string, string>();

function addAgent(sessionId: string, cwd: string | null): Agent {
	const file = join(dir, `${sessionId}.jsonl`);
	copyFileSync(PI, file);
	files.set(sessionId, file);
	return service.registry.upsert({
		harness: "pi",
		sessionId,
		pid: null,
		cwd,
		project: "demo",
		branch: "main",
		tags: [],
		meta: {},
		registered: false,
	});
}

function api(path: string, init: RequestInit = {}) {
	return fetch(`${base}${path}`, {
		...init,
		headers: {
			"X-Pulsar": "1",
			...(init.body ? { "Content-Type": "application/json" } : {}),
		},
	});
}

const enc = encodeURIComponent;

interface SseEvent {
	event: string;
	data: Record<string, unknown>;
}

async function openEvents() {
	const ac = new AbortController();
	const res = await fetch(`${base}/api/v1/events`, {
		headers: { "X-Pulsar": "1" },
		signal: ac.signal,
	});
	const events: SseEvent[] = [];
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	void (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				let end = buffer.indexOf("\n\n");
				while (end !== -1) {
					const e: Partial<SseEvent> = {};
					for (const l of buffer.slice(0, end).split("\n")) {
						if (l.startsWith("event: ")) e.event = l.slice(7);
						else if (l.startsWith("data: ")) e.data = JSON.parse(l.slice(6));
					}
					if (e.event) events.push(e as SseEvent);
					buffer = buffer.slice(end + 2);
					end = buffer.indexOf("\n\n");
				}
			}
		} catch {}
	})();
	await until(() => events.some((e) => e.event === "ready"));
	const streamId = events.find((e) => e.event === "ready")!.data
		.streamId as string;
	const subscribe = (changes: { agent: string; mode: string } | null) =>
		api(`/api/v1/subscriptions/${streamId}`, {
			method: "PUT",
			body: JSON.stringify({ changes }),
		});
	return { events, subscribe, close: () => ac.abort() };
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pulsar-http-changes-"));
	store = new Store(join(dir, "pulsar.db"));
	const parse = (driverFor("pi") as HarnessDriver).transcript!.parse;
	service = new PulsarService({
		store,
		scan: false,
		machine: "studio",
		transcripts: {
			pollMs: 20,
			resolve: (agent) => {
				const path = agent.sessionId ? files.get(agent.sessionId) : undefined;
				return path ? { source: { kind: "file", path }, parse } : null;
			},
		},
		// No poll in these tests: only agent activity re-reads the worktree.
		changes: { pollMs: 600_000, debounceMs: 20 },
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
	store.close();
	rmSync(dir, { recursive: true, force: true });
	cleanupRepos();
});

describe("GET /agents/:id/changes", () => {
	test("summary and one file's diff", async () => {
		const repo = gitRepo();
		appendFileSync(join(repo, "a.txt"), "four\n");
		const agent = addAgent("ch-1", repo);
		const res = await api(`/api/v1/agents/${enc(agent.id)}/changes`);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const s = (await res.json()) as ChangesSummary;
		expect(s).toMatchObject({
			agent: agent.id,
			mode: "worktree",
			available: true,
			branch: "main",
			total: 1,
		});
		expect(s.files[0]).toMatchObject({ path: "a.txt", added: 1 });
		const f = await api(
			`/api/v1/agents/${enc(agent.id)}/changes/file?path=a.txt`,
		);
		expect(f.status).toBe(200);
		const d = (await f.json()) as FileDiff;
		expect(d.patch).toContain("+four");
		expect(d.key).toBe(s.files[0]!.key);
	});

	test("unlisted paths, traversal, bad modes and unknown agents", async () => {
		const repo = gitRepo();
		appendFileSync(join(repo, "a.txt"), "x\n");
		const agent = addAgent("ch-2", repo);
		const id = enc(agent.id);
		for (const path of [
			"gone.txt",
			"../../etc/passwd",
			"/etc/passwd",
			".git/config",
		])
			expect(
				(await api(`/api/v1/agents/${id}/changes/file?path=${enc(path)}`))
					.status,
			).toBe(404);
		expect((await api(`/api/v1/agents/${id}/changes/file`)).status).toBe(400);
		expect((await api(`/api/v1/agents/${id}/changes?mode=nope`)).status).toBe(
			400,
		);
		expect((await api("/api/v1/agents/pi%3Anobody/changes")).status).toBe(404);
	});

	test("no folder and a folder outside any repo", async () => {
		const none = addAgent("ch-3", null);
		expect(
			await (await api(`/api/v1/agents/${enc(none.id)}/changes`)).json(),
		).toMatchObject({ available: false, reason: "no_cwd", files: [] });
		const plain = addAgent("ch-4", tmpFolder());
		expect(
			await (await api(`/api/v1/agents/${enc(plain.id)}/changes`)).json(),
		).toMatchObject({ available: false, reason: "not_a_repo" });
	});

	test("an agent reads only its own changes (the transcript rule)", () => {
		const me = { kind: "agent" as const, agentId: "pi:me" };
		expect(() => authorize(me, "transcript.read", "pi:other")).toThrow();
		expect(() => authorize(me, "transcript.read", "pi:me")).not.toThrow();
	});
});

describe("the changes SSE topic", () => {
	test("streams the summary, then each change after agent activity", async () => {
		const repo = gitRepo();
		const agent = addAgent("ch-sse", repo);
		const sse = await openEvents();
		const changes = () =>
			sse.events.filter(
				(e) => e.event === "changes" && e.data.agent === agent.id,
			) as unknown as { data: ChangesSummary }[];
		expect(
			(await sse.subscribe({ agent: agent.id, mode: "worktree" })).status,
		).toBe(200);
		await until(() => changes().length === 1, 5000);
		expect(changes()[0]!.data.files).toEqual([]);

		// The agent edits a file; its transcript moves; the viewer hears it.
		appendFileSync(join(repo, "a.txt"), "edited\n");
		const t = new Date(Date.now() + 5000);
		utimesSync(join(repo, "a.txt"), t, t);
		appendFileSync(
			files.get("ch-sse")!,
			`${JSON.stringify({
				type: "message",
				id: "edit-1",
				timestamp: "2026-11-10T12:00:09.000Z",
				message: { role: "user", content: "edited a.txt" },
			})}\n`,
		);
		await until(() => changes().length >= 2, 5000);
		const last = changes().at(-1)!.data;
		expect(last.files.map((f) => f.path)).toEqual(["a.txt"]);
		expect(last.stamp).not.toBe(changes()[0]!.data.stamp);

		// A second stream on the same topic gets the last summary at once.
		const other = await openEvents();
		await other.subscribe({ agent: agent.id, mode: "worktree" });
		await until(
			() =>
				other.events.some(
					(e) =>
						e.event === "changes" &&
						(e.data as unknown as ChangesSummary).stamp === last.stamp,
				),
			3000,
		);
		other.close();

		// Unsubscribed: no more reads.
		await sse.subscribe(null);
		const n = changes().length;
		appendFileSync(join(repo, "a.txt"), "more\n");
		appendFileSync(
			files.get("ch-sse")!,
			`${JSON.stringify({
				type: "message",
				id: "edit-2",
				timestamp: "2026-11-10T12:00:10.000Z",
				message: { role: "user", content: "again" },
			})}\n`,
		);
		await new Promise((r) => setTimeout(r, 300));
		expect(changes().length).toBe(n);
		sse.close();
	});

	test("a subscription with a bad changes field is refused", async () => {
		const sse = await openEvents();
		const streamId = "x";
		const bad = await api(`/api/v1/subscriptions/${streamId}`, {
			method: "PUT",
			body: JSON.stringify({ changes: { agent: "a", mode: "nope" } }),
		});
		expect(bad.status).toBe(400);
		sse.close();
	});
});
