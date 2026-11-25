import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Federation,
	type FederationIntervals,
} from "../src/federation/index.ts";
import { PoolMembers } from "../src/federation/members.ts";
import { cleanSubagentList } from "../src/federation/subagents.ts";
import { claudeSessionDir } from "../src/harnesses/claude-subagents.ts";
import { driverFor } from "../src/harnesses/index.ts";
import type { FoundSubagent, HarnessDriver } from "../src/harnesses/types.ts";
import type { AgentRow, SubagentList, SubagentRow } from "../src/http/wire.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import type { TranscriptEvent } from "../src/transcripts/types.ts";
import { HttpTransport } from "../src/transport/http.ts";
import type { Agent, Message } from "../src/types.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { registration, restoreEnv, until } from "./helpers.ts";
import { writeClaudeSub } from "./subagent-fixtures.ts";

/**
 * Subagents across the pool, on an in-process fake tailnet: counts ride on
 * the home node's agent records, the list and transcripts are read through
 * the home node, ids become pool addresses, and a peer's answer is checked.
 */

setDefaultTimeout(20_000);

const OWNER = "me@example.com";
const SESSION = "0000eeee-1111-4222-8333-444455556666";
const CWD = "/work/fed-subs";
const FAST: Partial<FederationIntervals> = {
	discoverMs: 150,
	heartbeatMs: 200,
	missed: 5,
	coalesceMs: 30,
	linkIdleMs: 60_000,
	outboxTickMs: 40,
	receiptTickMs: 40,
	requestTimeoutMs: 2000,
};

interface Node {
	name: string;
	dir: string;
	store: Store;
	service: PulsarService;
	http: HttpTransport;
	fed: Federation;
}

const tailnet = new FakeTailnet();
const nodes: Node[] = [];
const root = mkdtempSync(join(tmpdir(), "pulsar-subagents-fed-"));
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

async function startNode(name: string): Promise<Node> {
	const dir = mkdtempSync(join(root, `${name}-`));
	const store = new Store(join(dir, "pulsar.db"));
	const service = new PulsarService({
		store,
		scan: false,
		machine: name,
		push: { keyFile: join(dir, "vapid.json") },
		approvals: { probe: () => null },
		transcripts: { pollMs: 20 },
	});
	const http = new HttpTransport(service, {
		identity: tailnet.identity,
		owner: OWNER,
		hosts: ["127.0.0.1"],
		port: 0,
		webRoot: null,
		hub: { coalesceMs: 30 },
	});
	await http.listen();
	const fed = new Federation(service, {
		tailnet: tailnet.view(name),
		members: new PoolMembers(null),
		intervals: FAST,
	});
	http.fed = fed;
	tailnet.serve(name, http.app, http.port, 7337);
	service.start();
	await fed.start();
	const node = { name, dir, store, service, http, fed };
	nodes.push(node);
	return node;
}

async function api<T>(to: string, path: string) {
	const res = await tailnet.request("phone", to, `/api/v1${path}`, {
		headers: { "X-Pulsar": "1" },
	});
	return { status: res.status, body: (await res.json()) as T };
}

const enc = encodeURIComponent;
let home: Node;
let viewer: Node;
let lead: Agent;
let address: string;

beforeAll(async () => {
	process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
	for (const n of ["home", "viewer", "phone"]) tailnet.add(n);
	home = await startNode("home");
	viewer = await startNode("viewer");
	lead = home.service.registry.upsert({
		harness: "claude",
		sessionId: SESSION,
		pid: null,
		cwd: CWD,
		project: "fed-subs",
		branch: "main",
		tags: [],
		name: "lead",
		meta: {},
		registered: false,
		status: "busy",
	});
	const dir = claudeSessionDir(CWD, SESSION)!;
	writeClaudeSub(dir, "f1", {
		agentType: "Explore",
		description: "Survey",
		toolUseId: "toolu_f1",
		finished: true,
	});
	writeClaudeSub(dir, "f2", {
		agentType: "Explore",
		description: "Nested",
		toolUseId: "toolu_f2",
		parentAgentId: "f1",
	});
	await home.service.subagents.refresh(lead.id);
	for (const n of nodes) await n.fed.discover();
	address = `${home.service.machineId}/${lead.id}`;
	await until(() => Boolean(viewer.service.registry.find(address)), 5000);
});

