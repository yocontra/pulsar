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
import {
	Federation,
	type FederationIntervals,
} from "../src/federation/index.ts";
import { PoolMembers } from "../src/federation/members.ts";
import type {
	DiagnosticsReport,
	MachineDiagnostics,
} from "../src/http/wire.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { VERSION } from "../src/version.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { until } from "./helpers.ts";

/**
 * Diagnostics across the pool on an in-process fake tailnet: the viewer
 * runs its own doctor and asks the home node for its report (`diag.read`,
 * as the user); the home node redacts its report before it leaves.
 * Doctor itself is faked (its checks: test/diagnostics.test.ts).
 */

setDefaultTimeout(20_000);

const OWNER = "me@example.com";
const FAST: Partial<FederationIntervals> = {
	discoverMs: 150,
	heartbeatMs: 200,
	missed: 5,
	coalesceMs: 30,
	linkIdleMs: 60_000,
	outboxTickMs: 40,
	receiptTickMs: 40,
	requestTimeoutMs: 2000,
};

interface Node {
	name: string;
	store: Store;
	service: PulsarService;
	http: HttpTransport;
	fed: Federation;
	runs: number;
	/** The next doctor run fails with this stderr. */
	fail: string | null;
}

/** The runners' clock: tests move it past the fresh-run throttle. */
let clock = 1_000_000;
const tailnet = new FakeTailnet();
const nodes: Node[] = [];
const root = mkdtempSync(join(tmpdir(), "pulsar-diag-fed-"));

/** What each node's fake doctor prints: a problem naming its home folder and a token. */
function doctorJson(name: string) {
	return JSON.stringify({
		version: VERSION,
		checks: [
			{ group: "daemon", level: "ok", text: `daemon on ${name}`, fix: null },
			{
				group: "mesh",
				level: "bad",
				text: `background service file /Users/${name}/Library/LaunchAgents/p.plist is missing (token=tok-${name}-secret)`,
				fix: "run `pulsar mesh on`",
			},
		],
		facts: {
			tailscale: {
				state: "running",
				version: "1.104.7",
				dnsName: `${name}.example.ts.net`,
				magicDns: true,
			},
			certDays: 60,
			harnesses: [
				{
					id: "claude",
					label: "Claude Code",
					version: "2.1.0",
					configured: true,
				},
			],
		},
	});
}

async function startNode(name: string): Promise<Node> {
	const dir = mkdtempSync(join(root, `${name}-`));
	const store = new Store(join(dir, "pulsar.db"));
	const node = { name, store, runs: 0, fail: null } as Node;
	const service = new PulsarService({
		store,
		scan: false,
		machine: name,
		push: { keyFile: join(dir, "vapid.json") },
		approvals: { probe: () => null },
		usage: { roots: () => ({}) as never, scan: false },
		diagnostics: {
			home: `/Users/${name}`,
			now: () => clock,
			doctor: async () => {
				node.runs++;
				if (node.fail) return { stdout: "", error: node.fail };
				return { stdout: `${doctorJson(name)}\n`, error: null };
			},
		},
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
		intervals: FAST,
	});
	http.fed = fed;
	tailnet.serve(name, http.app, http.port, 7337);
	service.start();
	await fed.start();
	Object.assign(node, { service, http, fed });
	nodes.push(node);
	return node;
}

async function api<T>(to: string, path: string) {
	const res = await tailnet.request("phone", to, `/api/v1${path}`, {
		headers: { "X-Pulsar": "1" },
	});
	return { status: res.status, body: (await res.json()) as T };
}

let home: Node;
let viewer: Node;

beforeAll(async () => {
	for (const n of ["home", "viewer", "phone"]) tailnet.add(n);
	home = await startNode("home");
	viewer = await startNode("viewer");
	for (const n of nodes) await n.fed.discover();
	await until(
		() =>
			viewer.fed
				.machines()
				.some((m) => m.name === "home" && m.link === "tailnet"),
		5000,
	);
});

afterAll(async () => {
	for (const n of nodes) {
		n.fed.stop();
		n.service.stop();
		await n.http.close();
		n.store.close();
	}
	rmSync(root, { recursive: true, force: true });
});

