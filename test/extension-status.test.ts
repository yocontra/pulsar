import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import pulsarExtension, { backgroundWork, endKind } from "../src/extension.ts";
import { startDaemon, until } from "./helpers.ts";

type Job = { type: string };
// biome-ignore lint/suspicious/noExplicitAny: a fake host context
type Handler = (e: unknown, c: any) => unknown;

/** A fake pi/omp host: fires events at the extension with a context whose jobs the test sets. */
function fakeHost(
	jobPollMs = 20,
	opts: { omp?: boolean; continueGraceMs?: number; bashGraceMs?: number } = {},
) {
	const handlers = new Map<string, Handler[]>();
	const jobs: Job[] = [];
	let idle = true;
	const ctx = {
		isIdle: () => idle,
		abort: () => {},
		getAsyncJobSnapshot: () => ({ running: [...jobs] }),
		agent: { kind: "main" },
	};
	// The extension picks its host (pi or omp) from argv when it loads.
	const argv = process.argv;
	if (opts.omp) process.argv = [...argv, "/usr/local/bin/omp"];
	try {
		pulsarExtension(
			{
				on: (event, fn) => {
					handlers.set(event, [...(handlers.get(event) ?? []), fn]);
				},
				sendMessage: () => {},
			},
			{
				jobPollMs,
				continueGraceMs: opts.continueGraceMs,
				bashGraceMs: opts.bashGraceMs,
			},
		);
	} finally {
		process.argv = argv;
	}
	const fire = async (
		event: string,
		payload: unknown = {},
		as: unknown = ctx,
	) => {
		if (event === "agent_start") idle = false;
		if (event === "agent_settled" || event === "agent_end") idle = true;
		for (const fn of handlers.get(event) ?? []) await fn(payload, as);
	};
	return {
		jobs,
		fire,
		/** Sets what the host's isIdle() answers (a loop streams or not). */
		streaming: (on: boolean) => {
			idle = !on;
		},
		quit: () => fire("session_shutdown", { reason: "quit" }),
	};
}

