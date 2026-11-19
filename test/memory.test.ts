/**
 * Memory regression test (opt in, slow):
 *
 *   bun run build && PULSAR_MEM_TEST=1 bun test test/memory.test.ts
 *
 * - the built MCP server starts under a footprint and heap budget, and a
 *   long session (thousands of tool calls and incoming messages) does not
 *   grow its heap;
 * - the built daemon, with agents connecting, messaging, following and
 *   leaving round after round, returns to the same heap;
 * - a node linked to a peer whose agents and prompts churn keeps a flat heap.
 *
 * Everything runs in a throwaway HOME (see test/mem-harness.ts). Budgets
 * have headroom for a busy machine; growth bounds are what catch leaks.
 */
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonClient } from "../src/client.ts";
import { Federation } from "../src/federation/index.ts";
import type { FedAgent } from "../src/federation/protocol.ts";
import { sseStream } from "../src/federation/sse.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import type { PublicAgent } from "../src/types.ts";
import { PROTOCOL_VERSION } from "../src/types.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { restoreEnv, until } from "./helpers.ts";
import {
	CLI,
	footprint,
	MB,
	mb,
	type Runtime,
	Sandbox,
	sleep,
	startDaemon,
	startMcp,
} from "./mem-harness.ts";

const RUN = process.env.PULSAR_MEM_TEST === "1";
const BUILT = existsSync(CLI);
setDefaultTimeout(600_000);

/** Fresh MCP server, unprobed footprint (the probe itself costs a few MB). */
const MCP_FOOTPRINT: Record<Runtime, number> = { node: 21 * MB, bun: 18 * MB };
const MCP_HEAP = 7 * MB;

/** A client of the sandbox daemon, registered as a pi agent. */
async function agentClient(box: Sandbox, sessionId: string) {
	const previous = process.env.PULSAR_HOME;
	process.env.PULSAR_HOME = box.state;
	try {
		const client = new DaemonClient();
		await client.connect(false);
		const r = await client.call<{ agent: PublicAgent }>("hello", {
			protocol: PROTOCOL_VERSION,
			version: "test",
			registration: {
				harness: "pi",
				sessionId,
				pid: null,
				cwd: box.home,
				project: "mem",
				branch: null,
				tags: [],
				role: "extension",
			},
		});
		return { client, agent: r.agent };
	} finally {
		restoreEnv("PULSAR_HOME", previous);
	}
}

/** A client of the sandbox daemon as the operator (may read any transcript). */
async function operatorClient(box: Sandbox) {
	const previous = process.env.PULSAR_HOME;
	process.env.PULSAR_HOME = box.state;
	try {
		const client = new DaemonClient();
		await client.connect(false);
		await client.call("hello", {
			protocol: PROTOCOL_VERSION,
			version: "test",
			registration: { role: "cli" },
		});
		return client;
	} finally {
		restoreEnv("PULSAR_HOME", previous);
	}
}

const log = (line: string) => console.log(`  [mem] ${line}`);

describe.skipIf(!RUN || !BUILT)("MCP server", () => {
	for (const runtime of ["node", "bun"] as Runtime[]) {
		test(`${runtime}: starts small and stays flat over a long session`, async () => {
			const box = new Sandbox();
			try {
				await startDaemon(box, "node");
				const plain = await startMcp(box, runtime, {
					probe: false,
					session: "plain",
				});
				await sleep(1500);
				const fresh = footprint(plain.child.pid as number);
				log(`${runtime} mcp fresh footprint ${mb(fresh)}`);
				expect(fresh).toBeLessThan(MCP_FOOTPRINT[runtime]);
				plain.child.kill();

				const { child, rpc } = await startMcp(box, runtime, {
					session: "soak",
				});
				const peer = await agentClient(box, "peer");
				const me = (await rpc.tool("whoami")).content[0]!.text;
				const id = /\(([^)]+)\)/.exec(me)![1]!;
				const round = async (n: number) => {
					for (let i = 0; i < n; i++) {
						await rpc.tool("send", {
							to: peer.agent.id,
							body: `ping ${i} ${"x".repeat(i % 7 === 0 ? 4000 : 100)}`,
						});
						await peer.client.call("send", {
							to: id,
							body: `pong ${i}`,
							priority: i % 3 ? "fyi" : "normal",
						});
						await rpc.tool("inbox", { limit: 100 });
						if (i % 5 === 0) await rpc.tool("list_agents");
						if (i % 5 === 1) await rpc.tool("history", { limit: 50 });
						if (i % 5 === 2)
							await rpc.tool("set_identity", { activity: `step ${i}` });
						if (i % 5 === 3)
							await rpc.tool("who", { question: "who is on mem" });
						if (i % 5 === 4) await rpc.tool("wait", { timeout_seconds: 1 });
						rpc.notifications.length = 0;
					}
				};
				await round(150);
				const warm = await box.usage(child);
				await round(1200);
				const after = await box.usage(child);
				log(
					`${runtime} mcp heap ${mb(warm.heapUsed)} → ${mb(after.heapUsed)}, footprint ${mb(warm.footprint)} → ${mb(after.footprint)}`,
				);
				expect(warm.heapUsed).toBeLessThan(MCP_HEAP);
				expect(after.heapUsed - warm.heapUsed).toBeLessThan(1 * MB);
				expect(after.footprint - warm.footprint).toBeLessThan(4 * MB);
				peer.client.close();
			} finally {
				await box.close();
			}
		});
	}
});

