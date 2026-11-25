import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Daemon } from "../src/daemon.ts";
import { hostMachineName, magicDnsName } from "../src/machine.ts";
import {
	ACTING_OPS,
	ALL_OPS,
	authorize,
	authorizeForwarded,
	type Caller,
	FED_OPS,
	HTTP_OPS,
	type Op,
	type Principal,
	PulsarService,
} from "../src/service/index.ts";
import { Waiters } from "../src/service/waiters.ts";
import { Store } from "../src/store.ts";
import type {
	DeliveredMessage,
	Message,
	PublicAgent,
	Receipt,
} from "../src/types.ts";
import {
	agentClient,
	operator,
	registration,
	startDaemon,
	until,
} from "./helpers.ts";

type SendResult = { message: Message; receipts: Receipt[] };

/** A caller with no transport: events are collected, `close()` aborts it. */
function fakeCaller(principal: Principal = { kind: "terminal" }) {
	const controller = new AbortController();
	const events: Array<{ event: string; data: unknown }> = [];
	const caller: Caller = {
		principal,
		closed: controller.signal,
		emit: (event, data) => events.push({ event, data }),
	};
	return { caller, events, close: () => controller.abort() };
}

function errorCode(fn: () => void): string | null {
	try {
		fn();
		return null;
	} catch (e) {
		return (e as { code?: string }).code ?? "thrown";
	}
}

