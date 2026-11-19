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
import { actDigest } from "../src/service/acting.ts";
import type { Caller, Principal } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { registration, until } from "./helpers.ts";
import { SoftAuthenticator } from "./webauthn.ts";

/**
 * Acting ops (src/service/acting.ts): Prove Human on this node, and on a
 * remote agent the home node's own passkey check for the exact act. A
 * dummy handler stands in for the features (git, launch, attachments).
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
const VERIFIED = { ...USER, verified: true as const };

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
	const dir = mkdtempSync(join(tmpdir(), `pulsar-acting-${name}-`));
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
			missed: 5,
			coalesceMs: 30,
			linkIdleMs: 60_000,
			outboxTickMs: 40,
			receiptTickMs: 40,
			requestTimeoutMs: 2000,
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

function agentOn(n: Node, name: string) {
	const controller = new AbortController();
	const caller: Caller = {
		principal: { kind: "terminal" },
		closed: controller.signal,
		emit: () => {},
	};
	n.service.attach(caller);
	n.service.setRole(caller, "extension");
	return n.service.registerAgent(
		caller,
		registration({ name, project: "demo", cwd: "/work/demo" }),
	);
}

/** Calls each dummy handler received, per node. */
const calls = new Map<
	string,
	{ op: string; agent: string | null; params: unknown }[]
>();
function dummyHandlers(n: Node) {
	const got: { op: string; agent: string | null; params: unknown }[] = [];
	calls.set(n.name, got);
	for (const op of ["git.commit", "agents.launch"] as const)
		n.service.acting.register(op, async ({ user, agent, params }) => {
			// A handler always runs as a verified operator.
			expect(user.verified).toBe(true);
			got.push({ op, agent, params });
			return { done: op };
		});
}

