import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionDir } from "../src/harnesses/claude-subagents.ts";
import { driverFor } from "../src/harnesses/index.ts";
import type { FoundSubagent, HarnessDriver } from "../src/harnesses/types.ts";
import { StaticIdentity } from "../src/http/identity.ts";
import type {
	AgentRow,
	AgentsPage,
	SubagentList,
	SubagentRow,
	TreeNode,
} from "../src/http/wire.ts";
import { PulsarService } from "../src/service/index.ts";
import { DONE_KEEP_MS } from "../src/service/subagents.ts";
import { Store } from "../src/store.ts";
import type { TranscriptEvent } from "../src/transcripts/types.ts";
import { HttpTransport } from "../src/transport/http.ts";
import type { Agent } from "../src/types.ts";
import { restoreEnv, until } from "./helpers.ts";
import { writeClaudeSub, writeClaudeTeam } from "./subagent-fixtures.ts";

/**
 * Subagents through the service and the app's API: kept apart from the
 * registry (never in /agents, selectors, `*`, counts), listed lazily, their
 * transcripts read with the parent's driver, live over SSE, and messaging
 * that never claims a delivery the harness can't make.
 */

const OWNER = "me@example.com";
const SESSION = "0000cccc-1111-4222-8333-444455556666";
const CWD = "/work/subs";
const dir = mkdtempSync(join(tmpdir(), "pulsar-subagents-svc-"));
const savedConfig = process.env.CLAUDE_CONFIG_DIR;
let store: Store;
let service: PulsarService;
let http: HttpTransport;
let base: string;
let lead: Agent;
let sessionDir: string;

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

beforeAll(async () => {
	process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
	store = new Store(join(dir, "pulsar.db"));
	service = new PulsarService({
		store,
		scan: false,
		machine: "studio",
		transcripts: { pollMs: 20 },
	});
	http = new HttpTransport(service, {
		identity: new StaticIdentity(OWNER, "phone"),
		owner: OWNER,
		hosts: ["127.0.0.1"],
		port: 0,
		webRoot: null,
		hub: { coalesceMs: 30 },
	});
	await http.listen();
	base = `http://127.0.0.1:${http.port}`;
	service.start();
	lead = service.registry.upsert({
		harness: "claude",
		sessionId: SESSION,
		pid: null,
		cwd: CWD,
		project: "subs",
		branch: "main",
		tags: ["project:subs"],
		name: "lead",
		meta: {},
		registered: false,
		status: "busy",
	});
	sessionDir = claudeSessionDir(CWD, SESSION)!;
	const now = Date.now();
	writeClaudeSub(
		sessionDir,
		"a1",
		{
			agentType: "Explore",
			description: "Map the code",
			toolUseId: "toolu_a1",
			finished: true,
		},
		{ mtime: now - 30_000 },
	);
	writeClaudeSub(
		sessionDir,
		"a2",
		{
			agentType: "general-purpose",
			description: "Write tests",
			toolUseId: "toolu_a2",
		},
		{ mtime: now },
	);
});

afterAll(async () => {
	await http.close();
	service.stop();
	store.close();
	restoreEnv("CLAUDE_CONFIG_DIR", savedConfig);
	rmSync(dir, { recursive: true, force: true });
});