describe("authorize matrix", () => {
	const principals: Record<Principal["kind"], Principal> = {
		agent: { kind: "agent", agentId: "pi:s1" },
		terminal: { kind: "terminal" },
		human: { kind: "human", login: "me@example.com", node: "phone" },
		peer: { kind: "peer", machineId: "m-2", node: "studio" },
	};
	const agentOnly = new Set<Op>([
		"claude.subagent.bind",
		"claude.subagent.collect",
		"claude.subagent.confirm",
		"approval.request",
		"interaction.ask",
		"interaction.local",
		"whoami",
		"set_identity",
		"set_status",
		"ack",
		"nack",
		"msg.ack",
		"msg.done",
		"msg.nack",
		"resume_key",
		"harness_name",
		"interrupt_result",
		"control_result",
	]);
	// What the tailnet user may do: read the pool, send, and approve with a passkey.
	const userOps = new Set<Op>([
		"approve",
		"passkeys.register",
		"passkeys.list",
		"passkeys.remove",
		"push.subscribe",
		"hello",
		"status",
		"list",
		"send",
		"tree",
		"agents",
		"facets",
		"search",
		"attention",
		"recent",
		"receipts",
		"subscribe",
		"transcript.read",
		"stop",
		"lookup",
		"acting.options",
		...ACTING_OPS,
		"hosted",
		"usage",
		"diagnostics",
	]);
	// Acting ops (attachments, launch, git): the human operator only, with a session.
	const acting = new Set<Op>(ACTING_OPS);
	// What a linked pulsar node may do: exactly the federation ops.
	const fedOps = new Set<Op>(FED_OPS);
	// No target: an agent's transcript.read names no agent, so it is refused.
	const expected = (kind: Principal["kind"], op: Op): string | null => {
		// Only the user approves (with a passkey); agents never.
		if ((op === "approve" || op === "hosted") && kind !== "human")
			return "forbidden";
		if ((acting.has(op) || op === "acting.options") && kind !== "human")
			return "forbidden";
		if (kind === "peer") return fedOps.has(op) ? null : "forbidden";
		if (fedOps.has(op)) return "forbidden";
		if (kind === "human") {
			if (!userOps.has(op)) return "forbidden";
			// Stop and passkey removal need a passkey session.
			return op === "stop" || op === "passkeys.remove" || acting.has(op)
				? "session_required"
				: null;
		}
		// An agent never stops the daemon (that frees its port).
		if (
			(op === "transcript.read" || op === "stop" || op === "shutdown") &&
			kind === "agent"
		)
			return "forbidden";
		// Agents never register a passkey or subscribe to pushes (the app's,
		// with WebAuthn). Pool changes and passkey removal pass here: the
		// service asks the person first (test/presence.test.ts).
		if (
			kind === "agent" &&
			(op === "passkeys.register" || op === "push.subscribe")
		)
			return "forbidden";
		if (kind === "terminal" && op === "passkeys.register") return "forbidden";
		if (kind === "agent" && op === "presence.word") return "forbidden";
		if (kind === "terminal" && agentOnly.has(op)) return "not_registered";
		return null;
	};

	for (const kind of Object.keys(principals) as Principal["kind"][]) {
		for (const op of ALL_OPS) {
			test(`${kind} × ${op}`, () => {
				expect(errorCode(() => authorize(principals[kind], op))).toBe(
					expected(kind, op),
				);
			});
		}
	}

	test("transcript.read: an agent reads only its own; users any; peers none", () => {
		const read = (p: Principal, target?: string) =>
			errorCode(() => authorize(p, "transcript.read", target));
		expect(read(principals.agent, "pi:s1")).toBeNull();
		expect(read(principals.agent, "pi:s2")).toBe("forbidden");
		expect(read(principals.terminal, "pi:s2")).toBeNull();
		expect(read(principals.human, "pi:s2")).toBeNull();
		expect(read(principals.peer, "pi:s1")).toBe("forbidden");
	});

	test("stop: an agent only itself; operator and user any; a peer only forwarding its user", () => {
		const stop = (p: Principal, target?: string) =>
			errorCode(() => authorize(p, "stop", target));
		expect(stop(principals.agent, "pi:s1")).toBeNull();
		expect(stop(principals.agent, "pi:s2")).toBe("forbidden");
		expect(stop(principals.terminal, "pi:s2")).toBeNull();
		expect(stop(principals.human, "pi:s2")).toBe("session_required");
		expect(
			stop({ ...principals.human, verified: true } as Principal, "pi:s2"),
		).toBeNull();
		expect(stop(principals.peer, "pi:s2")).toBe("forbidden");
		const fwd = (by: Principal, as: Principal) =>
			errorCode(() => authorizeForwarded(by, as, "stop", "pi:s2"));
		expect(
			fwd(principals.peer, {
				...principals.human,
				verified: true,
			} as Principal),
		).toBeNull();
		expect(fwd(principals.peer, principals.agent)).toBe("forbidden");
		expect(fwd(principals.human, principals.human)).toBe("forbidden");
	});

	test("the user may not shut down, wait, tail, reply or act as an agent", () => {
		const user = principals.human;
		for (const op of [
			"shutdown",
			"wait",
			"tail",
			"reply",
			"inbox",
			"history",
			"whoami",
			"set_identity",
		] as Op[])
			expect(errorCode(() => authorize(user, op))).toBe("forbidden");
	});

	test("the app's ops are not socket methods", async () => {
		const store = new Store(":memory:");
		const service = new PulsarService({ store, scan: false, machine: "t" });
		const { caller } = fakeCaller();
		service.attach(caller);
		for (const op of HTTP_OPS)
			await expect(service.handle(caller, op, {})).rejects.toMatchObject({
				code: "unknown_method",
			});
		store.close();
	});

	test("the operator's refusal keeps today's error", () => {
		expect(() => authorize({ kind: "terminal" }, "whoami")).toThrow(
			"this connection has not said hello",
		);
	});

	test("an unknown method is unknown_method, before any authorization", async () => {
		const store = new Store(":memory:");
		const service = new PulsarService({ store, scan: false, machine: "t" });
		const { caller } = fakeCaller({ kind: "peer", machineId: "x", node: "y" });
		service.attach(caller);
		await expect(service.handle(caller, "nope", {})).rejects.toMatchObject({
			code: "unknown_method",
		});
		await expect(service.handle(caller, "list", {})).rejects.toMatchObject({
			code: "forbidden",
		});
		store.close();
	});
});

