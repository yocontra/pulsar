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
import { Federation } from "../src/federation/index.ts";
import { PoolMembers } from "../src/federation/members.ts";
import { parsePi } from "../src/harnesses/pi-transcript.ts";
import type { PushPayload } from "../src/http/wire.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import type { Agent } from "../src/types.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { registration, until } from "./helpers.ts";
import { browser, decrypt } from "./push-crypto.ts";

/**
 * Finish/fail notifications across machines: the phone's subscription is on
 * node A (the node that served its app); the agent runs on node B. B decides
 * the turn and shares it in its agent feed; A notifies because the operator
 * messaged that agent through A. No app stream is open on either node (the
 * phone is asleep).
 */

setDefaultTimeout(20_000);

const OWNER = "me@example.com";
const tailnet = new FakeTailnet();

interface Node {
	name: string;
	dir: string;
	store: Store;
	service: PulsarService;
	http: HttpTransport;
	fed: Federation;
	sent: Array<{ headers: Record<string, string>; body: Uint8Array }>;
}

const nodes: Node[] = [];
/** Session logs on B by agent name (a failed turn reads one). */
const logs = new Map<string, string>();
const FAILED_LOG = join(
	import.meta.dir,
	"fixtures",
	"turns",
	"pi-failed.jsonl",
);

async function startNode(name: string): Promise<Node> {
	const dir = mkdtempSync(join(tmpdir(), `pulsar-notify-${name}-`));
	const store = new Store(join(dir, "pulsar.db"));
	const sent: Node["sent"] = [];
	const service = new PulsarService({
		store,
		scan: false,
		machine: name,
		approvals: { probe: () => null },
		push: {
			keyFile: join(dir, "vapid.json"),
			send: async (_url, init) => {
				sent.push({ headers: init.headers, body: init.body });
				return { status: 201 };
			},
		},
		turns: { graceMs: 30 },
		transcripts: {
			resolve: (agent) => {
				const path = logs.get(agent.name);
				return path ? { source: { kind: "file", path }, parse: parsePi } : null;
			},
		},
	});
	service.registry.idleSettleMs = 20;
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
		intervals: {
			discoverMs: 150,
			heartbeatMs: 200,
			missed: 5,
			coalesceMs: 30,
			linkIdleMs: 60_000,
			outboxTickMs: 40,
			receiptTickMs: 40,
			requestTimeoutMs: 2000,
		},
	});
	http.fed = fed;
	tailnet.serve(name, http.app, http.port, 7337);
	service.start();
	await fed.start();
	const n = { name, dir, store, service, http, fed, sent };
	nodes.push(n);
	return n;
}

function agent(n: Node, name: string): { agent: Agent; close: () => void } {
	const controller = new AbortController();
	const caller: Caller = {
		principal: { kind: "terminal" },
		closed: controller.signal,
		emit: () => {},
	};
	n.service.attach(caller);
	n.service.setRole(caller, "extension");
	const a = n.service.registerAgent(
		caller,
		registration({ name, project: "api", cwd: "/work/api" }),
	);
	return { agent: a, close: () => controller.abort() };
}

let a: Node;
let b: Node;
const closers: Array<() => void> = [];
const phone = browser();

beforeAll(async () => {
	for (const name of ["a", "b", "phone"]) tailnet.add(name);
	a = await startNode("a");
	b = await startNode("b");
	const x = agent(b, "builder");
	const y = agent(b, "bystander");
	closers.push(x.close, y.close);
	for (const n of [a, b]) await n.fed.discover();
	await until(() => a.service.registry.remoteAgents().length === 2, 5000);
	// The phone subscribed on A (the app A served).
	const operator = { kind: "human" as const, login: OWNER, node: "phone" };
	a.service.push.subscribe(operator, {
		endpoint: "https://web.push.apple.com/phone",
		keys: phone.keys,
	});
	// Its app sent the device's choice: "Notifications only".
	a.service.push.settings(operator, {
		endpoint: "https://web.push.apple.com/phone",
		turns: "notify",
	});
	await until(() => a.sent.length >= 1, 2000); // "notifications turned on"
	await new Promise((r) => setTimeout(r, 30));
	a.sent.length = 0;
});