describe("subagents are not agents", () => {
	test("not in /agents, selectors, `*`, broadcasts or counts", async () => {
		await service.subagents.refresh(lead.id);
		expect(service.subagents.counts(lead.id)).toEqual({
			total: 2,
			running: 1,
			done: 1,
		});
		const page = (await (await api("/api/v1/agents")).json()) as AgentsPage;
		expect(page.items.map((a) => a.id)).toEqual([lead.id]);
		expect(page.total).toBe(1);
		const all = service.registry.resolvePool("*", lead);
		expect(all.some((a) => a.id.includes("/sub:"))).toBe(false);
		expect(
			service.app.views.matching("harness=claude").map((r) => r.id),
		).toEqual([lead.id]);
		const tree = (await (await api("/api/v1/tree")).json()) as {
			items: TreeNode[];
		};
		expect(tree.items[0]?.rollup?.agents).toBe(1);
		const hello = (await (await api("/api/v1/hello")).json()) as {
			agents: number;
			features: string[];
		};
		expect(hello.agents).toBe(1);
		expect(hello.features).toContain("subagents");
		// A subagent id is not an agent.
		const sub = `${lead.id}/sub:a1`;
		expect((await api(`/api/v1/agents/${enc(sub)}`)).status).toBe(404);
		// A broadcast reaches the lead only.
		const sent = (await (
			await api("/api/v1/send", {
				method: "POST",
				body: JSON.stringify({ to: "*", body: "hello all" }),
			})
		).json()) as { receipts: Array<{ agentId: string }> };
		expect(sent.receipts.map((r) => r.agentId)).toEqual([lead.id]);
	});

	test("the agent row carries counts once found", async () => {
		const row = (await (
			await api(`/api/v1/agents/${enc(lead.id)}`)
		).json()) as AgentRow;
		expect(row.subagents).toEqual({ total: 2, running: 1, done: 1 });
	});
});

describe("listing", () => {
	test("GET /agents/:id/subagents lists newest first, with messaging", async () => {
		const res = await api(`/api/v1/agents/${enc(lead.id)}/subagents`);
		expect(res.status).toBe(200);
		const list = (await res.json()) as SubagentList;
		expect(list.agentId).toBe(lead.id);
		expect(list.total).toBe(2);
		expect(list.running).toBe(1);
		const a1 = list.items.find((i) => i.id === `${lead.id}/sub:a1`)!;
		expect(a1).toMatchObject({
			parentId: lead.id,
			name: "Map the code",
			harness: "claude",
			kind: "task",
			state: "done",
			callId: "toolu_a1",
			hasTranscript: true,
		});
		expect(a1.messaging.mode).toBe("parent");
		expect(a1.messaging.note).toContain("Claude Code subagents can't receive");
		expect(a1.messaging.note).toContain("lead");
	});

	test("GET /subagents/:id; unknown ids are 404", async () => {
		const one = (await (
			await api(`/api/v1/subagents/${enc(`${lead.id}/sub:a2`)}`)
		).json()) as SubagentRow;
		expect(one.name).toBe("Write tests");
		expect(
			(await api(`/api/v1/subagents/${enc(`${lead.id}/sub:nope`)}`)).status,
		).toBe(404);
		expect((await api("/api/v1/agents/claude%3Anobody/subagents")).status).toBe(
			404,
		);
	});

	test("the sweep lists again only when the folder moved", async () => {
		const list = driverFor("claude")!.subagents!;
		const real = list.list;
		let calls = 0;
		list.list = (a) => {
			calls++;
			return real(a);
		};
		try {
			// a2 still runs: listed every sweep. Mark it finished first.
			writeClaudeSub(sessionDir, "a2", {
				agentType: "general-purpose",
				description: "Write tests",
				toolUseId: "toolu_a2",
				finished: true,
			});
			await service.subagents.refresh(lead.id);
			await service.subagents.sweep();
			calls = 0;
			await service.subagents.sweep();
			expect(calls).toBe(0);
			// A new subagent: the folder's mtime moves, the next sweep lists.
			writeClaudeSub(sessionDir, "a3", {
				agentType: "Plan",
				description: "Plan the work",
				toolUseId: "toolu_a3",
			});
			const t = (Date.now() + 3000) / 1000;
			utimesSync(join(sessionDir, "subagents"), t, t);
			await service.subagents.sweep();
			expect(calls).toBe(1);
			expect(service.subagents.counts(lead.id)).toEqual({
				total: 3,
				running: 1,
				done: 2,
			});
		} finally {
			list.list = real;
		}
	});
});