describe("diagnostics across the pool", () => {
	test("GET /diagnostics lists every machine at once, running no doctor", async () => {
		const before = [home.runs, viewer.runs];
		const r = await api<DiagnosticsReport>("viewer", "/diagnostics");
		expect(r.status).toBe(200);
		expect(
			r.body.machines.map((m) => [
				m.name,
				m.self,
				m.pending,
				m.report,
				m.error,
			]),
		).toEqual([
			["viewer", true, true, null, null],
			["home", false, true, null, null],
		]);
		expect(r.body.machines[1]!.machineId).toBe(home.service.machineId);
		expect(r.body.machines[1]!.version).toBe(VERSION);
		expect(r.body.newest).toBe(VERSION);
		expect([home.runs, viewer.runs]).toEqual(before);
	});

	test("GET /diagnostics/:machine shows a machine's checks, made and redacted by that machine", async () => {
		const r = await api<MachineDiagnostics>(
			"viewer",
			`/diagnostics/${home.service.machineId}`,
		);
		expect(r.status).toBe(200);
		const remote = r.body;
		expect(remote).toMatchObject({
			name: "home",
			self: false,
			pending: false,
			error: null,
			version: VERSION,
			upgrade: null,
		});
		expect(remote.report!.checks).toEqual([
			{ group: "daemon", level: "ok", text: "daemon on home", fix: null },
			{
				group: "mesh",
				level: "bad",
				text: "background service file ~/Library/LaunchAgents/p.plist is missing (token=[redacted])",
				fix: "run `pulsar mesh on`",
			},
		]);
		expect(remote.report!.facts.tailscale).toEqual({
			state: "running",
			version: "1.104.7",
			dnsName: "home.example.ts.net",
			magicDns: true,
		});
		expect(remote.report!.facts.harnesses[0]).toMatchObject({
			id: "claude",
			version: "2.1.0",
		});
		expect(typeof remote.report!.uptimeS).toBe("number");
		const raw = JSON.stringify(r.body);
		expect(raw).not.toContain("tok-home-secret");
		expect(raw).not.toContain("/Users/home");
		const mine = await api<MachineDiagnostics>(
			"viewer",
			`/diagnostics/${viewer.service.machineId}`,
		);
		expect(mine.body).toMatchObject({
			name: "viewer",
			self: true,
			error: null,
		});
		expect(mine.body.report!.checks[0]!.text).toBe("daemon on viewer");
		expect(JSON.stringify(mine.body)).not.toContain("/Users/viewer");
	});

	test("refresh=1 runs that machine's doctor again; otherwise a recent report is reused", async () => {
		const path = `/diagnostics/${home.service.machineId}`;
		await api<MachineDiagnostics>("viewer", path);
		const before = home.runs;
		await api<MachineDiagnostics>("viewer", path);
		expect(home.runs).toBe(before);
		// Fresh, but within 3 s of the last run: the same report.
		await api<MachineDiagnostics>("viewer", `${path}?refresh=1`);
		expect(home.runs).toBe(before);
		clock += 4000;
		const r = await api<MachineDiagnostics>("viewer", `${path}?refresh=1`);
		expect(r.status).toBe(200);
		expect(home.runs).toBe(before + 1);
	});

	test("an unknown machine is not found", async () => {
		const r = await api<{ error: { code: string } }>(
			"viewer",
			"/diagnostics/no-such-machine",
		);
		expect(r.status).toBe(404);
	});

	test("a failed doctor says why, redacted before it leaves its machine", async () => {
		home.fail =
			"Error: EACCES /Users/home/.config/pulsar/settings.json (auth token=tok-home-leak)";
		clock += 4000;
		try {
			const r = await api<MachineDiagnostics>(
				"viewer",
				`/diagnostics/${home.service.machineId}?refresh=1`,
			);
			expect(r.status).toBe(200);
			const remote = r.body;
			expect(remote.report).toBeNull();
			expect(remote.error).toBe(
				"doctor did not answer: Error: EACCES ~/.config/pulsar/settings.json (auth token=[redacted])",
			);
		} finally {
			home.fail = null;
			clock += 20_000;
		}
	});

	test("a bad query is refused", async () => {
		const r = await api<{ error: { code: string } }>(
			"viewer",
			`/diagnostics/${home.service.machineId}?refresh=yes`,
		);
		expect(r.status).toBe(400);
	});
});
