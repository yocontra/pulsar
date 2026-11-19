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
import { RemoteUsage } from "../src/federation/usage.ts";
import type { AgentUsage, UsageReport } from "../src/http/wire.ts";
import { RpcError } from "../src/rpc.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { until } from "./helpers.ts";
import { claudeLine, codexLines, rootsIn, write } from "./usage-fixtures.ts";

/**
 * Usage across the pool on an in-process fake tailnet: the viewer sums its
 * own tokens and the home node's (asked as the user), prices them with its
 * own table, and reads a remote agent's usage through its home node.
 */

setDefaultTimeout(20_000);

const OWNER = "me@example.com";
const THREAD = "01a1f571-f1a7-7a12-a14d-b85976acaa63";
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
const HOUR = 3_600_000;
const T = Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR + 60_000;

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
const root = mkdtempSync(join(tmpdir(), "pulsar-usage-fed-"));

async function startNode(name: string): Promise<Node> {
	const dir = mkdtempSync(join(root, `${name}-`));
	const store = new Store(join(dir, "pulsar.db"));
	const service = new PulsarService({
		store,
		scan: false,
		machine: name,
		push: { keyFile: join(dir, "vapid.json") },
		approvals: { probe: () => null },
		usage: { roots: () => rootsIn(dir), scan: false },
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

async function api<T>(to: string, path: string, init: RequestInit = {}) {
	const res = await tailnet.request("phone", to, `/api/v1${path}`, {
		...init,
		headers: { "X-Pulsar": "1", "Content-Type": "application/json" },
	});
	return { status: res.status, body: (await res.json()) as T };
}

const enc = encodeURIComponent;
let home: Node;
let viewer: Node;
let address: string;

beforeAll(async () => {
	for (const n of ["home", "viewer", "phone"]) tailnet.add(n);
	home = await startNode("home");
	viewer = await startNode("viewer");
	const day = new Date(T).toISOString().slice(0, 10).split("-");
	write(
		join(home.dir, "codex", "sessions", ...day, `rollout-x-${THREAD}.jsonl`),
		codexLines(T, "claude-sonnet-5-5", [[1_000_000, 0, 0]], 200_000),
	);
	write(join(viewer.dir, "claude", "projects", "-w", "v1.jsonl"), [
		claudeLine({ id: "msg_v", t: T, input: 1_000_000, output: 0 }),
	]);
	await home.service.usage.scanner.scan();
	await viewer.service.usage.scanner.scan();
	const agent = home.service.registry.upsert({
		harness: "codex",
		sessionId: THREAD,
		pid: null,
		cwd: "/work/api",
		project: "api",
		branch: "main",
		tags: [],
		name: "api",
		meta: {},
		registered: false,
		status: "busy",
	});
	for (const n of nodes) await n.fed.discover();
	address = `${home.service.machineId}/${agent.id}`;
	await until(() => Boolean(viewer.service.registry.find(address)), 5000);
});

afterAll(async () => {
	for (const n of nodes) {
		n.fed.stop();
		n.service.stop();
		await n.http.close();
		n.store.close();
	}
	rmSync(root, { recursive: true, force: true });
});

describe("usage across the pool", () => {
	test("GET /usage sums every machine and prices it on the viewing node", async () => {
		const r = await api<UsageReport>("viewer", "/usage?period=7d&tz=0");
		expect(r.status).toBe(200);
		expect(r.body.machines.map((m) => [m.name, m.error])).toEqual([
			["viewer", null],
			["home", null],
		]);
		const byMachine = Object.fromEntries(
			r.body.rows.map((x) => [x.machine, x]),
		);
		expect(byMachine[home.service.machineId]).toMatchObject({
			harness: "codex",
			model: "claude-sonnet-5-5",
			input: 1_000_000,
		});
		expect(byMachine[home.service.machineId]!.cost).toBeCloseTo(2, 6);
		expect(byMachine[viewer.service.machineId]!.cost).toBeCloseTo(4, 6);
		expect(r.body.sessions).toContainEqual({
			machine: home.service.machineId,
			harness: "codex",
			count: 1,
		});
		expect(r.body.bucket).toBe("day");
	});

	test("a price edited on the viewer applies to the home node's tokens", async () => {
		const put = await api<{ prices: unknown[] }>("viewer", "/usage/prices", {
			method: "PUT",
			body: JSON.stringify({
				model: "claude-sonnet-5-5",
				price: {
					input: 3,
					output: 0,
					cacheRead: 0,
					cacheWrite5m: 0,
					cacheWrite1h: 0,
				},
			}),
		});
		expect(put.status).toBe(200);
		const r = await api<UsageReport>("viewer", "/usage?period=24h");
		const row = r.body.rows.find((x) => x.machine === home.service.machineId);
		expect(row!.cost).toBeCloseTo(3, 6);
		expect(r.body.bucket).toBe("hour");
		const bad = await api("viewer", "/usage/prices", {
			method: "PUT",
			body: JSON.stringify({ model: "x", price: { input: -1 } }),
		});
		expect(bad.status).toBe(400);
		await api("viewer", "/usage/prices", {
			method: "PUT",
			body: JSON.stringify({ model: "claude-sonnet-5-5", price: null }),
		});
	});

	test("a remote agent's usage and context come from its home node", async () => {
		const r = await api<AgentUsage>("viewer", `/agents/${enc(address)}/usage`);
		expect(r.status).toBe(200);
		expect(r.body.agent).toBe(address);
		expect(r.body.tokens.input).toBe(1_000_000);
		expect(r.body.cost).toBeCloseTo(2, 6);
		expect(r.body.context).toEqual({ used: 1_000_000, window: 200_000 });
	});

	test("bad periods are refused", async () => {
		const r = await api("viewer", "/usage?period=1y");
		expect(r.status).toBe(400);
	});
});

describe("remote usage errors", () => {
	const machine = (link: string, reason?: string) => ({
		machineId: "m9",
		name: "old",
		link,
		agents: 0,
		...(reason ? { reason } : {}),
	});

	test("an offline machine is listed with its reason, without asking it", async () => {
		const fed = {
			machines: () => [machine("offline", "asleep 14m")],
			act: async () => {
				throw new Error("must not ask");
			},
		} as unknown as Federation;
		expect(await new RemoteUsage(fed).usage("7d", 0)).toEqual([
			{ machineId: "m9", name: "old", usage: null, error: "asleep 14m" },
		]);
	});

	test("an older node that does not know the op asks for an upgrade", async () => {
		const fed = {
			machines: () => [machine("tailnet")],
			act: async () => {
				throw new RpcError("unsupported", "unknown action usage.rows");
			},
		} as unknown as Federation;
		const [r] = await new RemoteUsage(fed).usage("7d", 0);
		expect(r!.error).toBe("upgrade pulsar on old");
	});
});