afterAll(async () => {
	for (const c of closers) c();
	for (const n of nodes) {
		n.fed.stop();
		n.service.stop();
		await n.http.close();
		n.store.close();
		rmSync(n.dir, { recursive: true, force: true });
	}
});

const addressOn = (n: Node, name: string) =>
	n.service.registry.remoteAgents().find((x) => x.name.startsWith(name))!.id;

describe("finish and fail notifications across machines", () => {
	test("a finish on B reaches the phone subscribed on A, for the agent the operator messaged through A", async () => {
		const target = addressOn(a, "builder");
		const bystander = addressOn(a, "bystander");
		expect(target).toContain("/");
		// The operator messages the agent from A's app.
		const res = await tailnet.request("phone", "a", "/api/v1/send", {
			method: "POST",
			headers: { "X-Pulsar": "1", "Content-Type": "application/json" },
			body: JSON.stringify({ ids: [target], body: "ship it" }),
		});
		expect(res.status).toBe(200);
		expect(a.service.interest.has(target)).toBe(true);
		expect(a.service.interest.has(bystander)).toBe(false);

		// Both agents on B work, then end their turns.
		const home = (name: string) =>
			b.service.registry.live().find((x) => x.name === name)!;
		for (const name of ["builder", "bystander"]) {
			b.service.registry.setStatus(home(name), "busy");
			b.service.registry.setStatus(home(name), "idle");
		}
		await until(() => a.sent.length >= 1, 5000);
		await new Promise((r) => setTimeout(r, 300));
		// One push, for the agent the operator cares about; B has no subscription.
		expect(a.sent).toHaveLength(1);
		expect(b.sent).toHaveLength(0);
		expect(a.sent[0]!.headers.Topic).toBe("finished");
		const payload = JSON.parse(
			decrypt(Buffer.from(a.sent[0]!.body), phone.priv, phone.auth).toString(),
		) as PushPayload;
		expect(payload).toEqual({ kind: "finished", ref: expect.any(String) });
		// Tapping it on the phone opens the agent on B, through A.
		const opened = await tailnet.request(
			"phone",
			"a",
			`/api/v1/push/turns/${(payload as { ref: string }).ref}`,
			{ headers: { "X-Pulsar": "1" } },
		);
		expect(await opened.json()).toEqual({ agentId: target });
	});

	test("a failure on B is a failed push; a replayed record does not push again", async () => {
		a.sent.length = 0;
		const target = addressOn(a, "builder");
		const builder = b.service.registry
			.live()
			.find((x) => x.name === "builder")!;
		// The turn ends with an API error in the agent's own log on B.
		logs.set("builder", FAILED_LOG);
		b.service.registry.setStatus(builder, "busy");
		b.service.registry.setStatus(builder, "idle");
		await until(() => a.sent.length >= 1, 5000);
		const payload = JSON.parse(
			decrypt(Buffer.from(a.sent[0]!.body), phone.priv, phone.auth).toString(),
		) as PushPayload;
		expect(payload).toMatchObject({ kind: "failed" });
		expect(
			a.service.push.turnAgent(
				{ kind: "human", login: OWNER, node: "phone" },
				(payload as { ref: string }).ref,
			),
		).toEqual({ agentId: target });
		expect(a.sent[0]!.headers.Topic).toBe("failed");
		// B's feed publishes again (any change): the same turn stays one push.
		b.service.registry.setStatus(builder, "busy");
		await new Promise((r) => setTimeout(r, 200));
		b.service.registry.setStatus(builder, "gone");
		await new Promise((r) => setTimeout(r, 400));
		expect(a.sent).toHaveLength(1);
	});
});