function auditOps(
	n: Node,
	op: string,
): { principal: string; ok: number; detail: string | null }[] {
	return n.store.db
		.prepare("SELECT principal, ok, detail FROM audit WHERE op = ? ORDER BY id")
		.all(op) as { principal: string; ok: number; detail: string | null }[];
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
let homeAgent: string;
let relayAgent: string;
let phone: SoftAuthenticator;

beforeAll(async () => {
	tailnet.add("phone");
	home = await startNode("home");
	relay = await startNode("relay");
	dummyHandlers(home);
	dummyHandlers(relay);
	homeAgent = agentOn(home, "hotel").id;
	relayAgent = agentOn(relay, "romeo").id;
	for (const n of nodes) await n.fed.discover();
	await until(
		() =>
			relay.service.registry.find(`${home.service.machineId}/${homeAgent}`) !==
			undefined,
		5000,
	);
	// The phone's passkey, enrolled on the home node with its own code.
	phone = new SoftAuthenticator({
		origin: originOf("home"),
		rpId: TAILNET_RP,
	});
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

describe("acting ops on this node", () => {
	test("needs a passkey session; runs the handler and audits", async () => {
		const acting = relay.service.acting;
		const target = { agent: relayAgent };
		expect(await code(acting.run(USER, "git.commit", target, { m: 1 }))).toBe(
			"session_required",
		);
		const r = await acting.run(VERIFIED, "git.commit", target, { m: 1 });
		expect(r).toEqual({ done: "git.commit" });
		expect(calls.get("relay")!.at(-1)).toEqual({
			op: "git.commit",
			agent: relayAgent,
			params: { m: 1 },
		});
		const rows = auditOps(relay, "git.commit");
		expect(rows.at(-1)).toMatchObject({
			principal: `human:${OWNER}@phone`,
			ok: 1,
		});
	});

	test("agents and the terminal never act", async () => {
		const acting = relay.service.acting;
		const as: Principal[] = [
			{ kind: "agent", agentId: relayAgent },
			{ kind: "terminal" },
		];
		for (const p of as)
			expect(
				await code(acting.run(p, "git.commit", { agent: relayAgent }, {})),
			).toBe("forbidden");
	});

	test("a machine op runs here for an empty, own id or own name machine", async () => {
		const acting = relay.service.acting;
		for (const machine of [null, relay.service.machineId, "relay"]) {
			await acting.run(VERIFIED, "agents.launch", { machine }, { cwd: "/w" });
			expect(calls.get("relay")!.at(-1)).toEqual({
				op: "agents.launch",
				agent: null,
				params: { cwd: "/w" },
			});
		}
	});

	test("an op without a handler, or an unknown agent, fails", async () => {
		const acting = relay.service.acting;
		expect(
			await code(acting.run(VERIFIED, "git.push", { agent: relayAgent }, {})),
		).toBe("unsupported");
		expect(
			await code(acting.run(VERIFIED, "git.commit", { agent: "pi:nope" }, {})),
		).toBe("not_found");
		expect(auditOps(relay, "git.push").at(-1)).toMatchObject({ ok: 0 });
	});

	test("a failing handler is audited as failed", async () => {
		const off = relay.service.acting.register("git.pr", async () => {
			throw new Error("gh: not logged in");
		});
		try {
			expect(
				await code(
					relay.service.acting.run(
						VERIFIED,
						"git.pr",
						{ agent: relayAgent },
						{},
					),
				),
			).toBe("gh: not logged in");
			const row = auditOps(relay, "git.pr").at(-1)!;
			expect(row.ok).toBe(0);
			expect(row.detail).toContain("not logged in");
		} finally {
			off();
		}
	});
});

describe("acting ops on another machine: the home node's proof", () => {
	const address = () => `${home.service.machineId}/${homeAgent}`;
	/** Options from the home node via the relay; the phone signs on the relay's app. */
	async function sign(
		op: "git.commit" | "agents.launch",
		target: { agent?: string; machine?: string },
		params: unknown,
	) {
		const options = (await relay.service.acting.options(
			USER,
			op,
			target,
			params,
		)) as { challenge: string };
		return phone.assert(options, { origin: originOf("relay") });
	}

	test("the home node verifies, runs and audits the act", async () => {
		const params = { message: "fix", files: ["a.ts"] };
		const assertion = await sign("git.commit", { agent: address() }, params);
		const r = await relay.service.acting.run(
			USER,
			"git.commit",
			{ agent: address() },
			params,
			assertion,
		);
		expect(r).toEqual({ done: "git.commit" });
		expect(calls.get("home")!.at(-1)).toEqual({
			op: "git.commit",
			agent: homeAgent,
			params,
		});
		const relayed = auditOps(home, "git.commit.relayed").at(-1)!;
		expect(relayed.principal).toBe(`human:${OWNER}@phone`);
		expect(JSON.parse(relayed.detail!)).toEqual({
			device: "iPhone",
			via: "relay",
		});
		expect(auditOps(home, "git.commit").at(-1)).toMatchObject({ ok: 1 });
	});

	test("a machine op on another machine, by name", async () => {
		const assertion = await sign(
			"agents.launch",
			{ machine: "home" },
			{ h: 1 },
		);
		await relay.service.acting.run(
			USER,
			"agents.launch",
			{ machine: "home" },
			{ h: 1 },
			assertion,
		);
		expect(calls.get("home")!.at(-1)).toEqual({
			op: "agents.launch",
			agent: null,
			params: { h: 1 },
		});
	});

	test("without an assertion, nothing reaches the home node", async () => {
		const before = calls.get("home")!.length;
		expect(
			await code(
				relay.service.acting.run(
					VERIFIED,
					"git.commit",
					{ agent: address() },
					{},
				),
			),
		).toBe("session_required");
		expect(calls.get("home")!.length).toBe(before);
	});

	test("an assertion covers exactly one op, target and set of params, once", async () => {
		const before = calls.get("home")!.length;
		const run = (
			op: "git.commit" | "agents.launch",
			target: { agent?: string; machine?: string },
			params: unknown,
			assertion: unknown,
		) => code(relay.service.acting.run(USER, op, target, params, assertion));
		// Other params than were signed (a relay swapping the payload).
		let a = await sign("git.commit", { agent: address() }, { message: "ok" });
		expect(
			await run("git.commit", { agent: address() }, { message: "evil" }, a),
		).toBe("bad_assertion");
		// Another op than was signed.
		a = await sign("agents.launch", { machine: "home" }, {});
		expect(await run("git.commit", { agent: address() }, {}, a)).toBe(
			"bad_assertion",
		);
		// Replay: spent on first use, whether or not it verified.
		a = await sign("git.commit", { agent: address() }, { n: 1 });
		expect(await run("git.commit", { agent: address() }, { n: 1 }, a)).toBe(
			"ok",
		);
		expect(await run("git.commit", { agent: address() }, { n: 1 }, a)).toBe(
			"bad_assertion",
		);
		expect(calls.get("home")!.length).toBe(before + 1);
	});

	test("a forged /fed frame grants nothing", async () => {
		const before = calls.get("home")!.length;
		const peer = relay.fed.state.peers.get(home.service.machineId)!;
		const frame = (as: object, assertion: unknown = {}) =>
			relay.fed.post(peer, [
				{
					type: "act",
					as: as as never,
					action: {
						op: "acting.run",
						name: "git.commit",
						agent: homeAgent,
						params: {},
						assertion,
					},
				},
			]);
		// The owner with a junk assertion (a `verified` claim is ignored).
		const [owner] = await frame({
			kind: "user",
			login: OWNER,
			node: "relay",
			verified: true,
		});
		expect(owner).toMatchObject({ ok: false, code: "bad_assertion" });
		// Another login, an agent, the relay's terminal.
		const [eve] = await frame({
			kind: "user",
			login: "eve@example.com",
			node: "relay",
		});
		expect(eve).toMatchObject({ ok: false, code: "forbidden" });
		for (const kind of ["agent", "operator"]) {
			const [r] = await frame({ kind, node: "relay" });
			expect(r).toMatchObject({ ok: false, code: "forbidden" });
		}
		// An op name that is not an acting op.
		const [odd] = await relay.fed.post(peer, [
			{
				type: "act",
				as: { kind: "user", login: OWNER, node: "relay" },
				action: {
					op: "acting.options",
					name: "shutdown",
					agent: homeAgent,
					params: {},
				},
			},
		]);
		expect(odd).toMatchObject({ ok: false, code: "bad_request" });
		expect(calls.get("home")!.length).toBe(before);
	});

	test("the challenge digest is over canonical params (key order does not matter)", () => {
		expect(actDigest({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(
			actDigest({ b: [2, { d: 4, c: 3 }], a: 1 }),
		);
		expect(actDigest({ a: 1 })).not.toBe(actDigest({ a: 2 }));
	});

	test("POST /acting/options on the relay returns the home node's challenge", async () => {
		const res = await tailnet.request(
			"phone",
			"relay",
			"/api/v1/acting/options",
			{
				method: "POST",
				headers: { "X-Pulsar": "1", "Content-Type": "application/json" },
				body: JSON.stringify({
					op: "git.commit",
					agent: address(),
					params: { message: "x" },
				}),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { challenge?: string };
		expect(typeof body.challenge).toBe("string");
		// A local agent needs no options.
		const local = await tailnet.request(
			"phone",
			"relay",
			"/api/v1/acting/options",
			{
				method: "POST",
				headers: { "X-Pulsar": "1", "Content-Type": "application/json" },
				body: JSON.stringify({ op: "git.commit", agent: relayAgent }),
			},
		);
		expect(local.status).toBe(400);
	});
});