describe("Caller-scoped waiters", () => {
	test("closing a caller resolves and drops its waits", async () => {
		const waiters = new Waiters();
		const a = fakeCaller();
		const b = fakeCaller();
		const pa = waiters.add(a.caller, "x", "message", undefined, 5000);
		const pa2 = waiters.add(a.caller, "x", "idle", "y", 5000);
		const pb = waiters.add(b.caller, "x", "message", undefined, 5000);
		expect(waiters.size).toBe(3);
		a.close();
		expect(await pa).toEqual({ event: "closed" });
		expect(await pa2).toEqual({ event: "closed" });
		expect(waiters.countFor(a.caller)).toBe(0);
		expect(waiters.size).toBe(1);
		b.close();
		expect(await pb).toEqual({ event: "closed" });
		expect(waiters.size).toBe(0);
	});

	test("a closed caller's wait resolves at once", async () => {
		const waiters = new Waiters();
		const a = fakeCaller();
		a.close();
		expect(
			await waiters.add(a.caller, "x", "message", undefined, 5000),
		).toEqual({ event: "closed" });
		expect(waiters.size).toBe(0);
	});

	test("a dropped wait does not swallow the agent's next message", async () => {
		const store = new Store(":memory:");
		const service = new PulsarService({ store, scan: false, machine: "t" });
		const reg = registration({
			harness: "cursor",
			role: "mcp",
			sessionId: "pull-1",
		});
		// The agent's own MCP connection keeps it live.
		const main = fakeCaller();
		service.attach(main.caller);
		service.registerAgent(main.caller, reg);
		// A CLI from its shell borrows the identity and blocks on a wait.
		const shell = fakeCaller();
		service.attach(shell.caller);
		service.borrowAgent(shell.caller, { ...reg, role: "cli" });
		const pending = service.handle(shell.caller, "wait", {
			timeoutSeconds: 30,
		});
		expect(service.waiters.size).toBe(1);
		shell.close();
		expect(await pending).toEqual({ event: "closed" });
		expect(service.waiters.size).toBe(0);
		expect(service.registry.live().map((a) => a.id)).toEqual(["cursor:pull-1"]);

		const op = fakeCaller();
		service.attach(op.caller);
		const r = (await service.handle(op.caller, "send", {
			to: "cursor:pull-1",
			body: "still there?",
		})) as SendResult;
		expect(r.receipts[0]!.state).toBe("queued");
		const inbox = (await service.handle(main.caller, "inbox", {})) as {
			messages: DeliveredMessage[];
		};
		expect(inbox.messages.map((m) => m.body)).toEqual(["still there?"]);
		service.stop();
		store.close();
	});
});

describe("extension ack and nack", () => {
	test("only a recipient can ack or nack a message (no receipt for anyone else)", async () => {
		const store = new Store(":memory:");
		const service = new PulsarService({ store, scan: false, machine: "t" });
		const join = (sessionId: string) => {
			const c = fakeCaller();
			service.attach(c.caller);
			service.registerAgent(
				c.caller,
				registration({ harness: "cursor", role: "mcp", sessionId }),
			);
			return c;
		};
		const a = join("ack-a");
		join("ack-b");
		const c = join("ack-c");
		const sent = (await service.handle(a.caller, "send", {
			to: "cursor:ack-b",
			body: "for b only",
		})) as SendResult;
		const id = sent.message.id;
		for (const op of ["ack", "nack"])
			await expect(
				service.handle(c.caller, op, { messageId: id, via: "extension" }),
			).rejects.toMatchObject({ code: "not_found" });
		const inbox = (await service.handle(c.caller, "inbox", {})) as {
			messages: DeliveredMessage[];
		};
		expect(inbox.messages).toEqual([]);
		service.stop();
		store.close();
	});
});

describe("set_identity", () => {
	test("a scan that replaces the agent's record mid-call does not lose the change", async () => {
		const store = new Store(":memory:");
		const service = new PulsarService({ store, scan: false, machine: "t" });
		const reg = registration({
			harness: "cursor",
			role: "mcp",
			sessionId: "race-1",
		});
		const main = fakeCaller();
		service.attach(main.caller);
		service.registerAgent(main.caller, reg);
		const pending = service.handle(main.caller, "set_identity", {
			cwd: process.cwd(),
			name: "api-fixer",
			inbound: "refuse",
		});
		// The scan runs while the call waits on the folder check.
		service.registry.upsert({
			harness: "cursor",
			sessionId: "race-1",
			pid: reg.pid,
			cwd: reg.cwd,
			project: reg.project,
			branch: reg.branch,
			tags: [],
			meta: {},
			registered: false,
		});
		await pending;
		const now = service.registry.get("cursor:race-1")!;
		expect(now.name).toBe("api-fixer");
		expect(now.inbound).toBe("refuse");
		service.stop();
		store.close();
	});
});

describe("event bus", () => {
	test("tail streams agent and message events until the caller closes", async () => {
		const store = new Store(":memory:");
		const service = new PulsarService({ store, scan: false, machine: "t" });
		const tail = fakeCaller();
		service.attach(tail.caller);
		await service.handle(tail.caller, "tail", {});
		await service.handle(tail.caller, "tail", {});
		const agent = fakeCaller();
		service.attach(agent.caller);
		service.registerAgent(
			agent.caller,
			registration({ harness: "cursor", role: "mcp" }),
		);
		expect(tail.events.map((e) => e.event)).toEqual(["agent"]);
		tail.close();
		expect(service.events.size).toBe(0);
		store.close();
	});
});

