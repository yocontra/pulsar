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
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import type { Message, Registration } from "../src/types.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { registration, until } from "./helpers.ts";
import { SoftAuthenticator } from "./webauthn.ts";

/**
 * The queue strip across the pool: a remote agent's queue is listed from
 * its home node plus this node's outbox; the operator's own messages are
 * withdrawn and edited there as a send is, anyone else's only with the home
 * node's own passkey check.
 */

setDefaultTimeout(20_000);

const OWNER = "me@example.com";
const TAILNET_RP = "tail-fake.ts.net";
const originOf = (name: string) => `https://${name}.tail-fake.ts.net:7337`;
const rpOf = (name: string) => ({
	rpId: TAILNET_RP,
	origins: [originOf(name)],
});
const USER = { kind: "human" as const, login: OWNER, node: "phone" };

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

async function startNode(name: string): Promise<Node> {
	const dir = mkdtempSync(join(tmpdir(), `pulsar-queue-${name}-`));
	const store = new Store(join(dir, "pulsar.db"));
	const service = new PulsarService({
		store,
		scan: false,
		machine: name,
		push: { keyFile: join(dir, "vapid.json") },
		approvals: { probe: () => null },
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
		intervals: {
			discoverMs: 150,
			heartbeatMs: 200,
			missed: 2,
			coalesceMs: 30,
			linkIdleMs: 60_000,
			outboxTickMs: 40,
			receiptTickMs: 40,
			requestTimeoutMs: 1000,
		},
	});
	http.fed = fed;
	tailnet.add(name);
	tailnet.serve(name, http.app, http.port, 7337);
	service.start();
	await fed.start();
	const node = { name, dir, store, service, http, fed };
	nodes.push(node);
	return node;
}

function agentOn(n: Node, over: Partial<Registration>) {
	const controller = new AbortController();
	const caller: Caller = {
		principal: { kind: "terminal" },
		closed: controller.signal,
		emit: () => {},
	};
	const role = over.role ?? "extension";
	n.service.attach(caller);
	n.service.setRole(caller, role);
	return n.service.registerAgent(
		caller,
		registration({ project: "demo", cwd: "/work/demo", ...over, role }),
	);
}

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return (e as { code?: string }).code ?? (e as Error).message;
	}
}

let home: Node;
let relay: Node;
/** An MCP-only session on the home node: messages wait in its inbox. */
let inboxId: string;
let codexId: string;
let phone: SoftAuthenticator;
const address = () => `${home.service.machineId}/${inboxId}`;

/** The operator sends from the relay's app to the remote agent. */
async function sendFromRelay(body: string): Promise<Message> {
	const r = (await relay.service.app.send(USER, {
		ids: [address()],
		body,
		priority: "normal",
		dryRun: false,
	})) as { message: Message };
	return r.message;
}

beforeAll(async () => {
	tailnet.add("phone");
	home = await startNode("home");
	relay = await startNode("relay");
	inboxId = agentOn(home, { name: "india", role: "mcp" }).id;
	codexId = agentOn(home, {
		name: "charlie",
		harness: "codex",
		role: "mcp",
	}).id;
	for (const n of nodes) await n.fed.discover();
	await until(() => relay.service.registry.find(address()) !== undefined, 5000);
	phone = new SoftAuthenticator({ origin: originOf("home"), rpId: TAILNET_RP });
	const pk = home.service.passkeys;
	const options = await pk.registrationOptions(OWNER, rpOf("home"), {
		label: "iPhone",
	});
	await pk.verifyRegistration(OWNER, rpOf("home"), phone.register(options));
});

afterAll(async () => {
	for (const n of nodes) {
		n.fed.stop();
		n.service.stop();
		await n.http.close();
		n.store.close();
		rmSync(n.dir, { recursive: true, force: true });
	}
});

