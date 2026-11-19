/**
 * Durable delivery across machines (docs/delivery.md, "Across machines").
 * The home node owns redelivery; the sender's node only sees receipts.
 */
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Federation,
	type FederationIntervals,
} from "../src/federation/index.ts";
import { PoolMembers } from "../src/federation/members.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import type { DeliveredMessage, Receipt } from "../src/types.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { registration, until } from "./helpers.ts";

setDefaultTimeout(20_000);

const OWNER = "me@example.com";
const INTERVALS: Partial<FederationIntervals> = {
	discoverMs: 150,
	heartbeatMs: 200,
	missed: 5,
	coalesceMs: 30,
	linkIdleMs: 60_000,
	outboxTickMs: 40,
	receiptTickMs: 40,
	requestTimeoutMs: 2000,
};
const DELIVERY = {
	tickMs: 25,
	ackTimeoutMs: 300,
	leaseMs: 400,
	backoffMs: 50,
	maxAttempts: 3,
	/** Short, so a session that never returns expires within a test. */
	ttlMs: 4000,
};

type Tracked = Omit<Receipt, "state"> & {
	state: string;
	attempt?: number;
	result?: string | null;
};
type WaitResult = { event: string; message?: DeliveredMessage };

const tailnet = new FakeTailnet();
const nodes: Node[] = [];

interface Node {
	name: string;
	dir: string;
	store: Store;
	service: PulsarService;
	http: HttpTransport;
	fed: Federation;
}

