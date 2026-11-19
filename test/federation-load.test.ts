/**
 * Load test (opt in: `PULSAR_LOAD_TEST=1 bun test test/federation-load.test.ts`).
 *
 * One real node (service, HTTP transport, federation) linked to 299
 * simulated peers of 30 agents each (8,970 remote agents). The peers speak
 * `/fed/v1` (hello, digest, stream, deliver) in-process through the fake
 * tailnet; they are not full daemons, so this measures one node's view of a
 * 300-node pool, not 300 meshes. Prints timings.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Federation } from "../src/federation/index.ts";
import type { FedAgent } from "../src/federation/protocol.ts";
import { sseStream } from "../src/federation/sse.ts";
import type { AgentsPage, Page, TreeNode } from "../src/http/wire.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { until } from "./helpers.ts";

const RUN = process.env.PULSAR_LOAD_TEST === "1";
const PEERS = 299;
const PER_PEER = 30;
const OWNER = "me@example.com";
const PROJECTS = [
	"web",
	"api",
	"infra",
	"docs",
	"ml",
	"mobile",
	"data",
	"auth",
];
const HARNESSES = ["claude", "codex", "pi", "omp"];

setDefaultTimeout(120_000);

/** A peer that speaks the protocol from memory. */
class SimPeer {
	readonly machineId = `sim-${randomBytes(4).toString("hex")}`;
	bootId = randomBytes(4).toString("hex");
	seq = 1;
	agents = new Map<string, FedAgent>();
	listeners = new Set<(event: string, data: unknown) => void>();
	closers = new Set<() => void>();
	delivered = 0;
	batches = 0;
	readonly name: string;
	constructor(name: string) {
		this.name = name;
		for (let i = 0; i < PER_PEER; i++) {
			const id = `claude:${name}-${i}`;
			this.agents.set(id, {
				id,
				name: `${name}-agent-${i}`,
				harness: HARNESSES[i % HARNESSES.length]!,
				project: PROJECTS[(i + name.length) % PROJECTS.length]!,
				branch: i % 3 ? `feat-${i % 5}` : "main",
				machine: name,
				tags: [`machine:${name}`, ...(i % 10 === 0 ? ["role:reviewer"] : [])],
				status: i % 4 === 0 ? "busy" : "idle",
				model: i % 2 ? "claude-fable-5-2" : "gpt-5.5",
				activity: null,
				inbound: "accept",
				registered: true,
				reach: "push",
				lastSeen: Date.now(),
				createdAt: Date.now(),
				needsYou: null,
				wake: "wakes",
				hasTranscript: true,
			});
		}
	}

	digest() {
		return {
			machineId: this.machineId,
			bootId: this.bootId,
			seq: this.seq,
			agentCount: this.agents.size,
		};
	}

	/** Every agent flips busy/idle: one delta. */
	churn() {
		const upserts: FedAgent[] = [];
		for (const a of this.agents.values()) {
			a.status = a.status === "busy" ? "idle" : "busy";
			upserts.push({ ...a });
		}
		this.seq++;
		for (const fn of this.listeners)
			fn("delta", {
				type: "delta",
				bootId: this.bootId,
				seq: this.seq,
				upserts,
				removes: [],
			});
	}

	/** A restart: a new boot, open streams end. */
	restart() {
		this.bootId = randomBytes(4).toString("hex");
		this.seq = 1;
		for (const close of [...this.closers]) close();
	}

