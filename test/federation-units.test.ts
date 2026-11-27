import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPoolConfig } from "../src/federation/config.ts";
import { LocalFeed } from "../src/federation/local.ts";
import { PoolMembers } from "../src/federation/members.ts";
import {
	negotiate,
	parseHello,
	protocolRange,
} from "../src/federation/protocol.ts";
import { readSse, sseStream } from "../src/federation/sse.ts";
import { cleanFedAgent, PoolState } from "../src/federation/state.ts";
import {
	isTailnetName,
	magicDnsSuffix,
	parseStatus,
	TailscaleTailnet,
	tailnetRpId,
} from "../src/federation/tailnet.ts";
import { parseWhois } from "../src/http/identity.ts";
import { authorize, PulsarService } from "../src/service/index.ts";
import { probePeerPulsar, probePeers } from "../src/setup/mesh.ts";
import { Store } from "../src/store.ts";
import { FakePresence, fakeCaller } from "./presence-fake.ts";

const STATUS = {
	BackendState: "Running",
	Self: {
		ID: "n1",
		StableID: "nSelf",
		DNSName: "studio.tail1234.ts.net.",
		UserID: 7,
		Online: true,
	},
	Peer: {
		key1: {
			StableID: "nMbp",
			DNSName: "mbp.tail1234.ts.net.",
			UserID: 7,
			Online: true,
		},
		key2: {
			StableID: "nCi",
			DNSName: "ci.tail1234.ts.net.",
			UserID: 99,
			Tags: ["tag:ci"],
			Online: true,
		},
		key3: {
			StableID: "nEve",
			DNSName: "eve-laptop.tail1234.ts.net.",
			UserID: 8,
			Online: false,
		},
		bad: { DNSName: "" },
	},
	User: {
		"7": { LoginName: "me@example.com" },
		"8": { LoginName: "eve@example.com" },
		"99": { LoginName: "tagged-devices" },
	},
};

describe("tailnet status", () => {
	test("parses self, peers, owners and tags", () => {
		const st = parseStatus(STATUS)!;
		expect(st.self.name).toBe("studio");
		expect(st.self.ownerLogin).toBe("me@example.com");
		expect(st.peers.map((p) => p.name)).toEqual(["mbp", "ci", "eve-laptop"]);
		expect(st.peers[1]!.tags).toEqual(["tag:ci"]);
		expect(st.peers[2]!.login).toBe("eve@example.com");
		expect(st.peers[2]!.online).toBe(false);
		expect(parseStatus({ ...STATUS, BackendState: "Stopped" })).toBeNull();
	});

	test("this node's Tailscale addresses (the app listens on them)", () => {
		const st = parseStatus({
			...STATUS,
			Self: {
				...STATUS.Self,
				TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1", "192.168.1.2"],
			},
		})!;
		expect(st.self.ips).toEqual(["100.64.0.1", "fd7a:115c:a1e0::1"]);
		expect(parseStatus(STATUS)!.self.ips).toBeUndefined();
	});

	test("status node ids join whois node ids (the shapes the real CLI prints)", () => {
		// Real `tailscale status --json` has a string `ID` and no `StableID`;
		// `tailscale whois --json` has a numeric `ID` and `StableID` equal to it.
		const status = parseStatus({
			BackendState: "Running",
			Self: {
				ID: "nAbC123CNTRL",
				DNSName: "laptop.tail0000.ts.net.",
				UserID: 6643400182934621,
				TailscaleIPs: ["100.91.0.1"],
				Tags: null,
			},
			Peer: {
				"nodekey:1": {
					ID: "nXyZ789CNTRL",
					DNSName: "studio.tail0000.ts.net.",
					UserID: 6643400182934621,
					Online: true,
					Tags: null,
				},
			},
			User: { "6643400182934621": { LoginName: "me@example.com" } },
		})!;
		const whois = parseWhois({
			Node: {
				ID: 6923766725958414,
				StableID: "nXyZ789CNTRL",
				Name: "studio.tail0000.ts.net.",
				ComputedName: "studio",
			},
			UserProfile: { LoginName: "me@example.com" },
		})!;
		expect(status.self.nodeId).toBe("nAbC123CNTRL");
		expect(status.self.ownerLogin).toBe("me@example.com");
		expect(status.peers[0]!.nodeId).toBe(whois.nodeId);
		expect(status.peers[0]!.login).toBe(whois.login);
		expect(status.peers[0]!.tags).toEqual([]);
	});

	test("a tagged self has no owner", () => {
		const st = parseStatus({
			...STATUS,
			Self: { ...STATUS.Self, UserID: 99, Tags: ["tag:server"] },
		})!;
		expect(st.self.ownerLogin).toBeNull();
	});

	test("requests go only to this tailnet's MagicDNS names, only under /fed/v1", async () => {
		const ts = "tail1234.ts.net";
		expect(isTailnetName("studio.tail1234.ts.net", ts)).toBe(true);
		expect(isTailnetName("evil.com", ts)).toBe(false);
		expect(isTailnetName("studio.ts.net.evil.com", ts)).toBe(false);
		expect(isTailnetName("a.b.tail1234.ts.net", ts)).toBe(false);
		expect(isTailnetName("studio.tail9999.ts.net", ts)).toBe(false);
		expect(isTailnetName("studio.tail1234.ts.net", null)).toBe(false);
		// Headscale: any base domain.
		const hs = "mesh.corp.example";
		expect(isTailnetName("pulsar-hs-a.mesh.corp.example", hs)).toBe(true);
		expect(isTailnetName("PULSAR-HS-A.Mesh.Corp.Example.", hs)).toBe(true);
		expect(isTailnetName("mesh.corp.example", hs)).toBe(false);
		expect(isTailnetName("x.corp.example", hs)).toBe(false);
		expect(isTailnetName("bad_name.mesh.corp.example", hs)).toBe(false);
		expect(magicDnsSuffix("studio.mesh.corp.example.")).toBe(hs);
		expect(magicDnsSuffix("studio")).toBeNull();
		const t = new TailscaleTailnet(7337, async () => ({
			ok: false,
			stdout: "",
			stderr: "",
		}));
		const node = {
			nodeId: "x",
			name: "x",
			dnsName: "x.example.com",
			userId: null,
			login: null,
			tags: [],
			online: true,
		};
		await expect(t.fetch(node, "/fed/v1/hello")).rejects.toThrow(
			"not a tailnet name",
		);
		await expect(
			t.fetch({ ...node, dnsName: "x.tail1.ts.net" }, "/api/v1/agents"),
		).rejects.toThrow("/fed/v1");
		expect(await t.status()).toBeNull();
	});
});

