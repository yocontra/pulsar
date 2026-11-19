import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Federation } from "../src/federation/index.ts";
import { PoolMembers } from "../src/federation/members.ts";
import type { AttachmentUpload } from "../src/http/wire.ts";
import { ATTACH_LIMITS } from "../src/service/attachments.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { registration, until } from "./helpers.ts";
import { SoftAuthenticator } from "./webauthn.ts";

/**
 * Attachments for an agent on another machine: one passkey check on the
 * home node covers the signed manifest; the relay forwards each file's
 * bytes in chunks, which the home node takes only into that upload and
 * keeps only when they match the signed hashes.
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
	const dir = mkdtempSync(join(tmpdir(), `pulsar-attach-fed-${name}-`));
	const store = new Store(join(dir, "pulsar.db"));
	const service = new PulsarService({
		store,
		scan: false,
		machine: name,
		push: { keyFile: join(dir, "vapid.json") },
		approvals: { probe: () => null },
		attachments: { dir: () => join(dir, "attachments") },
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

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const streamOf = (data: Uint8Array, piece = 64 * 1024) =>
	new ReadableStream<Uint8Array>({
		start(c) {
			for (let i = 0; i < data.length; i += piece)
				c.enqueue(data.subarray(i, i + piece));
			c.close();
		},
	});

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

async function openRemote(manifest: unknown): Promise<AttachmentUpload> {
	const options = (await relay.service.acting.options(
		USER,
		"attachments.upload",
		{ agent: address() },
		manifest,
	)) as { challenge: string };
	const assertion = phone.assert(options, { origin: originOf("relay") });
	return (await relay.service.acting.run(
		USER,
		"attachments.upload",
		{ agent: address() },
		manifest,
		assertion,
	)) as AttachmentUpload;
}

describe("attachments for an agent on another machine", () => {
	test("one proof, chunked bytes, saved on the home node", async () => {
		const big = Buffer.alloc(ATTACH_LIMITS.chunkBytes * 2 + 12345, 3);
		const small = Buffer.from("hello from the phone\n");
		const manifest = {
			nonce: "fed0000000000000000001",
			files: [
				{ name: "big.bin", type: "", size: big.length, sha256: sha(big) },
				{
					name: "hi.txt",
					type: "text/plain",
					size: small.length,
					sha256: sha(small),
				},
			],
		};
		const up = await openRemote(manifest);
		const a = await relay.service.attachments.receive(
			USER,
			address(),
			up.upload,
			0,
			streamOf(big),
		);
		const b = await relay.service.attachments.receive(
			USER,
			address(),
			up.upload,
			1,
			streamOf(small),
		);
		expect(a.file.size).toBe(big.length);
		expect(a.file.path.startsWith(join(home.dir, "attachments"))).toBe(true);
		expect(sha(readFileSync(a.file.path))).toBe(sha(big));
		expect(readFileSync(b.file.path, "utf8")).toBe("hello from the phone\n");
		expect(statSync(b.file.path).mode & 0o777).toBe(0o600);
		// Three chunks for the big file, one for the small one.
		const chunks = home.store.db
			.prepare(
				"SELECT COUNT(*) AS n FROM audit WHERE op = 'fed.attachments.chunk'",
			)
			.get() as { n: number };
		expect(chunks.n).toBe(4);
		const relayed = home.store.db
			.prepare(
				"SELECT detail FROM audit WHERE op = 'attachments.upload.relayed'",
			)
			.get() as { detail: string };
		expect(JSON.parse(relayed.detail)).toEqual({
			device: "iPhone",
			via: "relay",
		});
	});

	test("bytes that don't match the signed hash are not kept", async () => {
		const data = Buffer.from("the real file");
		const up = await openRemote({
			nonce: "fed0000000000000000002",
			files: [
				{ name: "a.txt", type: "", size: data.length, sha256: sha(data) },
			],
		});
		await expect(
			relay.service.attachments.receive(
				USER,
				address(),
				up.upload,
				0,
				streamOf(Buffer.from("a forged file")),
			),
		).rejects.toThrow("changed in transit");
	});

	test("no upload without the home node's proof; an agent never uploads", async () => {
		await expect(
			relay.service.acting.run(
				USER,
				"attachments.upload",
				{ agent: address() },
				{ nonce: "fed0000000000000000003", files: [] },
			),
		).rejects.toMatchObject({ code: "session_required" });
		await expect(
			relay.service.attachments.receive(
				{ kind: "agent", agentId: "x" },
				address(),
				"nope",
				0,
				streamOf(Buffer.from("x")),
			),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(
			relay.service.attachments.receive(
				USER,
				address(),
				"made-up-upload",
				0,
				streamOf(Buffer.from("x")),
			),
		).rejects.toMatchObject({ code: "not_found" });
	});

	test("@ files of a remote agent come from its home node", async () => {
		const r = await relay.service.files.search(address(), "", USER);
		// The home agent's folder (/work/demo) does not exist there.
		expect(r).toMatchObject({
			agent: address(),
			available: false,
			reason: "not_git",
		});
	});
});
