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
import type { CommandCatalog, ControlResult } from "../src/http/wire.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { registration, until } from "./helpers.ts";
import { SoftAuthenticator } from "./webauthn.ts";

/**
 * Modes and slash commands of an agent on another machine: the relay reads
 * them through the home node (`controls.read`), and running a command is
 * an acting op the home node verifies itself (one passkey assertion for
 * exactly that line). The home agent is a pi session whose extension
 * answers `control` requests.
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
	const dir = mkdtempSync(join(tmpdir(), `pulsar-controls-fed-${name}-`));
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

const asked: Array<Record<string, unknown>> = [];

function agentOn(n: Node, name: string) {
	const controller = new AbortController();
	let id = "";
	const caller: Caller = {
		principal: { kind: "terminal" },
		closed: controller.signal,
		// The pulsar extension's side (src/extension.ts `control`).
		emit: (event, data) => {
			if (event !== "control") return;
			const req = data as Record<string, unknown>;
			asked.push(req);
			queueMicrotask(() =>
				n.service.controls.answer(id, {
					requestId: req.requestId,
					result: "ok",
					...(req.kind === "commands"
						? {
								commands: [
									{
										name: "deploy",
										description: "Ship it",
										source: "extension",
									},
								],
							}
						: {}),
				}),
			);
		},
	};
	n.service.attach(caller);
	n.service.setRole(caller, "extension");
	const agent = n.service.registerAgent(
		caller,
		registration({ name, project: "demo", cwd: "/work/demo" }),
	);
	id = agent.id;
	return agent;
}

let home: Node;
let relay: Node;
let homeAgent: string;
let phone: SoftAuthenticator;
const address = () => `${home.service.machineId}/${homeAgent}`;

beforeAll(async () => {
	tailnet.add("phone");
	home = await startNode("home");
	relay = await startNode("relay");
	homeAgent = agentOn(home, "hotel").id;
	agentOn(relay, "romeo");
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

describe("modes and slash commands of an agent on another machine", () => {
	test("its modes and its / menu come from its home node", async () => {
		const modes = await relay.service.controls.modes(address(), USER);
		expect(modes).toMatchObject({
			agentId: address(),
			modes: [],
			canSwitch: false,
		});
		const cat = (await relay.service.controls.commands(
			address(),
			USER,
		)) as CommandCatalog;
		expect(cat).toMatchObject({
			agentId: address(),
			harness: "pi",
			runnable: true,
		});
		expect(cat.commands).toContainEqual(
			expect.objectContaining({ name: "compact", source: "builtin" }),
		);
		expect(cat.commands).toContainEqual(
			expect.objectContaining({ name: "deploy", source: "user" }),
		);
	});

	test("a command runs only with the home node's proof for exactly that line", async () => {
		asked.length = 0;
		const params = { line: "/deploy now" };
		// No proof: refused, nothing reaches the session.
		await expect(
			relay.service.acting.run(
				USER,
				"agents.command",
				{ agent: address() },
				params,
			),
		).rejects.toThrow();
		expect(asked.filter((r) => r.kind === "command")).toEqual([]);
		const options = (await relay.service.acting.options(
			USER,
			"agents.command",
			{ agent: address() },
			params,
		)) as { challenge: string };
		const assertion = phone.assert(options, { origin: originOf("relay") });
		// A proof for one line does not run another.
		await expect(
			relay.service.acting.run(
				USER,
				"agents.command",
				{ agent: address() },
				{ line: "/exit" },
				assertion,
			),
		).rejects.toThrow();
		const r = (await relay.service.acting.run(
			USER,
			"agents.command",
			{ agent: address() },
			params,
			phone.assert(
				(await relay.service.acting.options(
					USER,
					"agents.command",
					{ agent: address() },
					params,
				)) as { challenge: string },
				{ origin: originOf("relay") },
			),
		)) as ControlResult;
		expect(r).toMatchObject({ result: "ok", via: "extension" });
		expect(asked.filter((x) => x.kind === "command")).toEqual([
			expect.objectContaining({ kind: "command", line: "/deploy now" }),
		]);
		const relayed = home.store.db
			.prepare("SELECT detail FROM audit WHERE op = 'agents.command.relayed'")
			.get() as { detail: string } | undefined;
		expect(relayed).toBeDefined();
	});
});