describe("pool membership (by Tailscale node id; changed only through the daemon)", () => {
	const st = parseStatus(STATUS)!;
	const [mbp, ci, eve] = st.peers as [
		(typeof st.peers)[0],
		(typeof st.peers)[0],
		(typeof st.peers)[0],
	];
	const OWNER = "me@example.com";
	const row = (
		n: { nodeId: string; name: string; login: string | null },
		verdict: "allow" | "deny",
	) => ({ nodeId: n.nodeId, name: n.name, login: n.login, verdict, at: 0 });

	test("owner nodes join; tagged nodes only when allowed; deny wins", () => {
		const m = new PoolMembers(null);
		expect(m.admits(mbp, OWNER)).toBe(true);
		expect(m.admits(ci, OWNER)).toBe(false);
		expect(m.admits(eve, OWNER)).toBe(false);
		m.set(row(ci, "allow"));
		expect(m.admits(ci, OWNER)).toBe(true);
		m.set(row(mbp, "deny"));
		expect(m.admits(mbp, OWNER)).toBe(false);
	});

	test("a renamed node is still denied; another node with an allowed name is not admitted (F4)", () => {
		const m = new PoolMembers(null);
		m.set({
			nodeId: "n-old",
			name: "old-laptop",
			login: OWNER,
			verdict: "deny",
			at: 0,
		});
		m.set({
			nodeId: "n-ci",
			name: "ci-runner",
			login: "tagged-devices",
			verdict: "allow",
			at: 0,
		});
		// The denied node renamed itself: same node id, still denied.
		expect(
			m.admitsCaller(
				{ login: OWNER, node: "old-laptop-2", nodeId: "n-old" },
				OWNER,
			),
		).toBe(false);
		// Another user's node took the allowed name: different node id, refused.
		expect(
			m.admitsCaller(
				{ login: "eve@example.com", node: "ci-runner", nodeId: "n-eve" },
				OWNER,
			),
		).toBe(false);
		// The allowed node changed owner (no longer tagged as before): refused.
		expect(
			m.admitsCaller(
				{ login: "eve@example.com", node: "ci-runner", nodeId: "n-ci" },
				OWNER,
			),
		).toBe(false);
		expect(
			m.admitsCaller(
				{ login: "tagged-devices", node: "renamed", nodeId: "n-ci" },
				OWNER,
			),
		).toBe(true);
	});

	test("`pulsar mesh` pool changes: agents may ask, the person confirms (OS prompt), denials apply nothing; audited and announced (F5)", async () => {
		const store = new Store(":memory:");
		const native = new FakePresence("denied", "granted");
		const service = new PulsarService({
			store,
			scan: false,
			machine: "m",
			presence: { native },
		});
		service.poolStatus = async () => st;
		const notices: string[] = [];
		service.events.on("security", (n) => notices.push(n.kind));
		const agent = service.registry.upsert({
			harness: "claude",
			sessionId: "s-pool",
			pid: null,
			cwd: "/repo",
			project: "repo",
			branch: "main",
			tags: [],
			meta: {},
			registered: true,
		});
		const agentP = { kind: "agent" as const, agentId: agent.id };
		// Agents may ask now: the authorize matrix lets them through.
		expect(() => authorize(agentP, "pool.change")).not.toThrow();
		const a = fakeCaller(agentP);
		// The person says no: nothing changes.
		await expect(
			service.poolAdmin.change(a.caller, "allow", "CI"),
		).rejects.toMatchObject({ code: "denied" });
		expect(service.poolMembers.admits(ci, OWNER)).toBe(false);
		// The prompt named the exact change and the agent that asked.
		expect(native.shown[0]).toContain("allow ci");
		expect(native.shown[0]).toContain("node nCi");
		expect(native.shown[0]).toContain(`agent ${agent.name} (claude)`);
		// The person confirms: applied.
		const r = await service.poolAdmin.change(a.caller, "allow", "CI");
		expect(r).toMatchObject({ ok: true, method: "Touch ID" });
		expect(r.change).toContain("node nCi");
		expect(service.poolMembers.admits(ci, OWNER)).toBe(true);
		expect(notices).toContain("pool-changed");
		expect(a.events.map((e) => e.event)).toEqual(["presence", "presence"]);
		const ops = (
			store.db.prepare("SELECT op, ok FROM audit ORDER BY id").all() as {
				op: string;
				ok: number;
			}[]
		).map((r) => `${r.op}:${r.ok}`);
		expect(ops).toContain("presence.denied:0");
		expect(ops).toContain("presence.granted:1");
		expect(ops).toContain("pool.change:1");
		// It is in the store: a new service on the same store still admits it.
		expect(new PoolMembers(store).admits(ci, OWNER)).toBe(true);
		// An unknown node name is refused before anyone is asked.
		const shown = native.shown.length;
		await expect(
			service.poolAdmin.change(a.caller, "allow", "nope"),
		).rejects.toMatchObject({ code: "not_found" });
		expect(native.shown.length).toBe(shown);
		// A linked peer or the app's user can't change the pool here.
		await expect(
			service.poolAdmin.change(
				fakeCaller({ kind: "peer", machineId: "x", node: "y" }).caller,
				"allow",
				"CI",
			),
		).rejects.toMatchObject({ code: "forbidden" });
		service.stop();
		store.close();
	});

	test("`pulsar mesh forget` drops the member row and the peer binding; `owner` checks the login", async () => {
		const store = new Store(":memory:");
		const clock = Date.now();
		const native = new FakePresence("granted", "granted");
		const service = new PulsarService({
			store,
			scan: false,
			machine: "m",
			presence: { native },
		});
		service.poolStatus = async () => st;
		const forgotten: string[] = [];
		service.onPoolForget = (id) => forgotten.push(id);
		const operator = fakeCaller({ kind: "terminal" as const }).caller;
		const peer = (machineId: string, name: string, node: string) => ({
			machineId,
			name,
			node,
			dnsName: `${name}.tailnet.ts.net`,
			allowed: true,
			pulsarVersion: "2.0.0",
			fedProtocol: [1, 1] as [number, number],
			lastSeen: 0,
		});
		store.savePeer(peer("mid-ci", ci.name, ci.nodeId), clock);
		store.savePeer(peer("mid-other", "other", "n-other"), clock);
		service.poolMembers.set(row(ci, "allow"));
		// By its MagicDNS name, trailing dot and all.
		const f = await service.poolAdmin.change(
			operator,
			"forget",
			`${ci.name}.tailnet.ts.net.`,
		);
		expect(f.change).toContain("and its machine id");
		expect(native.shown[0]).toContain("asked by a terminal on m");
		expect(
			service.poolMembers.entries().some((e) => e.nodeId === ci.nodeId),
		).toBe(false);
		expect(store.peers().map((p) => p.machineId)).toEqual(["mid-other"]);
		expect(forgotten).toEqual(["mid-ci"]);
		// Nothing matches: refused before anyone is asked.
		await expect(
			service.poolAdmin.change(operator, "forget", "nobody"),
		).rejects.toMatchObject({ code: "not_found" });
		// `owner` needs a login.
		await expect(
			service.poolAdmin.change(operator, "owner", "not-a-login"),
		).rejects.toMatchObject({ code: "bad_request" });
		await service.poolAdmin.change(operator, "owner", "me@example.com");
		expect(service.poolMembers.owner).toBe("me@example.com");
		expect(native.shown.length).toBe(2);
		service.stop();
		store.close();
	});

	test("pool.json is only a display copy: editing it changes nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pulsar-pool-"));
		const path = join(dir, "pool.json");
		try {
			const m = new PoolMembers(null, path);
			m.set(row(ci, "allow"));
			await m.flushMirror();
			expect(readPoolConfig(path).allow).toEqual(["ci"]);
			writeFileSync(path, JSON.stringify({ allow: ["eve-laptop"] }));
			expect(m.admits(eve, OWNER)).toBe(false);
			expect(readFileSync(path, "utf8")).toContain("eve-laptop");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("protocol", () => {
	test("negotiation picks the highest shared version", () => {
		expect(negotiate([1, 1], [1, 3])).toBe(1);
		expect(negotiate([1, 2], [1, 3])).toBe(2);
		expect(negotiate([1, 1], [2, 3])).toBeNull();
		expect(protocolRange([2, 1])).toBeNull();
		expect(protocolRange("1")).toBeNull();
		expect(protocolRange([1, 2])).toEqual([1, 2]);
	});

	test("SSE frames round-trip, split anywhere", async () => {
		const body = sseStream((send) => {
			send("delta", { seq: 1, text: "a\nb" });
			send("snapshot", { seq: 2 });
			return () => {};
		});
		const got: [string, unknown][] = [];
		const ac = new AbortController();
		const done = readSse(
			body,
			(e, d) => {
				got.push([e, JSON.parse(d)]);
				if (got.length === 2) ac.abort();
			},
			ac.signal,
		);
		await done;
		expect(got).toEqual([
			["delta", { seq: 1, text: "a\nb" }],
			["snapshot", { seq: 2 }],
		]);
	});
});

describe("registry gossip", () => {
	test("deltas are numbered; a seq the log dropped needs a snapshot", () => {
		const store = new Store(":memory:");
		const service = new PulsarService({ store, scan: false, machine: "m" });
		const feed = new LocalFeed(service, 2);
		const add = (i: number) =>
			service.registry.upsert({
				harness: "x",
				sessionId: `s${i}`,
				pid: null,
				cwd: null,
				project: "p",
				branch: null,
				tags: [],
				meta: {},
				registered: false,
				status: "idle",
			});
		add(0);
		expect(feed.tick()?.seq).toBe(1);
		expect(feed.tick()).toBeNull(); // nothing changed
		add(1);
		feed.tick();
		add(2);
		feed.tick();
		expect(feed.digest("m")).toMatchObject({ seq: 3, agentCount: 3 });
		expect(feed.since(feed.bootId, 3)).toEqual([]);
		expect(feed.since(feed.bootId, 1)?.map((d) => d.seq)).toEqual([2, 3]);
		expect(feed.since(feed.bootId, 0)).toBeNull(); // trimmed
		expect(feed.since("other-boot", 3)).toBeNull();
		expect(feed.snapshot().agents).toHaveLength(3);
		// A presence-only change (lastSeen within the minute) sends nothing.
		const one = service.registry.get("x:s0")!;
		// Within the same minute bucket (+1 s could cross into the next one).
		const minute = Math.floor(one.lastSeen / 60_000) * 60_000;
		one.lastSeen = one.lastSeen === minute ? minute + 1000 : minute;
		expect(feed.tick()).toBeNull();
		service.stop();
		store.close();
	});

	test("PoolState applies deltas in order and reports gaps", () => {
		const state = new PoolState();
		const peer = state.upsert(
			{
				nodeId: "n",
				name: "b",
				dnsName: "b.x.ts.net",
				userId: "u",
				login: "me",
				tags: [],
				online: true,
			},
			{
				fedProtocol: [1, 1],
				features: [],
				pulsarVersion: "x",
				machineId: "mb",
				name: "b",
			},
			1,
		);
		const rec = (id: string, extra: Record<string, unknown> = {}) => ({
			id,
			name: id,
			harness: "pi",
			tags: ["needs:you", "role:x"],
			status: "idle",
			...extra,
		});
		state.snapshot(peer, "boot1", 5, [rec("x1"), rec("bad/id"), { nope: 1 }]);
		expect(state.agents().map((a) => a.id)).toEqual(["mb/x1"]);
		expect(state.get("mb/x1")!.tags).toEqual(["role:x", "machine:b"]);
		expect(state.delta(peer, "boot1", 6, [rec("x2")], [])).toBe(true);
		expect(state.delta(peer, "boot1", 6, [rec("x3")], [])).toBe("stale");
		expect(state.delta(peer, "boot1", 8, [rec("x3")], [])).toBe(false);
		expect(state.delta(peer, "boot2", 7, [], [])).toBe(false);
		expect(state.delta(peer, "boot1", 7, [], ["x1"])).toBe(true);
		expect(state.agents().map((a) => a.id)).toEqual(["mb/x2"]);
		expect(
			cleanFedAgent({ id: "a", name: "a", harness: "h", status: "weird" })
				?.status,
		).toBe("unknown");
	});

	test("child observations are bounded, distinct, and unavailable until a reconnect receives a snapshot", () => {
		const state = new PoolState();
		const peer = state.upsert(
			{
				nodeId: "n",
				name: "b",
				dnsName: "b.test",
				userId: "u",
				login: "me",
				tags: [],
				online: true,
			},
			{
				fedProtocol: [1, 1],
				features: [],
				pulsarVersion: "x",
				machineId: "mb",
				name: "b",
			},
			1,
		);
		const child = (key: string, status = "busy") => ({
			key,
			status,
			name: key,
		});
		const rec = (children: unknown[]) => ({
			id: "claude:p",
			name: "parent",
			harness: "claude",
			childStatuses: children,
		});
		expect(
			cleanFedAgent(
				rec([
					child("a"),
					child("a", "idle"),
					child("invalid/path"),
					child("a".repeat(310)),
					child("invalid", "bad"),
					...Array.from({ length: 300 }, (_, i) => child(String(i))),
				]),
			)?.childStatuses,
		).toHaveLength(196);
		const changes: string[] = [];
		state.onChildStatus = (a) => changes.push(a.status);
		state.setLink(peer, "tailnet");
		state.snapshot(peer, "b1", 5, [rec([child("a")])]);
		state.snapshot(peer, "b1", 3, [rec([child("a", "idle")])]);
		expect(changes).toEqual([]);
		state.setLink(peer, "asleep");
		expect(state.observedSubagents()).toEqual([]);
		state.setLink(peer, "tailnet");
		expect(state.observedSubagents()).toEqual([]);
		expect(changes).toEqual([]);
		state.snapshot(peer, "b1", 6, [rec([child("a", "idle")])]);
		expect(changes).toEqual(["idle"]);
		expect(state.observedSubagents()[0]).toMatchObject({
			id: "mb/claude:p/sub:a",
			status: "idle",
		});
		state.snapshot(peer, "b1", 7, []);
		expect(changes).toEqual(["idle", "gone"]);
	});

	test("a peer's repo URL is kept only when it's a plain http(s) page", () => {
		const rec = (repoUrl: unknown) =>
			cleanFedAgent({ id: "a", name: "a", harness: "h", repoUrl });
		expect(rec("https://github.com/o/r")?.repoUrl).toBe(
			"https://github.com/o/r",
		);
		for (const bad of [
			"javascript:alert(1)",
			"https://user:token@github.com/o/r",
			"ssh://git@github.com/o/r",
			"https://github.com/o/r?t=1",
			`https://h.example/${"x".repeat(600)}`,
			7,
			null,
		])
			expect(rec(bad)?.repoUrl).toBeUndefined();
		// Older peers never send it: the record still fits.
		const old = cleanFedAgent({ id: "a", name: "a", harness: "h" });
		expect(old).not.toBeNull();
		expect("repoUrl" in old!).toBe(false);
		// It reaches the agent this node shows.
		const state = new PoolState();
		const peer = state.upsert(
			{
				nodeId: "n",
				name: "b",
				dnsName: "b.x.ts.net",
				userId: "u",
				login: "me",
				tags: [],
				online: true,
			},
			{
				fedProtocol: [1, 1],
				features: [],
				pulsarVersion: "x",
				machineId: "mb",
				name: "b",
			},
			1,
		);
		state.snapshot(peer, "boot1", 1, [
			{ id: "x", name: "x", harness: "h", repoUrl: "https://gitlab.com/g/r" },
		]);
		expect(state.get("mb/x")?.repoUrl).toBe("https://gitlab.com/g/r");
	});

	test("a snapshot doesn't announce prompts again, and still sees busy→idle", async () => {
		const state = new PoolState();
		const peer = state.upsert(
			{
				nodeId: "n",
				name: "b",
				dnsName: "b.x.ts.net",
				userId: "u",
				login: "me",
				tags: [],
				online: true,
			},
			{
				fedProtocol: [1, 1],
				features: [],
				pulsarVersion: "x",
				machineId: "mb",
				name: "b",
			},
			1,
		);
		const announced: string[] = [];
		const idle: string[] = [];
		state.onApproval = (a) => announced.push(`${a.requestId}:${a.state}`);
		state.onIdle = (address) => idle.push(address);
		const prompt = (state: string) => ({
			requestId: "q1",
			tool: "Bash",
			input: { command: "ls" },
			inputHash: "h",
			state,
			createdAt: 1,
			expiresAt: 2,
		});
		const rec = (status: string, approvals: unknown[]) => ({
			id: "x1",
			name: "x1",
			harness: "pi",
			tags: [],
			status,
			approvals,
		});
		state.snapshot(peer, "boot", 1, [rec("busy", [prompt("pending")])]);
		await Promise.resolve();
		expect(announced).toEqual(["mb/q1:pending"]);
		// A fresh snapshot (after a gap) with the same pending prompt: no new push.
		state.snapshot(peer, "boot", 9, [rec("idle", [prompt("pending")])]);
		await Promise.resolve();
		expect(announced).toEqual(["mb/q1:pending"]);
		expect(idle).toEqual(["mb/x1"]);
		// A change still announces.
		state.snapshot(peer, "boot", 12, [rec("idle", [prompt("allowed")])]);
		await Promise.resolve();
		expect(announced).toEqual(["mb/q1:pending", "mb/q1:allowed"]);
	});
});

describe("local ids", () => {
	test("never contain `/`, so a registration cannot pose as a pool address", () => {
		const store = new Store(":memory:");
		const service = new PulsarService({ store, scan: false, machine: "m" });
		const agent = service.registry.upsert({
			harness: "peer-machine/user",
			sessionId: "me@example.com/x",
			pid: null,
			cwd: null,
			project: null,
			branch: null,
			tags: [],
			meta: {},
			registered: false,
		});
		expect(agent.id).not.toContain("/");
		expect(service.registry.from(agent.id)).toBe(agent);
		service.stop();
		store.close();
	});
});

describe("security regressions (units)", () => {
	test("F7: peer strings lose control characters; reserved names and other machines are refused", () => {
		const state = new PoolState();
		const peer = state.upsert(
			{
				nodeId: "n",
				name: "b",
				dnsName: "b.x.ts.net",
				userId: "u",
				login: "me",
				tags: [],
				online: true,
			},
			{
				fedProtocol: [1, 1],
				features: [],
				pulsarVersion: "x",
				machineId: "mb",
				name: "b",
			},
			1,
		);
		state.snapshot(peer, "boot", 1, [
			{
				id: "x1",
				name: "operator",
				harness: "pi",
				status: "idle",
				machine: "studio",
				activity: "hi\u001b]52;c;ZXZpbA==\u0007 there‮",
				tags: ["machine:studio", "role:x"],
			},
		]);
		const a = state.get("mb/x1")!;
		expect(a.name).toBe("operator-agent");
		expect(a.machine).toBe("b");
		expect(a.tags).toEqual(["role:x", "machine:b"]);
		expect(a.activity).toBe("hi]52;c;ZXZpbA== there");
		const h = parseHello(
			{
				fedProtocol: [1, 1],
				machineId: "m",
				name: "x\u001b[2J",
				pulsarVersion: "\u001b[2J9.9.9",
			},
			"fallback",
		)!;
		expect(h.name).toBe("x[2J");
		expect(h.pulsarVersion).toBe("[2J9.9.9");
	});

	test("F6: setup probes only pool nodes, by MagicDNS name, without redirects", async () => {
		const seen: { url: string; redirect?: string }[] = [];
		const fakeFetch = (async (url: string, init?: RequestInit) => {
			seen.push({
				url,
				...(init?.redirect ? { redirect: init.redirect } : {}),
			});
			return Response.json({
				fedProtocol: [1, 1],
				machineId: "m",
				name: "ci",
				pulsarVersion: "2.0.0",
			});
		}) as unknown as typeof fetch;
		expect(
			await probePeerPulsar(
				"evil.example.com",
				7337,
				fakeFetch,
				1500,
				"tail-fake.ts.net",
			),
		).toBeNull();
		expect(seen).toHaveLength(0);
		await probePeerPulsar(
			"ci.tail-fake.ts.net",
			7337,
			fakeFetch,
			1500,
			"tail-fake.ts.net",
		);
		expect(seen[0]!.redirect).toBe("error");
		seen.length = 0;
		const peer = (name: string, sameUser: boolean, tagged: boolean) => ({
			name,
			dnsName: `${name}.tail-fake.ts.net`,
			os: "linux",
			online: true,
			sameUser,
			tagged,
		});
		const reports = await probePeers(
			[
				peer("mine", true, false),
				peer("ci", false, true),
				peer("other-ci", false, true),
			],
			7337,
			fakeFetch,
			["ci"],
			"tail-fake.ts.net",
		);
		expect(reports.map((r) => [r.peer.name, r.pulsar !== null])).toEqual([
			["mine", true],
			["ci", true],
			["other-ci", false],
		]);
		expect(seen.some((s) => s.url.includes("other-ci"))).toBe(false);
	});
});

describe("tailnet RP id: the MagicDNS suffix unless it is a public suffix", () => {
	test("tailscale.com names keep their RP id", () => {
		expect(tailnetRpId("node.tail1234.ts.net")).toBe("tail1234.ts.net");
		expect(tailnetRpId("Node.Tail1234.TS.NET.")).toBe("tail1234.ts.net");
		expect(tailnetRpId("node.foo.c.ts.net")).toBe("node.foo.c.ts.net");
		expect(tailnetRpId("foo.c.ts.net")).toBe("foo.c.ts.net");
		expect(tailnetRpId("ts.net")).toBe("ts.net");
	});
	test("Headscale base domains", () => {
		const cases: [string, string][] = [
			// The base domain, never the broader registrable domain.
			["studio.mesh.corp.example", "mesh.corp.example"],
			["studio.tail.corp.example.com", "tail.corp.example.com"],
			["studio.example.com", "example.com"],
			["studio.vpn.example.co.uk", "vpn.example.co.uk"],
			["studio.corp.local", "corp.local"],
			["studio.lan.internal.example", "lan.internal.example"],
			// Public suffixes and one-label bases: browsers refuse them, so per node.
			["studio.example", "studio.example"],
			["studio.internal", "studio.internal"],
			["studio.local", "studio.local"],
			["studio.lan", "studio.lan"],
			["studio.home.arpa", "studio.home.arpa"],
			["studio.co.uk", "studio.co.uk"],
			["studio.github.io", "studio.github.io"],
			["studio", "studio"],
		];
		for (const [name, rp] of cases)
			expect([name, tailnetRpId(name)]).toEqual([name, rp]);
	});
	test("an override must cover the name and not be a public suffix", () => {
		expect(tailnetRpId("studio.mesh.corp.example", "corp.example")).toBe(
			"corp.example",
		);
		expect(
			tailnetRpId("studio.mesh.corp.example", "Studio.Mesh.Corp.Example."),
		).toBe("studio.mesh.corp.example");
		expect(() => tailnetRpId("studio.mesh.corp.example", "example")).toThrow(
			"public suffix",
		);
		expect(() =>
			tailnetRpId("studio.mesh.corp.example", "other.example.com"),
		).toThrow("not studio.mesh.corp.example");
		expect(() =>
			tailnetRpId("studio.mesh.corp.example", "ample.corp.example"),
		).toThrow();
		expect(() => tailnetRpId("node.tail1234.ts.net", "ts.net")).toThrow(
			"public suffix",
		);
	});
});

describe("remote transcripts", () => {
	test("image and document URLs point at this node with the pool address", async () => {
		const { RemoteTranscriptReader } = await import(
			"../src/federation/transcripts.ts"
		);
		const home = (id: string) =>
			`/api/v1/agents/a1/transcript/images/${encodeURIComponent(id)}`;
		const fed = {
			act: async () => ({
				page: {
					events: [
						{
							id: "e1",
							ts: 1,
							role: "user",
							kind: "text",
							text: "a PDF, no images",
							documents: [
								{
									id: "e1#doc0",
									mediaType: "application/pdf",
									url: home("e1#doc0"),
									name: "spec.pdf",
								},
							],
						},
						{
							id: "e2",
							ts: 2,
							role: "user",
							kind: "text",
							text: "both",
							images: [
								{ id: "e2#img0", mediaType: "image/png", url: home("e2#img0") },
							],
							documents: [
								{
									id: "e2#doc0",
									mediaType: "application/pdf",
									url: home("e2#doc0"),
								},
							],
						},
						{ id: "e3", ts: 3, role: "user", kind: "text", text: "plain" },
					],
					cursor: null,
				},
			}),
		};
		const reader = new RemoteTranscriptReader(fed as never);
		const page = await reader.page("m1/a1", null);
		const here = (id: string) =>
			`/api/v1/agents/m1%2Fa1/transcript/images/${encodeURIComponent(id)}`;
		expect(page.events[0]!.documents).toEqual([
			{
				id: "e1#doc0",
				mediaType: "application/pdf",
				url: "/api/v1/agents/m1%2Fa1/transcript/images/e1%23doc0",
				name: "spec.pdf",
			},
		]);
		expect(page.events[0]!.images).toBeUndefined();
		expect(page.events[1]!.images![0]!.url).toBe(here("e2#img0"));
		expect(page.events[1]!.documents![0]!.url).toBe(here("e2#doc0"));
		expect(page.events[2]).toEqual({
			id: "e3",
			ts: 3,
			role: "user",
			kind: "text",
			text: "plain",
		});
		reader.close();
	});

	test("a reconnect after a drop starts with a gap marker (nothing replays the outage)", async () => {
		const { RemoteTranscriptReader } = await import(
			"../src/federation/transcripts.ts"
		);
		const enc = new TextEncoder();
		const frame = (id: string) =>
			enc.encode(
				`event: transcript\ndata: ${JSON.stringify({
					events: [{ id, ts: 1, role: "user", kind: "text", text: id }],
				})}\n\n`,
			);
		let calls = 0;
		const fed = {
			state: {
				peers: new Map([["m1", { link: "tailnet", node: {}, version: 1 }]]),
			},
			ownerLogin: "me",
			nodeName: "here",
			request: async () => {
				const n = ++calls;
				const body = new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(frame(`e${n}`));
						// The first stream drops; the second stays open.
						if (n === 1) c.close();
					},
				});
				return new Response(body, { status: 200 });
			},
		};
		const reader = new RemoteTranscriptReader(fed as never);
		const seen: string[] = [];
		const off = reader.subscribe("m1/a1", (events) =>
			seen.push(
				...events.map((e) => (e.id.startsWith("gap:") ? "gap" : e.text)),
			),
		);
		const end = Date.now() + 5000;
		while (seen.length < 3 && Date.now() < end)
			await new Promise((r) => setTimeout(r, 50));
		off();
		reader.close();
		expect(seen).toEqual(["e1", "gap", "e2"]);
	}, 10_000);
});

