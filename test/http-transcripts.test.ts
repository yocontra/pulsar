import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	copyFileSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverFor } from "../src/harnesses/index.ts";
import type { HarnessDriver } from "../src/harnesses/types.ts";
import { StaticIdentity } from "../src/http/identity.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import type { TranscriptEvent } from "../src/transcripts/types.ts";
import { HttpTransport } from "../src/transport/http.ts";
import type { Agent } from "../src/types.ts";
import { until } from "./helpers.ts";

const OWNER = "me@example.com";
const PI = join(
	import.meta.dir,
	"fixtures",
	"transcripts",
	"pi",
	"2026-11-10T12-00-00-000Z_0000dddd-1111-4222-8333-444455556666.jsonl",
);

/** One pi session record: a user message. */
const line = (id: string, text: string) =>
	`${JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-11-10T12:00:00.000Z",
		message: { role: "user", content: text },
	})}\n`;

let dir: string;
let store: Store;
let service: PulsarService;
let http: HttpTransport;
let base: string;
const files = new Map<string, string>();

function addAgent(sessionId: string, withLog: boolean): Agent {
	if (withLog) {
		const file = join(dir, `${sessionId}.jsonl`);
		copyFileSync(PI, file);
		files.set(sessionId, file);
	}
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

function api(path: string, init: RequestInit = {}) {
	return fetch(`${base}${path}`, {
		...init,
		headers: {
			"X-Pulsar": "1",
			...(init.body ? { "Content-Type": "application/json" } : {}),
		},
	});
}

interface SseEvent {
	id: string;
	event: string;
	data: Record<string, unknown>;
}

async function openEvents(lastEventId?: string) {
	const ac = new AbortController();
	const res = await fetch(`${base}/api/v1/events`, {
		headers: {
			"X-Pulsar": "1",
			...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
		},
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
						if (l.startsWith("id: ")) e.id = l.slice(4);
						else if (l.startsWith("event: ")) e.event = l.slice(7);
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
	const subscribe = (session: string | null) =>
		api(`/api/v1/subscriptions/${streamId}`, {
			method: "PUT",
			body: JSON.stringify({ session }),
		});
	return { events, streamId, subscribe, close: () => ac.abort() };
}

/**
 * Subscribes a stream to an agent's transcript and waits until its watcher
 * is attached. The watcher starts at the end of the file on its first tick,
 * which runs after the PUT returns: a line appended before that tick is
 * history, never a live event. The app pages after subscribing (the page
 * waits for the watcher); a test that appends at once must wait too.
 */
async function follow(
	s: { subscribe: (session: string | null) => Promise<Response> },
	agentId: string,
) {
	expect((await s.subscribe(agentId)).status).toBe(200);
	await service.transcripts.ready(agentId);
}

const transcripts = (events: SseEvent[], agent: string) =>
	events.filter((e) => e.event === "transcript" && e.data.agent === agent);

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pulsar-http-transcripts-"));
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
});

describe("transcript pages", () => {
	test("the user pages a transcript, newest first", async () => {
		const agent = addAgent("page-1", true);
		const res = await api(
			`/api/v1/agents/${encodeURIComponent(agent.id)}/transcript`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const page = (await res.json()) as {
			events: TranscriptEvent[];
			cursor: string | null;
			available: boolean;
		};
		expect(page.available).toBe(true);
		expect(page.events.map((e) => e.id)).toContain("cm000001");
		if (page.cursor) {
			const older = await api(
				`/api/v1/agents/${encodeURIComponent(agent.id)}/transcript?cursor=${encodeURIComponent(page.cursor)}`,
			);
			expect(older.status).toBe(200);
		}
	});

	test("no transcript, unknown agents, bad cursors", async () => {
		const bare = addAgent("page-bare", false);
		const none = await api(
			`/api/v1/agents/${encodeURIComponent(bare.id)}/transcript`,
		);
		expect(await none.json()).toEqual({
			events: [],
			cursor: null,
			available: false,
		});
		const unknown = await api("/api/v1/agents/pi%3Anobody/transcript");
		expect(unknown.status).toBe(404);
		const agent = addAgent("page-2", true);
		const bad = await api(
			`/api/v1/agents/${encodeURIComponent(agent.id)}/transcript?cursor=not-a-cursor`,
		);
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
			"bad_cursor",
		);
	});

	test("refused without the custom header", async () => {
		const agent = addAgent("page-3", true);
		const res = await fetch(
			`${base}/api/v1/agents/${encodeURIComponent(agent.id)}/transcript`,
		);
		expect(res.status).toBe(403);
	});
});

describe("live transcripts over SSE", () => {
	test("the open session streams appended events promptly", async () => {
		const agent = addAgent("live-1", true);
		const s = await openEvents();
		expect((await s.subscribe(agent.id)).status).toBe(200);
		expect(service.transcripts.tailer.subscribers(agent.id)).toBe(1);
		// Subscribed first; now the page, then a live append.
		const page = await api(
			`/api/v1/agents/${encodeURIComponent(agent.id)}/transcript`,
		);
		expect(page.status).toBe(200);
		appendFileSync(files.get("live-1")!, line("live-a", "hello from the file"));
		// The hub's coalescing tick is a minute away: this arrives on its own.
		await until(() => transcripts(s.events, agent.id).length > 0, 2000);
		const got = transcripts(s.events, agent.id).flatMap(
			(e) => e.data.events as TranscriptEvent[],
		);
		expect(got.map((e) => e.id)).toEqual(["live-a"]);
		expect(got[0]!.text).toBe("hello from the file");
		// Two records written together arrive as one batch.
		const before = transcripts(s.events, agent.id).length;
		appendFileSync(
			files.get("live-1")!,
			line("live-b", "one") + line("live-c", "two"),
		);
		await until(
			() =>
				transcripts(s.events, agent.id)
					.slice(before)
					.flatMap((e) => e.data.events as TranscriptEvent[]).length === 2,
			2000,
		);
		expect(transcripts(s.events, agent.id).length).toBe(before + 1);
		s.close();
		await until(() => service.transcripts.tailer.subscribers(agent.id) === 0);
	});

	test("a page with ?stream= subscribes that stream first: no PUT needed, nothing lost", async () => {
		const agent = addAgent("stream-1", true);
		const s = await openEvents();
		const page = await api(
			`/api/v1/agents/${encodeURIComponent(agent.id)}/transcript?stream=${s.streamId}`,
		);
		expect(page.status).toBe(200);
		// The page call itself attached the stream's watcher.
		expect(service.transcripts.tailer.subscribers(agent.id)).toBe(1);
		appendFileSync(files.get("stream-1")!, line("after-page", "right after"));
		await until(() => transcripts(s.events, agent.id).length > 0, 2000);
		expect(
			transcripts(s.events, agent.id).flatMap((e) =>
				(e.data.events as TranscriptEvent[]).map((x) => x.id),
			),
		).toEqual(["after-page"]);
		// Another login's or an unknown stream changes nothing (still a page).
		expect(
			(
				await api(
					`/api/v1/agents/${encodeURIComponent(agent.id)}/transcript?stream=nope`,
				)
			).status,
		).toBe(200);
		// A later full subscription keeps or drops it as usual.
		await s.subscribe(null);
		expect(service.transcripts.tailer.subscribers(agent.id)).toBe(0);
		s.close();
	});

	test("switching the session unsubscribes the old transcript", async () => {
		const a = addAgent("switch-a", true);
		const b = addAgent("switch-b", true);
		const s = await openEvents();
		await s.subscribe(a.id);
		expect(service.transcripts.tailer.subscribers(a.id)).toBe(1);
		await follow(s, b.id);
		expect(service.transcripts.tailer.subscribers(a.id)).toBe(0);
		expect(service.transcripts.tailer.subscribers(b.id)).toBe(1);
		appendFileSync(files.get("switch-a")!, line("old-1", "nobody watches"));
		appendFileSync(files.get("switch-b")!, line("new-1", "watched"));
		await until(() => transcripts(s.events, b.id).length > 0, 2000);
		await new Promise((r) => setTimeout(r, 100));
		expect(transcripts(s.events, a.id)).toHaveLength(0);
		await s.subscribe(null);
		expect(service.transcripts.tailer.subscribers(b.id)).toBe(0);
		s.close();
	});

	test("two tabs share one tailer subscription; closing both drops it", async () => {
		const agent = addAgent("shared-1", true);
		const one = await openEvents();
		const two = await openEvents();
		await follow(one, agent.id);
		await follow(two, agent.id);
		expect(service.transcripts.tailer.subscribers(agent.id)).toBe(1);
		appendFileSync(files.get("shared-1")!, line("both-1", "to both"));
		await until(
			() =>
				transcripts(one.events, agent.id).length > 0 &&
				transcripts(two.events, agent.id).length > 0,
			2000,
		);
		one.close();
		await new Promise((r) => setTimeout(r, 100));
		expect(service.transcripts.tailer.subscribers(agent.id)).toBe(1);
		two.close();
		await until(() => service.transcripts.tailer.subscribers(agent.id) === 0);
	});

	test("a resume from before the topic was made again gets a gap, not a partial replay", async () => {
		const agent = addAgent("refloor-1", true);
		const phone = await openEvents();
		await follow(phone, agent.id);
		appendFileSync(files.get("refloor-1")!, line("seen-0", "before"));
		await until(() => transcripts(phone.events, agent.id).length > 0, 2000);
		const lastId = transcripts(phone.events, agent.id).at(-1)!.id;
		// The phone goes to the background; nobody else watches, so the topic goes.
		phone.close();
		await until(() => service.transcripts.tailer.subscribers(agent.id) === 0);
		appendFileSync(files.get("refloor-1")!, line("unseen-1", "while away"));
		// A desktop opens the same session: the topic is made again, empty.
		const desk = await openEvents();
		await follow(desk, agent.id);
		appendFileSync(files.get("refloor-1")!, line("seen-1", "after"));
		await until(() => transcripts(desk.events, agent.id).length > 0, 2000);
		const back = await openEvents(lastId);
		await until(
			() =>
				back.events.some(
					(e) => e.event === "gap" && e.data.topic === "transcript",
				),
			2000,
		);
		back.close();
		desk.close();
	});

	test("an unknown session agent subscribes to nothing", async () => {
		const s = await openEvents();
		expect((await s.subscribe("pi:nobody")).status).toBe(200);
		expect(service.transcripts.tailer.subscribers("pi:nobody")).toBe(0);
		s.close();
	});
});

/** A 1×1 PNG. */
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SVG = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
).toString("base64");