describe("a remote agent's queue", () => {
	test("lists the home node's part; the operator's own message is edited and withdrawn there", async () => {
		const m = await sendFromRelay("frist");
		await until(() => home.store.receipt(m.id, inboxId)?.state === "queued");
		const items = (await relay.service.queue.list(USER, address())).items;
		const item = items.find((i) => i.messageId === m.id)!;
		expect(item).toMatchObject({
			agentId: address(),
			where: "home",
			mine: true,
			state: "next-turn",
			canEdit: true,
			canWithdraw: true,
		});

		await relay.service.queue.act(USER, address(), m.id, "edit", {
			body: "first",
		});
		expect(home.store.getMessage(m.id)?.body).toBe("first");
		// This node's copy follows, so its history shows what was sent.
		expect(relay.store.getMessage(m.id)?.body).toBe("first");

		const r = await relay.service.queue.act(USER, address(), m.id, "withdraw");
		expect(r.receipt?.state).toBe("withdrawn");
		expect(home.store.receipt(m.id, inboxId)?.state).toBe("withdrawn");
		// The receipt comes back to the sender's node.
		await until(
			() => relay.store.receipt(m.id, address())?.state === "withdrawn",
			5000,
		);
		const after = (await relay.service.queue.list(USER, address())).items;
		expect(after.some((i) => i.messageId === m.id)).toBe(false);
	});

	test("another agent's message: refused as a send, done with the home node's passkey check", async () => {
		const codex = home.service.registry.get(codexId)!;
		const sent = await home.service.mailbox.send(codex, {
			to: inboxId,
			body: "codex asks",
			priority: "normal",
			replyTo: null,
			expectReply: false,
		});
		const id = sent.message.id;
		const item = (await relay.service.queue.list(USER, address())).items.find(
			(i) => i.messageId === id,
		)!;
		expect(item).toMatchObject({ mine: false, canEdit: false });
		// No proof: the home node refuses.
		expect(
			await code(relay.service.queue.act(USER, address(), id, "withdraw")),
		).toBe("forbidden");
		expect(
			await code(
				relay.service.queue.act(USER, address(), id, "edit", { body: "x" }),
			),
		).toBe("forbidden");
		expect(home.store.receipt(id, inboxId)?.state).toBe("queued");
		// The home node's challenge for exactly this op and message, signed on the relay's app.
		const options = (await relay.service.acting.options(
			USER,
			"queue.withdraw",
			{ agent: address() },
			{ messageId: id },
		)) as { challenge: string };
		const assertion = phone.assert(options, { origin: originOf("relay") });
		const r = await relay.service.queue.act(USER, address(), id, "withdraw", {
			assertion,
		});
		expect(r.receipt?.state).toBe("withdrawn");
		expect(home.store.receipt(id, inboxId)?.state).toBe("withdrawn");
		const audit = home.store.auditLog(20).map((a) => a.op);
		expect(audit).toContain("queue.withdraw.relayed");
	});

	test("while its machine is offline: listed from this node's outbox, withdrawn here, never delivered", async () => {
		tailnet.setOnline("home", false);
		try {
			await until(
				() =>
					relay.service.registry.pool?.machine(home.service.machineId)?.link !==
					"tailnet",
				5000,
			);
			const m = await sendFromRelay("for later");
			const list = await relay.service.queue.list(USER, address());
			expect(list.partial).toBeTruthy();
			const item = list.items.find((i) => i.messageId === m.id)!;
			expect(item).toMatchObject({
				where: "outbox",
				state: "offline",
				mine: true,
				canPromote: false,
				canWithdraw: true,
				canEdit: true,
			});
			expect(
				await code(relay.service.queue.act(USER, address(), m.id, "promote")),
			).toBe("unreachable");
			const r = await relay.service.queue.act(
				USER,
				address(),
				m.id,
				"withdraw",
			);
			expect(r.receipt?.state).toBe("withdrawn");
			expect(relay.store.outboxFor(home.service.machineId)).toEqual([]);
			tailnet.setOnline("home", true);
			await until(
				() =>
					relay.service.registry.pool?.machine(home.service.machineId)?.link ===
					"tailnet",
				5000,
			);
			await new Promise((r) => setTimeout(r, 200));
			expect(home.store.getMessage(m.id)).toBeNull();
		} finally {
			tailnet.setOnline("home", true);
		}
	});

	test("once its batch is on the wire, it can't be withdrawn or edited here", async () => {
		tailnet.setOnline("home", false);
		const peer = home.service.machineId;
		try {
			await until(
				() => relay.service.registry.pool?.machine(peer)?.link !== "tailnet",
				5000,
			);
			const m = await sendFromRelay("racing the flush");
			// What a flush does while its post to the peer is in flight.
			relay.store.outboxMarkSending(peer, [m.id], true);
			expect(
				await code(relay.service.queue.act(USER, address(), m.id, "withdraw")),
			).toBe("conflict");
			expect(
				await code(
					relay.service.queue.act(USER, address(), m.id, "edit", {
						body: "changed",
					}),
				),
			).toBe("conflict");
			expect(relay.store.outboxFor(peer).map((e) => e.messageId)).toEqual([
				m.id,
			]);
			expect(relay.store.getMessage(m.id)?.body).toBe("racing the flush");
			expect(relay.store.receipt(m.id, address())?.state).not.toBe("withdrawn");
			// The answer came back as a retry: it waits again and can be withdrawn.
			relay.store.outboxMarkSending(peer, [m.id], false);
			const r = await relay.service.queue.act(
				USER,
				address(),
				m.id,
				"withdraw",
			);
			expect(r.receipt?.state).toBe("withdrawn");
		} finally {
			tailnet.setOnline("home", true);
		}
	});
});