describe("remote turns: only a newer, fresh turn of a known agent is announced", () => {
	function pool() {
		const state = new PoolState();
		const peer = state.upsert(
			{
				nodeId: "n",
				name: "b",
				dnsName: "b.x.ts.net",
				userId: "u",
				login: "me",
				tags: [],
				online: true,
			},
			{
				fedProtocol: [1, 1],
				features: [],
				pulsarVersion: "x",
				machineId: "mb",
				name: "b",
			},
			1,
		);
		const turns: Array<{ address: string; kind: string; at: number }> = [];
		state.onTurn = (address, t) => turns.push({ address, ...t });
		let seq = 1;
		const rec = (turn?: unknown) => ({
			id: "x",
			name: "x",
			harness: "pi",
			status: "idle",
			...(turn !== undefined ? { turn } : {}),
		});
		const send = (turn?: unknown) => {
			expect(state.delta(peer, "boot", ++seq, [rec(turn)], [])).toBe(true);
		};
		const flush = () => new Promise((r) => queueMicrotask(() => r(null)));
		return { state, peer, turns, rec, send, flush };
	}

	test("a first sighting carrying a turn announces nothing", async () => {
		const p = pool();
		p.state.snapshot(p.peer, "boot", 1, [
			p.rec({ kind: "finished", at: Date.now() }),
		]);
		await p.flush();
		expect(p.turns).toEqual([]);
	});

	test("a newer turn of a known agent is announced once; an older or equal one is not", async () => {
		const p = pool();
		p.state.snapshot(p.peer, "boot", 1, [p.rec()]);
		const at = Date.now();
		p.send({ kind: "failed", at });
		await p.flush();
		expect(p.turns).toEqual([{ address: "mb/x", kind: "failed", at }]);
		p.send({ kind: "failed", at }); // the same turn again
		p.send({ kind: "finished", at: at - 1000 }); // older than the one held
		await p.flush();
		expect(p.turns).toHaveLength(1);
	});

	test("a turn older than ten minutes when it arrives is not announced", async () => {
		const p = pool();
		p.state.snapshot(p.peer, "boot", 1, [p.rec()]);
		p.send({ kind: "finished", at: Date.now() - 11 * 60_000 });
		await p.flush();
		expect(p.turns).toEqual([]);
	});

	test("a malformed turn is dropped from the record", () => {
		const turn = (t: unknown) =>
			cleanFedAgent({ id: "a", name: "a", harness: "h", turn: t })?.turn;
		expect(turn({ kind: "finished", at: 5 })).toEqual({
			kind: "finished",
			at: 5,
		});
		for (const bad of [
			{ kind: "exploded", at: 5 },
			{ kind: "failed", at: "soon" },
			{ kind: "failed", at: 0 },
			{ kind: "failed", at: -3 },
			{ kind: "failed" },
			"failed",
			null,
		])
			expect(turn(bad)).toBeUndefined();
	});
});