/** A pi agent whose transcript has a tool result with images. */
function imageAgent(sessionId: string): Agent {
	const agent = addAgent(sessionId, false);
	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(
		file,
		`${JSON.stringify({
			type: "message",
			id: "r1",
			timestamp: "2026-11-10T12:00:00.000Z",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "screenshot",
				content: [
					{ type: "text", text: "done" },
					{ type: "image", data: PNG, mimeType: "image/png" },
					{ type: "image", data: SVG, mimeType: "image/svg+xml" },
					{ type: "image", data: SVG, mimeType: "image/png" },
				],
			},
		})}\n`,
	);
	files.set(sessionId, file);
	return agent;
}

async function imagesOf(agent: Agent) {
	const res = await api(
		`/api/v1/agents/${encodeURIComponent(agent.id)}/transcript`,
	);
	const page = (await res.json()) as { events: TranscriptEvent[] };
	return page.events.flatMap((e) => e.images ?? []);
}

describe("transcript images", () => {
	test("an event's image URL serves the bytes with safe headers", async () => {
		const agent = imageAgent("img-1");
		const images = await imagesOf(agent);
		// The SVG block is dropped; the PNG and the mislabeled SVG remain.
		expect(images.map((i) => [i.id, i.mediaType])).toEqual([
			["r1#img0", "image/png"],
			["r1#img1", "image/png"],
		]);
		const res = await api(images[0]!.url);
		expect(res.status).toBe(200);
		expect(Buffer.from(await res.arrayBuffer())).toEqual(
			Buffer.from(PNG, "base64"),
		);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("content-disposition")).toBe("inline");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
		// Media bytes are never active content, even opened on their own.
		expect(res.headers.get("content-security-policy")).toBe(
			"sandbox; default-src 'none'",
		);
	});

	test("SVG is never served, not even labeled as PNG", async () => {
		const agent = imageAgent("img-2");
		const images = await imagesOf(agent);
		const fake = await api(images[1]!.url);
		expect(fake.status).toBe(415);
		expect(fake.headers.get("cache-control")).toBe("no-store");
		expect(fake.headers.get("content-type")).toContain("application/json");
		// The dropped SVG block has no image id to serve.
		const dropped = await api(images[0]!.url.replace("img0", "img2"));
		expect(dropped.status).toBe(404);
	});

	test("live events over SSE carry image URLs that fetch", async () => {
		const agent = addAgent("img-live", true);
		const s = await openEvents();
		await follow(s, agent.id);
		appendFileSync(
			files.get("img-live")!,
			`${JSON.stringify({
				type: "message",
				id: "live-img",
				timestamp: "2026-11-10T12:00:00.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "pasted" },
						{ type: "image", data: PNG, mimeType: "image/png" },
					],
				},
			})}\n`,
		);
		await until(() => transcripts(s.events, agent.id).length > 0, 2000);
		const event = transcripts(s.events, agent.id)
			.flatMap((e) => e.data.events as TranscriptEvent[])
			.find((e) => e.id === "live-img")!;
		expect(JSON.stringify(event)).not.toContain(PNG.slice(0, 20));
		const res = await api(event.images![0]!.url);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		s.close();
	});

	test("wrong agent, unknown agent, unknown id: 404; no header: 403", async () => {
		const agent = imageAgent("img-3");
		const other = imageAgent("img-4");
		const [image] = await imagesOf(agent);
		const path = (id: string) =>
			`/api/v1/agents/${encodeURIComponent(id)}/transcript/images/${encodeURIComponent(image!.id)}`;
		const wrong = await api(path(other.id));
		expect(wrong.status).toBe(404);
		expect(wrong.headers.get("cache-control")).toBe("no-store");
		expect((await api(path("pi:nobody"))).status).toBe(404);
		expect((await api(image!.url.replace("img0", "img7"))).status).toBe(404);
		expect((await fetch(`${base}${image!.url}`)).status).toBe(403);
	});
});