describe.skipIf(!RUN || !BUILT)("daemon", () => {
	test("returns to its floor after rounds of agents coming and going", async () => {
		const box = new Sandbox();
		try {
			const daemon = await startDaemon(box, "node");
			// pi transcripts for the sandbox folder (cwd = HOME): ~/.pi/agent/sessions/-/
			const sessions = join(box.home, ".pi", "agent", "sessions", "-");
			mkdirSync(sessions, { recursive: true });
			const line = (id: string, text: string) =>
				`${JSON.stringify({
					type: "message",
					id,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: text },
				})}\n`;
			let session = 0;
			let followed = 0;
			const round = async () => {
				const ids = Array.from({ length: 12 }, () => `churn-${session++}`);
				const files = ids.map((id) => join(sessions, `0_${id}.jsonl`));
				for (const [n, id] of ids.entries())
					writeFileSync(
						files[n]!,
						`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: box.home })}\n${line(`${id}-0`, "start")}`,
					);
				const clients = await Promise.all(
					ids.map((id) => agentClient(box, id)),
				);
				const viewer = await operatorClient(box);
				for (const [i, c] of clients.entries()) {
					const to = clients[(i + 1) % clients.length]!.agent.id;
					for (let k = 0; k < 4; k++)
						await c.client.call("send", {
							to,
							body: `msg ${k} ${"y".repeat(500)}`,
							priority: "fyi",
						});
					await c.client.call("tail");
					// A viewer (the operator) follows each transcript.
					const page = await viewer
						.call<{ events: unknown[] } | null>("transcript.read", {
							agent: c.agent.id,
							follow: true,
						})
						.catch(() => null);
					if (page?.events.length) followed++;
				}
				// The followed transcripts grow while they are watched.
				for (let k = 1; k <= 10; k++)
					for (const [n, id] of ids.entries())
						appendFileSync(files[n]!, line(`${id}-${k}`, "z".repeat(2000)));
				await sleep(150);
				for (const c of clients) {
					await c.client.call("inbox", { markRead: true, limit: 100 });
					c.client.close();
				}
				viewer.close();
			};
			for (let r = 0; r < 10; r++) await round();
			// Past the grace period, so departed agents are gone from the registry.
			await sleep(70_000);
			const warm = await box.settled(daemon);
			for (let r = 0; r < 50; r++) await round();
			await sleep(70_000);
			const after = await box.settled(daemon);
			log(
				`daemon heap ${mb(warm.heapUsed)} → ${mb(after.heapUsed)}, footprint ${mb(warm.footprint)} → ${mb(after.footprint)} (${session} sessions, ${followed} transcripts followed)`,
			);
			// Most follows found a transcript (the soak exercises the tailer).
			expect(followed).toBeGreaterThan(session / 2);
			expect(after.heapUsed - warm.heapUsed).toBeLessThan(2 * MB);
			expect(after.footprint - warm.footprint).toBeLessThan(6 * MB);
		} finally {
			await box.close();
		}
	});
});

/** A peer that speaks /fed/v1 from memory; its agents and prompts churn. */
class ChurnPeer {
	readonly machineId = "churn-peer";
	readonly name = "peer";
	bootId = "b0";
	seq = 1;
	next = 0;
	agents = new Map<string, FedAgent>();
	listeners = new Set<(event: string, data: unknown) => void>();
	closers = new Set<() => void>();