/** Every status the extension reports, in order (the registry applies idle at once in tests). */
function recordStatus(daemon: Daemon) {
	const seen: string[] = [];
	const registry = daemon.service.registry;
	const set = registry.setStatus.bind(registry);
	registry.setStatus = (agent, status) => {
		if (agent.pid === process.pid) seen.push(status);
		set(agent, status);
	};
	return seen;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function statusOf(daemon: Daemon) {
	const me = daemon.service.registry.live().find((a) => a.pid === process.pid);
	return me?.status ?? null;
}

describe("backgroundWork", () => {
	test("counts subagent and eval jobs, not background bash", () => {
		const ctx = (running: Job[]) => ({
			getAsyncJobSnapshot: () => ({ running }),
		});
		expect(backgroundWork(ctx([{ type: "task" }, { type: "eval" }]))).toBe(2);
		expect(backgroundWork(ctx([{ type: "bash" }]))).toBe(0);
		expect(backgroundWork({})).toBe(0); // pi: no job API
		expect(backgroundWork(undefined)).toBe(0);
		const stale = {
			getAsyncJobSnapshot: () => {
				throw new Error("stale ctx");
			},
		};
		expect(backgroundWork(stale)).toBe(0);
	});
});

describe("extension busy/idle", () => {
	test("a turn that ends with subagents still running stays busy until they finish", async () => {
		const { daemon, cleanup } = await startDaemon();
		const host = fakeHost();
		try {
			await host.fire("session_start");
			await host.fire("agent_start");
			await until(() => statusOf(daemon) === "busy");
			// The lead respawns workers in the background and ends its turn.
			host.jobs.push({ type: "task" }, { type: "task" });
			await host.fire("agent_settled");
			await new Promise((r) => setTimeout(r, 150));
			expect(statusOf(daemon)).toBe("busy");
			host.jobs.length = 1;
			await new Promise((r) => setTimeout(r, 100));
			expect(statusOf(daemon)).toBe("busy");
			host.jobs.length = 0;
			await until(() => statusOf(daemon) === "idle");
		} finally {
			await host.quit();
			await daemon.stop();
			cleanup();
		}
	});

	test("background bash jobs alone do not keep the agent busy", async () => {
		const { daemon, cleanup } = await startDaemon();
		const host = fakeHost();
		try {
			await host.fire("session_start");
			await host.fire("agent_start");
			await until(() => statusOf(daemon) === "busy");
			host.jobs.push({ type: "bash" });
			await host.fire("agent_settled");
			await until(() => statusOf(daemon) === "idle");
		} finally {
			await host.quit();
			await daemon.stop();
			cleanup();
		}
	});

	test("a daemon restart mid-turn learns the turn is still running", async () => {
		const { daemon, home, cleanup } = await startDaemon();
		const host = fakeHost();
		let next: Daemon | null = null;
		try {
			await host.fire("session_start");
			await host.fire("agent_start");
			await until(() => statusOf(daemon) === "busy");
			await daemon.stop();
			next = new Daemon({
				socket: join(home, "bus.sock"),
				db: join(home, "pulsar.db"),
				scan: false,
				remote: { mode: "off" },
			});
			expect(await next.start()).toBe(true);
			const restarted = next;
			await until(() => statusOf(restarted) === "busy", 5000);
		} finally {
			await host.quit();
			await next?.stop();
			cleanup();
		}
	});
});

describe("endKind", () => {
	test("only an agent_end without willContinue ends the run", () => {
		expect(endKind({})).toBe("ends");
		expect(endKind(undefined)).toBe("ends");
		expect(endKind({ willContinue: false })).toBe("ends");
		expect(endKind({ willContinue: true })).toBe("continues");
		expect(endKind({ willContinue: true, awaitingAsyncWork: true })).toBe(
			"awaits",
		);
	});
});

describe("omp: busy for the whole user turn", () => {
	/** Runs `steps` against a fresh daemon and omp host; returns what was reported. */
	async function run(
		steps: (host: ReturnType<typeof fakeHost>, seen: string[]) => Promise<void>,
		opts: { continueGraceMs?: number; bashGraceMs?: number } = {},
	) {
		const { daemon, cleanup } = await startDaemon();
		const host = fakeHost(20, { omp: true, ...opts });
		try {
			await host.fire("session_start");
			await until(() => statusOf(daemon) !== null);
			const seen = recordStatus(daemon);
			await steps(host, seen);
			return { seen, final: statusOf(daemon) };
		} finally {
			await host.quit();
			await daemon.stop();
			cleanup();
		}
	}

	/** Waits until the extension's reports reach the daemon. */
	const settled = () => pause(60);

	test("a multi-step turn with tools stays busy until the run's agent_end", async () => {
		const { seen, final } = await run(async (host, now) => {
			await host.fire("agent_start");
			for (let i = 0; i < 3; i++) {
				await host.fire("turn_start", { turnIndex: i });
				await host.fire("message_end", {
					message: { role: "assistant", model: "deepseek-v4" },
				});
				await host.fire("tool_execution_start", { toolName: "bash" });
				await host.fire("tool_execution_end", { toolName: "bash" });
				await host.fire("turn_end", { turnIndex: i });
			}
			await settled();
			expect(now).toEqual(["busy"]);
			await host.fire("agent_end", { messages: [] });
			await settled();
		});
		expect(seen).toEqual(["busy", "idle"]);
		expect(final).toBe("idle");
	});

	test("auto-retry, compaction and a queued follow-up never read as idle", async () => {
		const { seen, final } = await run(async (host, now) => {
			await host.fire("agent_start");
			// A retryable error: the loop ends, the retry starts the next one.
			await host.fire("auto_retry_start", { attempt: 1 });
			await host.fire("agent_end", { messages: [], willContinue: true });
			await settled();
			await host.fire("agent_start");
			await host.fire("auto_retry_end", { success: true });
			// Compaction, then the session continues on its own.
			await host.fire("auto_compaction_start", {});
			await host.fire("agent_end", { messages: [], willContinue: true });
			await host.fire("auto_compaction_end", {});
			await settled();
			await host.fire("agent_start");
			// Input queued during the loop runs as the next loop.
			await host.fire("agent_end", { messages: [], willContinue: true });
			await settled();
			await host.fire("agent_start");
			expect(now.includes("idle")).toBe(false);
			await host.fire("agent_end", { messages: [] });
			await settled();
		});
		expect(seen).toEqual(["busy", "idle"]);
		expect(final).toBe("idle");
	});

	test("a loop end that arrives after the next loop began does not end the turn", async () => {
		const { seen } = await run(async (host) => {
			await host.fire("agent_start");
			await host.fire("agent_start");
			await host.fire("agent_end", { messages: [], willContinue: true });
			await settled();
		});
		expect(seen).toEqual(["busy"]);
	});

	test("a run paused on a subagent stays busy until the job finishes", async () => {
		const { seen, final } = await run(async (host, now) => {
			await host.fire("agent_start");
			host.jobs.push({ type: "task" });
			await host.fire("agent_end", {
				messages: [],
				willContinue: true,
				awaitingAsyncWork: true,
			});
			await pause(120);
			expect(now).toEqual(["busy"]);
			// The job's result wakes the run, which then ends.
			host.jobs.length = 0;
			await host.fire("agent_start");
			await host.fire("agent_end", { messages: [] });
			await settled();
		});
		expect(seen).toEqual(["busy", "idle"]);
		expect(final).toBe("idle");
	});

	test("a run paused on a background bash job stays busy only for a while", async () => {
		const { seen, final } = await run(
			async (host, now) => {
				await host.fire("agent_start");
				host.jobs.push({ type: "bash" });
				await host.fire("agent_end", {
					messages: [],
					willContinue: true,
					awaitingAsyncWork: true,
				});
				await pause(60);
				expect(now).toEqual(["busy"]);
				// A dev server never finishes: idle once the grace is over.
				await pause(250);
			},
			{ bashGraceMs: 200 },
		);
		expect(seen).toEqual(["busy", "idle"]);
		expect(final).toBe("idle");
	});

	test("a continuation that never starts ends the turn after the grace period", async () => {
		const { seen, final } = await run(
			async (host, now) => {
				await host.fire("agent_start");
				await host.fire("agent_end", { messages: [], willContinue: true });
				await pause(60);
				expect(now).toEqual(["busy"]);
				await pause(250);
			},
			{ continueGraceMs: 200 },
		);
		expect(seen).toEqual(["busy", "idle"]);
		expect(final).toBe("idle");
	});

	test("the grace period never ends a loop that is still streaming", async () => {
		const { seen, final } = await run(
			async (host) => {
				await host.fire("agent_start");
				// The previous loop's end arrives after this loop began.
				await host.fire("agent_start");
				await host.fire("agent_end", { messages: [], willContinue: true });
				host.streaming(true);
				await pause(300);
			},
			{ continueGraceMs: 100 },
		);
		expect(seen).toEqual(["busy"]);
		expect(final).toBe("busy");
	});

	test("a subagent's events never change the agent's status", async () => {
		const sub = {
			isIdle: () => true,
			getAsyncJobSnapshot: () => ({ running: [] }),
			agent: { kind: "sub" },
		};
		const { seen, final } = await run(async (host) => {
			await host.fire("agent_start");
			// A subagent in the same process starts and finishes its own run.
			await host.fire("session_start", {}, sub);
			await host.fire("agent_start", {}, sub);
			await host.fire("agent_end", { messages: [] }, sub);
			await host.fire("session_shutdown", {}, sub);
			await settled();
		});
		expect(seen).toEqual(["busy"]);
		expect(final).toBe("busy");
	});
});

describe("extension lifecycle", () => {
	test("pi's /new tears the old instance down: its connection closes and never comes back", async () => {
		const { daemon, cleanup } = await startDaemon();
		const old = fakeHost();
		const next = fakeHost();
		try {
			await old.fire("session_start");
			const parent = daemon.service.registry
				.live()
				.find((a) => a.pid === process.pid)!;
			const sessions = daemon.service.sessions;
			const original = sessions.extensionFor(parent.id)!;
			expect(original).toBeDefined();
			// pi emits session_shutdown {reason: "new"}, disposes the session and
			// loads the extension again for the next one. A stale connection
			// left open is later closed (past MAX_RETIRED) and reconnects,
			// taking the push role back from the live instance.
			await old.fire("session_shutdown", { reason: "new" });
			await next.fire("session_start");
			await until(() => original.closed.aborted);
			await pause(300);
			expect(sessions.forAgent(parent.id)).toHaveLength(1);
			expect(sessions.extensionFor(parent.id)).not.toBe(original);
		} finally {
			await next.quit();
			await old.quit();
			await daemon.stop();
			cleanup();
		}
	});
});