describe("dead subagents", () => {
	const SESSION2 = "0000dddd-1111-4222-8333-444455556666";
	let lead2: Agent;
	let dir2: string;

	beforeAll(() => {
		lead2 = service.registry.upsert({
			harness: "claude",
			sessionId: SESSION2,
			pid: null,
			cwd: CWD,
			project: "subs",
			branch: "main",
			tags: [],
			name: "lead2",
			meta: {},
			registered: false,
			status: "busy",
		});
		dir2 = claudeSessionDir(CWD, SESSION2)!;
		const now = Date.now();
		writeClaudeTeam(join(dir, "claude"), "team2", SESSION2, [
			{ name: "mate", joinedAt: now - 60 * 60_000 },
		]);
		writeClaudeSub(
			dir2,
			"m1",
			{
				agentType: "general-purpose",
				name: "mate",
				description: "Wait for work",
				taskKind: "in_process_teammate",
				teamName: "team2",
			},
			{
				mtime: now - 5 * 60_000,
				started: new Date(now - 50 * 60_000).toISOString(),
			},
		);
		// Finished two days ago: never listed or counted, still reachable.
		writeClaudeSub(
			dir2,
			"old1",
			{
				agentType: "Explore",
				description: "Long ago",
				toolUseId: "toolu_old",
				finished: true,
			},
			{
				mtime: now - DONE_KEEP_MS - 24 * 60 * 60_000,
				started: new Date(now - DONE_KEEP_MS - 25 * 3600_000).toISOString(),
			},
		);
		// Finished an hour ago: listed (with "Show finished") and counted as done.
		writeClaudeSub(
			dir2,
			"new1",
			{
				agentType: "Explore",
				description: "Recent",
				toolUseId: "toolu_new",
				finished: true,
			},
			{
				mtime: now - 60 * 60_000,
				started: new Date(now - 70 * 60_000).toISOString(),
			},
		);
	});

	test("finished more than a day ago: left out of lists and counts, still opens", async () => {
		await service.subagents.refresh(lead2.id);
		expect(service.subagents.counts(lead2.id)).toEqual({
			total: 2,
			running: 0,
			done: 1,
		});
		const list = (await (
			await api(`/api/v1/agents/${enc(lead2.id)}/subagents`)
		).json()) as SubagentList;
		expect(list.items.map((i) => i.id.split("/sub:")[1]).sort()).toEqual([
			"m1",
			"new1",
		]);
		// Its transcript card still opens it.
		const old = (await (
			await api(`/api/v1/subagents/${enc(`${lead2.id}/sub:old1`)}`)
		).json()) as SubagentRow;
		expect(old).toMatchObject({ name: "Long ago", state: "done" });
		expect(service.subagents.agentFor(`${lead2.id}/sub:old1`)).toBeTruthy();
	});

	test("a teammate shut down while idle turns done on the next sweep", async () => {
		await service.subagents.refresh(lead2.id);
		expect(
			service.subagents.cached(lead2.id).find((r) => r.id.endsWith(":m1"))
				?.state,
		).toBe("idle");
		// The lead stops it: Claude drops it from the team config. The
		// subagents folder does not change.
		writeClaudeTeam(join(dir, "claude"), "team2", SESSION2, [], {
			mtime: Date.now() + 5000,
		});
		const real = service.subagents.now;
		service.subagents.now = () => Date.now() + 60_000;
		try {
			await service.subagents.sweep();
		} finally {
			service.subagents.now = real;
		}
		expect(service.subagents.counts(lead2.id)).toEqual({
			total: 2,
			running: 0,
			done: 2,
		});
	});

	test("a gone parent's subagents are all done on the next sweep", async () => {
		// Alive again in its team, then the parent session ends.
		writeClaudeTeam(
			join(dir, "claude"),
			"team2",
			SESSION2,
			[{ name: "mate", joinedAt: Date.now() - 60 * 60_000 }],
			{ mtime: Date.now() + 10_000 },
		);
		await service.subagents.refresh(lead2.id);
		expect(service.subagents.counts(lead2.id)?.done).toBe(1);
		service.registry.get(lead2.id)!.status = "gone";
		try {
			await service.subagents.sweep();
			expect(service.subagents.counts(lead2.id)).toEqual({
				total: 2,
				running: 0,
				done: 2,
			});
			// Listing it again (someone opens it) keeps them done.
			await service.subagents.refresh(lead2.id);
			expect(service.subagents.counts(lead2.id)?.done).toBe(2);
		} finally {
			service.registry.get(lead2.id)!.status = "busy";
		}
	});
});