/** One node. `features` overrides hello's feature list (an older peer). */
async function startNode(
	name: string,
	opts: { features?: string[] } = {},
): Promise<Node> {
	const dir = mkdtempSync(join(tmpdir(), `pulsar-dfed-${name}-`));
	const store = new Store(join(dir, "pulsar.db"));
	const service = new PulsarService({
		store,
		scan: false,
		machine: name,
		push: { keyFile: join(dir, "vapid.json") },
		approvals: { probe: () => null },
		delivery: DELIVERY,
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
	// `features`: a peer without `receipts2` (an older Pulsar).
	const fed = new Federation(service, {
		tailnet: tailnet.view(name),
		members: new PoolMembers(null),
		intervals: INTERVALS,
		...(opts.features ? { features: opts.features } : {}),
	});
	http.fed = fed;
	if (!tailnet.nodes.has(name)) tailnet.add(name);
	tailnet.serve(name, http.app, http.port, 7337);
	service.start();
	await fed.start();
	const node = { name, dir, store, service, http, fed };
	nodes.push(node);
	return node;
}

/** An extension-role agent on `n`; `close` ends its session. */
function agent(n: Node, name: string, sessionId: string, pid: number) {
	const controller = new AbortController();
	const pushes: Array<{ message: DeliveredMessage & { attempt?: number } }> =
		[];
	const caller: Caller = {
		principal: { kind: "terminal" },
		closed: controller.signal,
		emit: (event, data) => {
			if (event === "push")
				pushes.push(
					data as { message: DeliveredMessage & { attempt?: number } },
				);
		},
	};
	n.service.attach(caller);
	n.service.setRole(caller, "extension");
	const a = n.service.registerAgent(
		caller,
		registration({ name, sessionId, pid, project: "demo", cwd: "/work/demo" }),
	);
	return {
		agent: a,
		pushes,
		call: <T>(method: string, p: Record<string, unknown>) =>
			n.service.handle(caller, method, p) as Promise<T>,
		close: () => controller.abort(),
	};
}

let a: Node;
let b: Node;
let old: Node;

beforeAll(async () => {
	for (const name of ["a", "b", "old"]) tailnet.add(name);
	a = await startNode("a");
	b = await startNode("b");
	old = await startNode("old", {
		features: ["registry", "deliver", "receipts", "transcripts", "stop"],
	});
});

afterAll(async () => {
	for (const n of nodes.splice(0)) {
		n.fed.stop();
		n.service.stop();
		await n.http.close();
		n.store.close();
		rmSync(n.dir, { recursive: true, force: true });
	}
});

async function linked(from: Node, name: string) {
	await from.fed.discover();
	await until(
		() => from.service.registry.remoteAgents().some((x) => x.name === name),
		5000,
	);
	return from.service.registry.remoteAgents().find((x) => x.name === name)!;
}

const receiptOn = (n: Node, id: string) =>
	n.store.receiptsFor(id)[0] as unknown as Tracked | undefined;

describe("redelivery across machines", () => {
	test("B on another node restarts its session: its home node redelivers; A's ask gets the reply", async () => {
		const alpha = agent(a, "alpha", "s-alpha", 920_001);
		const bravo = agent(b, "bravo", "s-bravo", 920_101);
		const remote = await linked(a, "bravo");
		const sent = await alpha.call<{ message: { id: string } }>("send", {
			to: remote.name,
			body: "which port?",
			expectReply: true,
		});
		const id = sent.message.id;
		const waiting = alpha.call<WaitResult>("wait", {
			for: `reply:${id}`,
			timeoutSeconds: 10,
		});
		waiting.catch(() => {});
		await until(() => bravo.pushes.some((p) => p.message.id === id), 5000);
		bravo.close();
		// The receipt on A says why it waits.
		await until(() => /come back/.test(receiptOn(a, id)?.detail ?? ""), 5000);

		const bravo2 = agent(b, "bravo", "s-bravo", 920_102);
		await until(() => bravo2.pushes.some((p) => p.message.id === id), 5000);
		expect(bravo2.pushes[0]!.message.attempt).toBe(2);
		await until(() => receiptOn(a, id)?.attempt === 2, 5000);

		await bravo2.call("reply", { messageId: id, body: "8443" });
		const answer = await waiting;
		expect(answer.event).toBe("reply");
		expect(answer.message!.body).toBe("8443");
		await until(() => receiptOn(a, id)?.state === "replied", 5000);
		// The sender's outbox never pushed it again; only the home node did.
		expect(
			bravo.pushes.length +
				bravo2.pushes.filter((p) => p.message.id === id).length,
		).toBe(2);
		alpha.close();
		bravo2.close();
	});

	test("a dead letter on the home node comes back as `dead`; the origin settles the ask", async () => {
		const alpha = agent(a, "alpha2", "s-alpha2", 920_201);
		const quiet = agent(b, "quiet", "s-quiet", 920_301);
		const remote = await linked(a, "quiet");
		const sent = await alpha.call<{ message: { id: string } }>("send", {
			to: remote.name,
			body: "you there?",
			expectReply: true,
		});
		const id = sent.message.id;
		// Session gone for good: its tracked message expires or dies at home.
		await until(() => quiet.pushes.length === 1, 5000);
		quiet.close();
		const answer = await alpha.call<WaitResult>("wait", {
			for: `reply:${id}`,
			timeoutSeconds: 15,
		});
		expect(answer.event).toBe("dead");
		expect(["dead", "expired"]).toContain(receiptOn(a, id)!.state);
		alpha.close();
	});

	test("an older peer (no `receipts2`) gets new states mapped down", async () => {
		const sender = agent(old, "elder", "s-elder", 920_401);
		const worker = agent(b, "worker", "s-worker", 920_501);
		const remote = await linked(old, "worker");
		const sent = await sender.call<{ message: { id: string } }>("send", {
			to: remote.name,
			body: "take this on",
			expectReply: true,
		});
		const id = sent.message.id;
		await until(() => worker.pushes.some((p) => p.message.id === id), 5000);
		await worker.call("msg.ack", { messageId: id });
		await until(() => receiptOn(old, id)?.state === "read", 5000);
		await worker.call("msg.done", { messageId: id, result: "ok" });
		await until(() => receiptOn(old, id)?.state === "replied", 5000);
		sender.close();
		worker.close();
	});
});
