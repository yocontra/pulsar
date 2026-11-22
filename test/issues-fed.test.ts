import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Federation } from "../src/federation/index.ts";
import { PoolMembers } from "../src/federation/members.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { fakeGh } from "./fake-gh.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { cleanupRepos, g, gitRepo } from "./git-repo.ts";
import { registration, until } from "./helpers.ts";

/**
 * The issue card of an agent on another machine: its home node detects the
 * issue (branch fix-1378), reads it with gh and the relay passes the card
 * through (`issue.read`). The number comes from the home node's own tags.
 */

setDefaultTimeout(30_000);

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const gh = fakeGh();
process.env.FAKE_GH_DIR = gh.dir;
process.env.PATH = `${gh.dir}:${process.env.PATH ?? ""}`;

const OWNER = "me@example.com";

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
	const dir = mkdtempSync(join(tmpdir(), `pulsar-issuefed-${name}-`));
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
let address: string;
let homeAgent: string;

beforeAll(async () => {
	tailnet.add("phone");
	home = await startNode("home");
	relay = await startNode("relay");
	repo = gitRepo();
	g(repo, "remote", "add", "origin", "https://github.com/acme/demo.git");
	g(repo, "switch", "-q", "-c", "fix-1378");
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
		registration({
			name: "hotel",
			project: "demo",
			cwd: repo,
			branch: "fix-1378",
		}),
	).id;
	for (const n of nodes) await n.fed.discover();
	address = `${home.service.machineId}/${homeAgent}`;
	await until(() => relay.service.registry.find(address) !== undefined, 5000);
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

const enc = encodeURIComponent;

test("the relay reads a remote agent's issue on its home node", async () => {
	gh.set({
		prs: {},
		issues: {
			"1378": {
				number: 1378,
				title: "Crash on start",
				state: "OPEN",
				url: "https://github.com/acme/demo/issues/1378",
				labels: [{ name: "bug", color: "d73a4a" }],
				assignees: [{ login: "octo" }],
				author: { login: "reporter" },
				body: "It crashes.",
			},
		},
	});
	await home.service.issues.refresh();
	// The tag reaches the relay's copy of the agent.
	await until(
		() =>
			relay.service.registry.find(address)?.tags.includes("issue:1378") ===
			true,
		5000,
	);
	const res = await api(`/agents/${enc(address)}/issue`);
	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({
		agent: address,
		number: 1378,
		source: "branch",
		issue: {
			number: 1378,
			title: "Crash on start",
			state: "open",
			labels: [{ name: "bug", color: "d73a4a" }],
			assignees: ["octo"],
		},
	});
	// gh ran on the home node, against the agent's repo.
	expect(
		gh
			.calls()
			.findLast((c) => c[0] === "issue")
			?.slice(0, 5),
	).toEqual(["issue", "view", "1378", "--repo", "acme/demo"]);
});

test("no issue: 200 with no_issue; unknown agent: 404", async () => {
	g(repo, "switch", "-q", "-c", "main-2");
	home.service.registry.get(homeAgent)!.branch = "main-2";
	await home.service.issues.refresh();
	await until(
		() =>
			relay.service.registry
				.find(address)
				?.tags.some((t) => t.startsWith("issue:")) === false,
		5000,
	);
	const res = await api(`/agents/${enc(address)}/issue`);
	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({
		agent: address,
		number: null,
		issue: null,
		reason: "no_issue",
	});
	const missing = await api(
		`/agents/${enc(`${home.service.machineId}/nobody`)}/issue`,
	);
	expect(missing.status).toBe(404);
});