describe("the per-parent cap", () => {
	test("keeps a live subagent even under 200 newer finished ones", async () => {
		const SESSION3 = "0000eeee-1111-4222-8333-444455556666";
		const lead3 = service.registry.upsert({
			harness: "claude",
			sessionId: SESSION3,
			pid: null,
			cwd: CWD,
			project: "subs",
			branch: "main",
			tags: [],
			name: "lead3",
			meta: {},
			registered: false,
			status: "busy",
		});
		const dir3 = claudeSessionDir(CWD, SESSION3)!;
		const now = Date.now();
		writeClaudeSub(
			dir3,
			"live",
			{ agentType: "general-purpose", description: "Still going" },
			{ mtime: now, started: new Date(now - 3600_000).toISOString() },
		);
		for (let i = 0; i < 200; i++)
			writeClaudeSub(
				dir3,
				`f${i}`,
				{ agentType: "Explore", description: `F${i}`, finished: true },
				{ mtime: now - 60_000, started: new Date(now - 60_000).toISOString() },
			);
		await service.subagents.refresh(lead3.id);
		expect(service.subagents.counts(lead3.id)).toEqual({
			total: 200,
			running: 1,
			done: 199,
		});
	});
});

describe("transcripts", () => {
	test("a subagent's own log, without the sidechain mark", async () => {
		const res = await api(
			`/api/v1/agents/${enc(`${lead.id}/sub:a1`)}/transcript`,
		);
		expect(res.status).toBe(200);
		const page = (await res.json()) as {
			events: TranscriptEvent[];
			available: boolean;
		};
		expect(page.available).toBe(true);
		expect(page.events.map((e) => e.text)).toContain("done by a1");
		expect(page.events.some((e) => e.sidechain)).toBe(false);
	});

	test("a fresh daemon finds a subagent it has not listed yet", async () => {
		const store2 = new Store(join(dir, "pulsar2.db"));
		const svc2 = new PulsarService({
			store: store2,
			scan: false,
			machine: "studio",
		});
		try {
			const lead2 = svc2.registry.upsert({
				harness: "claude",
				sessionId: SESSION,
				pid: null,
				cwd: CWD,
				project: "subs",
				branch: "main",
				tags: [],
				meta: {},
				registered: false,
			});
			const page = await svc2.transcripts.page(`${lead2.id}/sub:a1`);
			expect(page.available).toBe(true);
			expect(page.events.map((e) => e.text)).toContain("done by a1");
			await expect(svc2.transcripts.page(`${lead2.id}/sub:zz`)).rejects.toThrow(
				/no agent/,
			);
		} finally {
			svc2.stop();
			store2.close();
		}
	});
});

describe("live over SSE", () => {
	test("a `subagents` topic sends the list, then what changed", async () => {
		const ac = new AbortController();
		const res = await fetch(`${base}/api/v1/events`, {
			headers: { "X-Pulsar": "1" },
			signal: ac.signal,
		});
		const events: Array<{ event: string; data: Record<string, unknown> }> = [];
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
						let event = "";
						let data: Record<string, unknown> = {};
						for (const l of buffer.slice(0, end).split("\n")) {
							if (l.startsWith("event: ")) event = l.slice(7);
							else if (l.startsWith("data: ")) data = JSON.parse(l.slice(6));
						}
						if (event) events.push({ event, data });
						buffer = buffer.slice(end + 2);
						end = buffer.indexOf("\n\n");
					}
				}
			} catch {}
		})();
		try {
			await until(() => events.some((e) => e.event === "ready"), 15_000);
			const streamId = events.find((e) => e.event === "ready")!.data
				.streamId as string;
			await api(`/api/v1/subscriptions/${streamId}`, {
				method: "PUT",
				body: JSON.stringify({ subagents: [lead.id] }),
			});
			await until(
				() =>
					events.some((e) => e.event === "subagents" && e.data.full === true),
				15_000,
			);
			const full = events.find((e) => e.event === "subagents")!.data;
			expect(full.agentId).toBe(lead.id);
			expect((full.items as SubagentRow[]).length).toBe(3);
			writeClaudeSub(sessionDir, "a4", {
				agentType: "Explore",
				description: "One more",
				toolUseId: "toolu_a4",
			});
			await service.subagents.refresh(lead.id);
			await until(
				() =>
					events.some(
						(e) =>
							e.event === "subagents" &&
							e.data.full === false &&
							(e.data.items as SubagentRow[]).some((i) =>
								i.id.endsWith("/sub:a4"),
							),
					),
				15_000,
			);
		} finally {
			ac.abort();
		}
	}, 30_000);
});