describe("service mode", () => {
	test("shutdown runs the shutdown hook outside service mode", async () => {
		const store = new Store(":memory:");
		let shut = 0;
		const service = new PulsarService({
			store,
			scan: false,
			machine: "t",
			onShutdown: () => shut++,
		});
		const op = fakeCaller();
		service.attach(op.caller);
		expect(await service.handle(op.caller, "shutdown", {})).toEqual({
			ok: true,
		});
		expect(shut).toBe(1);
		store.close();
	});

	test("the socket shutdown call is refused, and the daemon keeps serving", async () => {
		const { daemon, cleanup } = await startDaemon({ serviceMode: true });
		try {
			const op = await operator();
			await expect(op.call("shutdown")).rejects.toThrow(/service/);
			expect(
				(await op.call<{ version: string }>("status")).version,
			).toBeString();
			op.close();
		} finally {
			await daemon.stop();
			cleanup();
		}
	});
});

describe("machine name", () => {
	test("host name without .local", () => {
		expect(hostMachineName("Erics-MacBook-Pro.local")).toBe(
			"erics-macbook-pro",
		);
		expect(hostMachineName("studio")).toBe("studio");
		expect(hostMachineName("build box.local.")).toBe("build-box");
	});

	test("MagicDNS short name from tailscale status", () => {
		expect(
			magicDnsName({
				BackendState: "Running",
				Self: { DNSName: "studio.tail1234.ts.net." },
			}),
		).toBe("studio");
		expect(
			magicDnsName({
				BackendState: "Stopped",
				Self: { DNSName: "studio.tail1234.ts.net." },
			}),
		).toBeNull();
		expect(magicDnsName({ Self: { DNSName: "" } })).toBeNull();
		expect(magicDnsName("nope")).toBeNull();
	});
});

describe("machine tag", () => {
	let daemon: Daemon;
	let cleanup: () => void;
	const clients: Array<{ close: () => void }> = [];

	beforeEach(async () => {
		({ daemon, cleanup } = await startDaemon({ machine: "TestBox" }));
	});

	afterEach(async () => {
		for (const c of clients.splice(0)) c.close();
		await daemon.stop();
		cleanup();
	});

	test("every agent carries machine and machine:<name>", async () => {
		const a = await agentClient(registration({ project: "apparish" }));
		clients.push(a.client);
		expect(a.agent.machine).toBe("testbox");
		expect(a.agent.tags).toContain("machine:testbox");
		const op = await operator();
		clients.push(op);
		const pick = async (selector: string) =>
			(await op.call<PublicAgent[]>("list", { selector })).map((x) => x.id);
		expect(await pick("machine=testbox")).toEqual([a.agent.id]);
		expect(await pick("machine=other")).toEqual([]);
		expect(await pick("machine=other|testbox project=apparish")).toEqual([
			a.agent.id,
		]);
	});

	test("an agent cannot claim another machine or drop its own", async () => {
		const a = await agentClient(registration({ sessionId: "keep-m" }));
		clients.push(a.client);
		const r = await a.client.call<{ agent: PublicAgent }>("set_identity", {
			tagsAdd: ["machine:elsewhere", "role:reviewer"],
			tagsRemove: ["machine:testbox"],
		});
		expect(r.agent.tags.filter((t) => t.startsWith("machine:"))).toEqual([
			"machine:testbox",
		]);
		expect(r.agent.tags).toContain("role:reviewer");
		// Auto-tags are not saved as the agent's own.
		expect(daemon.store.loadIdentity(a.agent.id)?.tags).toEqual([
			"role:reviewer",
		]);
	});

	test("renaming the machine re-tags every agent", async () => {
		const a = await agentClient(registration());
		clients.push(a.client);
		daemon.service.registry.setMachine("studio");
		const op = await operator();
		clients.push(op);
		const [found] = await op.call<PublicAgent[]>("list", {
			selector: "machine=studio",
		});
		expect(found?.tags).toContain("machine:studio");
		expect(found?.tags).not.toContain("machine:testbox");
		await until(() => daemon.live()[0]?.machine === "studio");
	});
});