	agent(): FedAgent {
		const n = this.next++;
		const id = `claude:a${n}`;
		return {
			id,
			name: `agent-${n}`,
			harness: "claude",
			project: `p${n % 7}`,
			branch: "main",
			machine: this.name,
			tags: [`machine:${this.name}`, `pr:${n}`],
			status: n % 2 ? "busy" : "idle",
			model: "m",
			activity: `doing ${n} ${"z".repeat(200)}`,
			inbound: "accept",
			registered: true,
			reach: "push",
			lastSeen: Date.now(),
			createdAt: Date.now(),
			needsYou: null,
			wake: "wakes",
			hasTranscript: true,
			approvals: [
				{
					requestId: `q${n}`,
					agentId: id,
					tool: "Bash",
					input: { command: `echo ${n}` },
					inputHash: `h${n}`,
					state: "pending",
					createdAt: Date.now(),
					expiresAt: Date.now() + 60_000,
				},
			],
		} as unknown as FedAgent;
	}

	constructor() {
		for (let i = 0; i < 30; i++) {
			const a = this.agent();
			this.agents.set(a.id, a);
		}
	}

	/** Five agents leave, five new ones (each with a prompt) arrive. */
	churn() {
		const removes = [...this.agents.keys()].slice(0, 5);
		for (const id of removes) this.agents.delete(id);
		const upserts = Array.from({ length: 5 }, () => this.agent());
		for (const a of upserts) this.agents.set(a.id, a);
		this.seq++;
		for (const fn of this.listeners)
			fn("delta", {
				type: "delta",
				bootId: this.bootId,
				seq: this.seq,
				upserts,
				removes,
			});
	}

	restart() {
		this.bootId = `b${this.next}`;
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
					results: frames.map((f) =>
						f.type === "digest"
							? {
									ok: true,
									digest: {
										machineId: this.machineId,
										bootId: this.bootId,
										seq: this.seq,
										agentCount: this.agents.size,
									},
								}
							: { ok: true },
					),
				});
			}
			if (url.pathname === "/fed/v1/stream") {
				let fn: ((e: string, d: unknown) => void) | null = null;
				const stream = sseStream((send) => {
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
				// Wrapped, so a restart can end the response from this side.
				const reader = stream.getReader();
				let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
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

describe.skipIf(!RUN)("federation", () => {
	const tailnet = new FakeTailnet();
	const peer = new ChurnPeer();
	let store: Store;
	let service: PulsarService;
	let http: HttpTransport;
	let fed: Federation;

	beforeAll(async () => {
		tailnet.add("hub");
		tailnet.add(peer.name);
		tailnet.serve(peer.name, peer.app);
		store = new Store(":memory:");
		service = new PulsarService({ store, scan: false, machine: "hub" });
		http = new HttpTransport(service, {
			identity: tailnet.identity,
			owner: "me@example.com",
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
			hub: { coalesceMs: 50 },
		});
		await http.listen();
		fed = new Federation(service, {
			tailnet: tailnet.view("hub"),
			intervals: {
				discoverMs: 200,
				heartbeatMs: 200,
				coalesceMs: 20,
				outboxTickMs: 50,
				requestTimeoutMs: 5000,
				linkIdleMs: 600_000,
			},
		});
		http.fed = fed;
		tailnet.serve("hub", http.app, http.port);
		await fed.start();
		await until(() => service.registry.remoteAgents().length === 30, 20_000);
	});

	afterAll(async () => {
		fed?.stop();
		service?.stop();
		await http?.close();
		store?.close();
	});

	const heap = () => {
		Bun.gc(true);
		return process.memoryUsage().heapUsed;
	};

	test("a peer whose agents and prompts churn leaves a flat heap", async () => {
		const run = async (rounds: number) => {
			for (let r = 1; r <= rounds; r++) {
				peer.churn();
				if (r % 100 === 0) peer.restart();
				await until(
					() =>
						service.registry
							.remoteAgents()
							.some((a) => a.id.endsWith(`claude:a${peer.next - 1}`)),
					10_000,
				).catch((e) => {
					log(
						`round ${r} stuck: listeners ${peer.listeners.size} ${fed.machines().map((m) => `${m.name}:${m.link}`)}`,
					);
					throw e;
				});
			}
		};
		await run(200);
		await sleep(300);
		const warm = heap();
		await run(1500);
		await sleep(300);
		const after = heap();
		log(
			`federation heap ${mb(warm)} → ${mb(after)} (${peer.next} remote agents seen)`,
		);
		expect(service.registry.remoteAgents().length).toBe(30);
		expect(after - warm).toBeLessThan(3 * MB);
	});
});