describe("messaging", () => {
	test("a Claude subagent can't take a message: refused with where it would go", async () => {
		const res = await api("/api/v1/send", {
			method: "POST",
			body: JSON.stringify({ ids: [`${lead.id}/sub:a1`], body: "status?" }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as {
			error: { code: string; message: string };
			parentId: string;
		};
		expect(body.error.code).toBe("subagent_unreachable");
		expect(body.error.message).toContain("goes to the parent agent");
		expect(body.parentId).toBe(lead.id);
	});

	test("viaParent sends it to the parent, naming the subagent", async () => {
		const res = await api("/api/v1/send", {
			method: "POST",
			body: JSON.stringify({
				ids: [`${lead.id}/sub:a1`],
				body: "status?",
				viaParent: true,
			}),
		});
		expect(res.status).toBe(200);
		const sent = (await res.json()) as {
			message: { body: string };
			receipts: Array<{ agentId: string }>;
		};
		expect(sent.receipts.map((r) => r.agentId)).toEqual([lead.id]);
		expect(sent.message.body).toBe(
			'For your subagent "Map the code" (a1): status?',
		);
	});

	test("a harness with a verified way in delivers to the subagent's own session", async () => {
		const oc = driverFor("opencode") as HarnessDriver;
		const sub = oc.subagents!;
		const realList = sub.list;
		const realDeliver = oc.push!.deliver;
		const delivered: Array<{ sessionId: string | null; text: string }> = [];
		const kid: FoundSubagent = {
			key: "ses_kid",
			name: "explore",
			kind: "session",
			agentType: "explore",
			description: null,
			state: "running",
			startedAt: 1,
			updatedAt: 2,
			finishedAt: null,
			callId: null,
			parentKey: null,
			sessionId: "ses_kid",
			file: null,
		};
		sub.list = async () => [kid];
		oc.push!.deliver = async (agent, text) => {
			delivered.push({ sessionId: agent.sessionId, text });
			return { ok: true, via: "opencode-api" };
		};
		try {
			const parent = service.registry.upsert({
				harness: "opencode",
				sessionId: "ses_parent",
				pid: null,
				cwd: "/work/oc",
				project: "oc",
				branch: null,
				tags: [],
				name: "oc-lead",
				meta: {},
				registered: false,
				status: "busy",
			});
			const id = `${parent.id}/sub:ses_kid`;
			const row = (await (
				await api(`/api/v1/subagents/${enc(id)}`)
			).json()) as SubagentRow;
			expect(row.messaging.mode).toBe("direct");
			const res = await api("/api/v1/send", {
				method: "POST",
				body: JSON.stringify({ ids: [id], body: "look at src/" }),
			});
			expect(res.status).toBe(200);
			const sent = (await res.json()) as {
				receipts: Array<{ agentId: string; state: string; via: string }>;
			};
			expect(sent.receipts[0]?.agentId).toBe(id);
			await until(() => delivered.length === 1, 15_000);
			expect(delivered[0]?.sessionId).toBe("ses_kid");
			expect(delivered[0]?.text).toContain("look at src/");
			// Still not an agent.
			expect(service.registry.get(id)).toBeUndefined();
			// A finished one: refused, not pretended.
			sub.list = async () => [{ ...kid, state: "done" }];
			await service.subagents.refresh(parent.id);
			const gone = await api("/api/v1/send", {
				method: "POST",
				body: JSON.stringify({ ids: [id], body: "again" }),
			});
			expect(gone.status).toBe(410);
		} finally {
			sub.list = realList;
			oc.push!.deliver = realDeliver;
		}
	});
});