	readonly app = {
		fetch: async (req: Request): Promise<Response> => {
			const url = new URL(req.url);
			const json = (b: unknown) =>
				new Response(JSON.stringify(b), {
					headers: { "content-type": "application/json" },
				});
			if (url.pathname === "/fed/v1/hello")
				return json({
					fedProtocol: [1, 1],
					features: [],
					pulsarVersion: "sim",
					machineId: this.machineId,
					name: this.name,
				});
			if (url.pathname === "/fed/v1/frames") {
				const { frames } = (await req.json()) as {
					frames: Record<string, unknown>[];
				};
				return json({
					results: frames.map((f) => {
						if (f.type === "digest") return { ok: true, digest: this.digest() };
						if (f.type === "deliver") {
							const targets = f.targets as string[];
							this.batches++;
							this.delivered += targets.length;
							return {
								ok: true,
								receipts: targets.map((t) => ({
									agentId: t,
									agentName: t,
									state: "sent",
									via: "extension",
									detail: null,
									updatedAt: Date.now(),
								})),
							};
						}
						return { ok: true };
					}),
				});
			}
			if (url.pathname === "/fed/v1/stream") {
				let fn: ((e: string, d: unknown) => void) | null = null;
				let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
				const inner = sseStream((send) => {
					send("snapshot", {
						type: "snapshot",
						bootId: this.bootId,
						seq: this.seq,
						agents: [...this.agents.values()],
					});
					fn = (e, d) => send(e, d);
					this.listeners.add(fn);
					return () => {
						if (fn) this.listeners.delete(fn);
					};
				});
				const reader = inner.getReader();
				const close = () => {
					this.closers.delete(close);
					if (fn) this.listeners.delete(fn);
					try {
						ctl?.close();
					} catch {}
					void reader.cancel().catch(() => {});
				};
				this.closers.add(close);
				const body = new ReadableStream<Uint8Array>({
					start(c) {
						ctl = c;
					},
					async pull(c) {
						const r = await reader
							.read()
							.catch(() => ({ done: true, value: undefined }));
						if (r.done) {
							try {
								c.close();
							} catch {}
						} else c.enqueue(r.value!);
					},
					cancel: () => close(),
				});
				return new Response(body, {
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("{}", { status: 404 });
		},
	};
}

const tailnet = new FakeTailnet();
const sims: SimPeer[] = [];
let store: Store;
let service: PulsarService;
let http: HttpTransport;
let fed: Federation;
const timings: Record<string, string> = {};

function time<T>(label: string, fn: () => T): T {
	const t0 = performance.now();
	const r = fn();
	timings[label] = `${(performance.now() - t0).toFixed(1)} ms`;
	return r;
}

async function timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
	const t0 = performance.now();
	const r = await fn();
	timings[label] = `${(performance.now() - t0).toFixed(1)} ms`;
	return r;
}

async function api<T>(path: string, init: RequestInit = {}) {
	const res = await tailnet.request("phone", "hub", `/api/v1${path}`, {
		...init,
		headers: {
			"X-Pulsar": "1",
			...(init.body ? { "Content-Type": "application/json" } : {}),
		},
	});
	return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
	if (!RUN) return;
	tailnet.add("hub");
	tailnet.add("phone");
	for (let i = 0; i < PEERS; i++) {
		const sim = new SimPeer(`node${String(i).padStart(3, "0")}`);
		sims.push(sim);
		tailnet.add(sim.name);
		tailnet.serve(sim.name, sim.app);
	}
	store = new Store(":memory:");
	service = new PulsarService({ store, scan: false, machine: "hub" });
	for (let i = 0; i < 30; i++)
		service.registry.upsert({
			harness: "pi",
			sessionId: `local-${i}`,
			pid: null,
			cwd: "/work/web",
			project: "web",
			branch: "main",
			tags: [],
			meta: {},
			registered: false,
			status: "idle",
		});
	http = new HttpTransport(service, {
		identity: tailnet.identity,
		owner: OWNER,
		hosts: ["127.0.0.1"],
		port: 0,
		webRoot: null,
		hub: { coalesceMs: 60_000 },
	});
	await http.listen();
	fed = new Federation(service, {
		tailnet: tailnet.view("hub"),
		intervals: {
			discoverMs: 600_000,
			heartbeatMs: 5000,
			coalesceMs: 250,
			outboxTickMs: 200,
			requestTimeoutMs: 20_000,
			linkIdleMs: 600_000,
		},
	});
	http.fed = fed;
	tailnet.serve("hub", http.app, http.port);
});

afterAll(async () => {
	if (!RUN) return;
	fed.stop();
	service.stop();
	await http.close();
	store.close();
	console.log(
		`\nfederation load test: 1 node + ${PEERS} peers × ${PER_PEER} agents\n${Object.entries(
			timings,
		)
			.map(([k, v]) => `  ${k.padEnd(48)} ${v}`)
			.join("\n")}`,
	);
});

test.skipIf(!RUN)("links 299 peers and holds 8,970 remote agents", async () => {
	await timeAsync("discover + link + snapshots (299 peers)", async () => {
		await fed.start();
		await until(
			() => service.registry.remoteAgents().length === PEERS * PER_PEER,
			60_000,
		);
	});
	expect(fed.machines().filter((m) => m.link === "tailnet")).toHaveLength(
		PEERS,
	);
});

test.skipIf(!RUN)(
	"tree, facets, agents and search at 9,000 agents",
	async () => {
		const tree = await timeAsync("GET /tree?group=machines (first page)", () =>
			api<Page<TreeNode>>("/tree?group=machines&limit=50"),
		);
		expect(tree.body.total).toBe(PEERS + 1);
		expect(tree.body.items[0]!.label).toBe("hub");
		await timeAsync("GET /tree?group=projects", () =>
			api<Page<TreeNode>>("/tree?group=projects"),
		);
		const m = tree.body.items[1]!;
		await timeAsync("GET /tree/:machine/children", () =>
			api<Page<TreeNode>>(`/tree/${encodeURIComponent(m.id)}/children`),
		);
		const facets = await timeAsync("GET /facets (all facets)", () =>
			api<{ total: number }>("/facets"),
		);
		expect(facets.body.total).toBe(PEERS * PER_PEER + 30);
		await timeAsync("GET /facets?facet=machine&q=node1", () =>
			api<{ total: number }>("/facets?facet=machine&q=node1"),
		);
		const reviewers = await timeAsync(
			"GET /agents?selector=role=reviewer",
			() => api<AgentsPage>("/agents?selector=role%3Dreviewer"),
		);
		expect(reviewers.body.total).toBe(PEERS * 3);
		await timeAsync("GET /search?q=agent-7", () => api("/search?q=agent-7"));
		time("views.rows() in process", () => service.app.views.rows());
	},
);

test.skipIf(!RUN)("a pool-wide broadcast: one batch per peer", async () => {
	const dry = await timeAsync("POST /send dry run to * (9,000)", () =>
		api<{ count: number; machines: number; resolveToken: string }>("/send", {
			method: "POST",
			body: JSON.stringify({ to: "*", body: "pool-wide notice", dryRun: true }),
		}),
	);
	expect(dry.body.count).toBe(PEERS * PER_PEER + 30);
	expect(dry.body.machines).toBe(PEERS + 1);
	const sent = await timeAsync(
		"POST /send to * (receipts written, outbox queued)",
		() =>
			api<{ count: number }>("/send", {
				method: "POST",
				body: JSON.stringify({
					to: "*",
					body: "pool-wide notice",
					resolveToken: dry.body.resolveToken,
				}),
			}),
	);
	expect(sent.status).toBe(200);
	await timeAsync("broadcast delivered to all 299 peers", () =>
		until(() => sims.every((s) => s.delivered >= PER_PEER), 60_000),
	);
	expect(sims.every((s) => s.batches === 1)).toBe(true);
	expect(store.outboxDuePeers(Date.now() + 1e9)).toEqual([]);
});

test.skipIf(!RUN)(
	"churn storm: 5 rounds × 299 peers × 30 agents, then 100 restarts",
	async () => {
		await timeAsync(
			"5 churn rounds applied (44,850 agent updates)",
			async () => {
				for (let round = 0; round < 5; round++) for (const s of sims) s.churn();
				await until(() => {
					for (const s of sims) {
						const p = fed.state.peers.get(s.machineId);
						if (!p || p.seq !== s.seq) return false;
					}
					return true;
				}, 60_000);
			},
		);
		const busy = service.registry
			.remoteAgents()
			.filter((a) => a.status === "busy").length;
		expect(busy).toBe(
			sims.reduce(
				(n, s) =>
					n + [...s.agents.values()].filter((a) => a.status === "busy").length,
				0,
			),
		);
		await timeAsync("100 peer restarts resynced (gap → snapshot)", async () => {
			for (const s of sims.slice(0, 100)) s.restart();
			await until(
				() =>
					sims
						.slice(0, 100)
						.every(
							(s) => fed.state.peers.get(s.machineId)?.bootId === s.bootId,
						),
				60_000,
			);
		});
		await timeAsync("GET /tree after the storm", () =>
			api<Page<TreeNode>>("/tree?group=machines"),
		);
	},
);