afterAll(async () => {
	for (const n of nodes) {
		n.fed.stop();
		n.service.stop();
		await n.http.close();
		n.store.close();
	}
	restoreEnv("CLAUDE_CONFIG_DIR", savedConfig);
	rmSync(root, { recursive: true, force: true });
});

describe("subagents across the pool", () => {
	test("counts ride on the remote agent's row", async () => {
		await until(
			() =>
				viewer.service.app.views.row(viewer.service.registry.find(address)!)
					.subagents?.total === 2,
			5000,
		);
		const r = await api<AgentRow>("viewer", `/agents/${enc(address)}`);
		expect(r.body.subagents).toEqual({ total: 2, running: 1, done: 1 });
	});

	test("the list comes from the home node, with pool addresses", async () => {
		const r = await api<SubagentList>(
			"viewer",
			`/agents/${enc(address)}/subagents`,
		);
		expect(r.status).toBe(200);
		expect(r.body.agentId).toBe(address);
		const ids = r.body.items.map((i) => i.id).sort();
		expect(ids).toEqual([`${address}/sub:f1`, `${address}/sub:f2`]);
		const f2 = r.body.items.find((i) => i.id.endsWith("f2"))!;
		expect(f2.parentId).toBe(address);
		expect(f2.parentSubId).toBe(`${address}/sub:f1`);
		expect(f2.messaging.mode).toBe("parent");
		const one = await api<SubagentRow>(
			"viewer",
			`/subagents/${enc(`${address}/sub:f1`)}`,
		);
		expect(one.body.name).toBe("Survey");
	});

	test("a remote subagent's transcript is read through its home node", async () => {
		const r = await api<{ events: TranscriptEvent[]; available: boolean }>(
			"viewer",
			`/agents/${enc(`${address}/sub:f1`)}/transcript`,
		);
		expect(r.status).toBe(200);
		expect(r.body.available).toBe(true);
		expect(r.body.events.map((e) => e.text)).toContain("done by f1");
		const missing = await api(
			"viewer",
			`/agents/${enc(`${address}/sub:nope`)}/transcript`,
		);
		expect(missing.status).toBe(404);
	});

	test("a message to a remote direct subagent reaches it through its home node", async () => {
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
			const parent = home.service.registry.upsert({
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
			await home.service.subagents.refresh(parent.id);
			const parentAddress = `${home.service.machineId}/${parent.id}`;
			await until(
				() => Boolean(viewer.service.registry.find(parentAddress)),
				5000,
			);
			const id = `${parentAddress}/sub:ses_kid`;
			const duplicate = home.service.registry.upsert({
				...parent,
				sessionId: "ses_kid",
				name: "explore",
			});
			await until(() => Boolean(viewer.service.registry.find(id)), 5000);
			expect(
				viewer.service.registry.find(
					`${home.service.machineId}/${duplicate.id}`,
				),
			).toBeUndefined();
			const sender = viewer.service.registry.operator();
			expect(
				viewer.service.registry
					.list("name=explore project=oc")
					.map((agent) => agent.id),
			).toEqual([id]);
			const peerSend = await viewer.service.mailbox.send(sender, {
				to: "name=explore project=oc",
				body: "peer selector fixture",
				priority: "normal",
				replyTo: null,
				expectReply: false,
			});
			expect(peerSend.receipts.map((receipt) => receipt.agentId)).toEqual([id]);
			await until(() => delivered.length === 1, 5000);
			const row = await api<SubagentRow>("viewer", `/subagents/${enc(id)}`);
			expect(row.body.messaging.mode).toBe("direct");
			const res = await tailnet.request("phone", "viewer", "/api/v1/send", {
				method: "POST",
				headers: { "X-Pulsar": "1", "content-type": "application/json" },
				body: JSON.stringify({ ids: [id], body: "look at src/" }),
			});
			expect(res.status).toBe(200);
			const sent = (await res.json()) as { message: { id: string } };
			await until(() => delivered.length === 2, 5000);
			expect(delivered.every((push) => push.sessionId === "ses_kid")).toBe(
				true,
			);
			// The sender learns it landed.
			await until(
				() =>
					viewer.store
						.receiptsFor(sent.message.id)
						.some((r) => r.agentId === id && r.state === "sent"),
				5000,
			);
		} finally {
			sub.list = realList;
			oc.push!.deliver = realDeliver;
		}
	});

	test("OMP child addresses work in both directions between peer agents", async () => {
		const oldHome = process.env.HOME;
		process.env.HOME = root;
		const closing = new AbortController();
		const push: Message[] = [];
		const childCaller: Caller = {
			principal: { kind: "terminal" },
			closed: closing.signal,
			emit(event, data) {
				if (event === "push") push.push((data as { message: Message }).message);
			},
		};
		try {
			const cwd = join(root, "omp-work");
			const parentLog = join(
				root,
				".omp",
				"agent",
				"sessions",
				"-omp-work",
				`2026-11-10T10-00-00-000Z_${SESSION}.jsonl`,
			);
			const childDir = parentLog.slice(0, -".jsonl".length);
			const childLog = join(childDir, "Review.jsonl");
			mkdirSync(childDir, { recursive: true });
			writeFileSync(parentLog, "{}\n");
			writeFileSync(
				childLog,
				`${JSON.stringify({ type: "session", id: "child-uuid", parentSession: parentLog })}\n`,
			);
			const pid = process.pid;
			const reg = registration({
				harness: "omp",
				pid,
				cwd,
				project: "omp-peer",
				resumeKey: `omp:${SESSION}`,
			});
			home.service.registry.upsert({
				...reg,
				meta: { resumeKey: reg.resumeKey! },
				registered: true,
				status: "busy",
			});
			home.service.attach(childCaller);
			home.service.setRole(childCaller, "extension");
			const child = await home.service.registerOmpChild(childCaller, {
				...reg,
				subagent: { file: childLog, key: "Review" },
			});
			const sender = viewer.service.registry.upsert({
				...registration({ name: "review-sender" }),
				meta: {},
				registered: true,
				status: "idle",
			});
			const remoteChild = `${home.service.machineId}/${child.id}`;
			await until(
				() => Boolean(viewer.service.registry.find(remoteChild)),
				5000,
			);
			await until(
				() =>
					Boolean(
						home.service.registry.find(
							`${viewer.service.machineId}/${sender.id}`,
						),
					),
				5000,
			);
			expect(
				viewer.service.registry
					.remoteAgents()
					.some((a) => a.id === remoteChild),
			).toBe(false);
			expect(
				viewer.service.registry
					.resolvePool("name=Review project=omp-peer", sender)
					.map((a) => a.id),
			).toEqual([remoteChild]);
			const sent = await viewer.service.mailbox.send(sender, {
				to: remoteChild,
				body: "fixture peer request",
				priority: "normal",
				replyTo: null,
				expectReply: true,
			});
			await until(() => push.length === 1, 5000);
			expect(push[0]?.id).toBe(sent.message.id);
			expect(push[0]?.fromId).toBe(`${viewer.service.machineId}/${sender.id}`);
			const reply = await home.service.mailbox.reply(
				child,
				sent.message.id,
				"fixture peer reply",
				"normal",
			);
			await until(
				() => Boolean(viewer.store.getMessage(reply.message.id)),
				5000,
			);
			expect(viewer.store.getMessage(reply.message.id)).toMatchObject({
				fromId: remoteChild,
				replyTo: sent.message.id,
			});
		} finally {
			closing.abort();
			restoreEnv("HOME", oldHome);
		}
	});

	test("a peer's list is checked: only that parent's subagents, bounded", () => {
		const list = cleanSubagentList(
			{
				items: [
					{
						id: "claude:x/sub:k1",
						name: "o\u202ek\u0007",
						state: "running",
						kind: "task",
						color: "cyan",
					},
					{ id: "claude:other/sub:k2", name: "not this parent" },
					{ id: "claude:x/sub:a/b", name: "bad key" },
					{
						id: "claude:x/sub:k3",
						name: "x".repeat(500),
						state: "weird",
						kind: "?",
						color: "url(x)",
					},
					"junk",
				],
			},
			"m1",
			"claude:x",
		);
		expect(list.items.map((i) => i.id)).toEqual([
			"m1/claude:x/sub:k1",
			"m1/claude:x/sub:k3",
		]);
		// Peer strings are cleaned like every other: no control or bidi characters.
		expect(list.items[0]!.name).toBe("ok");
		expect(list.items[1]!.name.length).toBe(80);
		expect(list.items[1]!.state).toBe("done");
		expect(list.items[1]!.kind).toBe("task");
		// A color is one of the teammate names, or none.
		expect(list.items[0]!.color).toBe("cyan");
		expect(list.items[1]!.color).toBeNull();
		expect(list.running).toBe(1);
	});
});
