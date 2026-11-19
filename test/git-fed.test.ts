import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Federation } from "../src/federation/index.ts";
import { PoolMembers } from "../src/federation/members.ts";
import type { GitStatus } from "../src/http/wire.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { fakeGh } from "./fake-gh.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { cleanupRepos, g, gitRepo, tmpFolder } from "./git-repo.ts";
import { registration, until } from "./helpers.ts";
import { SoftAuthenticator } from "./webauthn.ts";

/**
 * Git actions on an agent of another machine: the relay reads its status
 * and PR through the home node, and commit / push / PR run on the home
 * node only with an assertion the home node verifies for exactly those
 * params (src/service/acting.ts), through the relay's HTTP routes.
 */

setDefaultTimeout(30_000);

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const k of ["AUTHOR", "COMMITTER"]) {
	process.env[`GIT_${k}_NAME`] = "t";
	process.env[`GIT_${k}_EMAIL`] = "t@example.com";
}
const gh = fakeGh();
process.env.FAKE_GH_DIR = gh.dir;
process.env.PATH = `${gh.dir}:${process.env.PATH ?? ""}`;

const OWNER = "me@example.com";
const TAILNET_RP = "tail-fake.ts.net";
const originOf = (name: string) => `https://${name}.tail-fake.ts.net:7337`;
const rpOf = (name: string) => ({
	rpId: TAILNET_RP,
	origins: [originOf(name)],
});

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
	const dir = mkdtempSync(join(tmpdir(), `pulsar-gitfed-${name}-`));
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

let home: Node;
let relay: Node;
let repo: string;
let bare: string;
let address: string;
let homeAgent: string;
let phone: SoftAuthenticator;

beforeAll(async () => {
	tailnet.add("phone");
	home = await startNode("home");
	relay = await startNode("relay");
	bare = tmpFolder();
	g(bare, "init", "-q", "--bare");
	repo = gitRepo();
	g(repo, "remote", "add", "origin", "https://github.com/acme/demo.git");
	g(repo, "config", "remote.origin.pushurl", bare);
	g(repo, "push", "-q", "-u", "origin", "main");
	g(repo, "switch", "-q", "-c", "feat");
	const controller = new AbortController();
	const caller: Caller = {
		principal: { kind: "terminal" },
		closed: controller.signal,
		emit: () => {},
	};
	home.service.attach(caller);
	home.service.setRole(caller, "extension");
	homeAgent = home.service.registerAgent(
		caller,
		registration({ name: "hotel", project: "demo", cwd: repo }),
	).id;
	for (const n of nodes) await n.fed.discover();
	address = `${home.service.machineId}/${homeAgent}`;
	await until(() => relay.service.registry.find(address) !== undefined, 5000);
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
	cleanupRepos();
});

/** The phone using the relay's app. */
const api = (path: string, body?: unknown) =>
	tailnet.request("phone", "relay", `/api/v1${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"X-Pulsar": "1",
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

/** Options for one act from the home node (via the relay), signed on the relay's origin. */
async function signed(op: string, params: unknown) {
	const res = await api("/acting/options", { op, agent: address, params });
	expect(res.status).toBe(200);
	return phone.assert((await res.json()) as { challenge: string }, {
		origin: originOf("relay"),
	});
}

const enc = encodeURIComponent;

test("status and PR reads come from the home node", async () => {
	appendFileSync(join(repo, "a.txt"), "four\n");
	const res = await api(`/agents/${enc(address)}/git/status`);
	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({
		agent: address,
		available: true,
		branch: "feat",
		dirty: 1,
		github: true,
		gh: "ok",
	} satisfies Partial<GitStatus>);
	const pr = await api(`/agents/${enc(address)}/git/pr`);
	expect(await pr.json()).toMatchObject({ agent: address, pr: null });
});

test("commit, push, PR: one proof each, for exactly its params", async () => {
	gh.set({ prs: {}, next: 5 });
	const params = { files: ["a.txt"], message: "Relayed" };
	// Signed for other params: refused, nothing committed.
	let assertion = await signed("git.commit", { ...params, message: "Other" });
	let res = await api(`/agents/${enc(address)}/git/commit`, {
		...params,
		assertion,
	});
	expect(res.status).toBe(403);
	expect(g(repo, "log", "-1", "--format=%s").trim()).toBe("init");
	// No assertion at all.
	res = await api(`/agents/${enc(address)}/git/commit`, params);
	expect(res.status).toBe(401);

	assertion = await signed("git.commit", params);
	res = await api(`/agents/${enc(address)}/git/commit`, {
		...params,
		assertion,
	});
	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({
		branch: "feat",
		subject: "Relayed",
	});
	// Spent: the same assertion again is refused.
	res = await api(`/agents/${enc(address)}/git/commit`, {
		...params,
		assertion,
	});
	expect(res.status).toBe(403);

	res = await api(`/agents/${enc(address)}/git/push`, {
		assertion: await signed("git.push", {}),
	});
	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({
		pushed: true,
		upstream: "origin/feat",
	});
	expect(g(bare, "log", "-1", "--format=%s", "feat").trim()).toBe("Relayed");

	res = await api(`/agents/${enc(address)}/git/pr`, {
		assertion: await signed("git.pr", {}),
	});
	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({ created: true, pr: { number: 5 } });

	const audit = home.store.db
		.prepare("SELECT op, ok FROM audit WHERE op LIKE 'git.%' ORDER BY id")
		.all() as { op: string; ok: number }[];
	expect(audit.filter((a) => a.ok).map((a) => a.op)).toEqual([
		"git.commit.relayed",
		"git.commit",
		"git.push.relayed",
		"git.push",
		"git.pr.relayed",
		"git.pr",
	]);
});

test("the home node's refusal comes back with its message", async () => {
	// Nothing to commit now: the home node refuses with git's guard text.
	const params = { files: ["a.txt"], message: "Again" };
	const res = await api(`/agents/${enc(address)}/git/commit`, {
		...params,
		assertion: await signed("git.commit", params),
	});
	expect(res.status).toBe(409);
	const body = (await res.json()) as {
		error: { code: string; message: string };
	};
	expect(body.error).toEqual({
		code: "git_refused",
		message: "Worktree is clean. Make changes before committing.",
	});
});
