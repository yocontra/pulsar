/**
 * A self-hosted control server (Headscale): control-plane detection, names
 * and RP ids under any base domain, whois and status as Headscale shapes
 * them (samples from the live rig, scripts/live/headscale.sh), the
 * operator's own certificate, and the owner bound by user id.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOwner, PoolMembers } from "../src/federation/members.ts";
import { parseStatus } from "../src/federation/tailnet.ts";
import {
	classifyControlUrl,
	controlFromSuffix,
	controlLabel,
	readControlPlane,
} from "../src/http/control.ts";
import type { Identity, RunResult } from "../src/http/identity.ts";
import { parseStatusSelf, parseWhois } from "../src/http/identity.ts";
import {
	inspectCert,
	pemCertificates,
	watchTlsFiles,
} from "../src/http/tls.ts";
import { operatorName } from "../src/human-tag.ts";
import { PulsarService } from "../src/service/index.ts";
import {
	parseTailscaleState,
	probePeerPulsar,
	readTailscale,
	rpIdCheck,
	tailscaleFix,
} from "../src/setup/mesh.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";

const FIX = join(import.meta.dir, "fixtures", "headscale");
const sample = (f: string) =>
	JSON.parse(readFileSync(join(FIX, f), "utf8")) as unknown;
const DNS = "studio.mesh.corp.example";
/** Inside every fixture certificate's validity (issued 2026-11-19). */
const NOW = Date.parse("2027-01-15T00:00:00Z");

const run =
	(answers: Record<string, Partial<RunResult>>) => async (args: string[]) => {
		const a = answers[args.join(" ")];
		return { ok: false, stdout: "", stderr: "no", ...a } as RunResult;
	};

describe("control plane detection", () => {
	test("from the ControlURL", () => {
		expect(classifyControlUrl("")).toEqual({ kind: "tailscale", url: null });
		expect(classifyControlUrl("https://controlplane.tailscale.com").kind).toBe(
			"tailscale",
		);
		expect(classifyControlUrl("https://login.tailscale.com").kind).toBe(
			"tailscale",
		);
		expect(classifyControlUrl("https://headscale.corp.example").kind).toBe(
			"custom",
		);
		expect(classifyControlUrl("https://tailscale.com.evil.example").kind).toBe(
			"custom",
		);
		expect(classifyControlUrl("not a url").kind).toBe("custom");
	});

	test("from the MagicDNS suffix when prefs are unreadable", () => {
		expect(controlFromSuffix("tail1234.ts.net").kind).toBe("tailscale");
		expect(controlFromSuffix("mesh.corp.example").kind).toBe("custom");
		expect(controlFromSuffix("ts.net.corp.example").kind).toBe("custom");
		expect(controlFromSuffix(null).kind).toBe("tailscale");
	});

	test("reads `tailscale debug prefs`, else falls back", async () => {
		const prefs = JSON.stringify(sample("prefs-a.json"));
		const c = await readControlPlane(
			run({ "debug prefs": { ok: true, stdout: prefs } }),
			"mesh.corp.example",
		);
		expect(c).toEqual({ kind: "custom", url: "https://pulsar-hs-control" });
		expect(controlLabel(c)).toBe("self-hosted (pulsar-hs-control)");
		const guessed = await readControlPlane(run({}), "mesh.corp.example");
		expect(guessed).toEqual({ kind: "custom", url: null });
		expect(controlLabel(guessed)).toBe("a self-hosted control server");
	});

	test("setup's view of a Headscale node", async () => {
		const status = JSON.stringify(sample("status-a.json"));
		const prefs = JSON.stringify(sample("prefs-a.json"));
		const ts = await readTailscale(
			run({
				"status --json": { ok: true, stdout: status },
				"debug prefs": { ok: true, stdout: prefs },
			}),
		);
		if (ts.kind !== "running") throw new Error(ts.kind);
		expect(ts.control.kind).toBe("custom");
		expect(ts.suffix).toBe("mesh.corp.example");
		expect(ts.magicDns).toBe(true);
		expect(ts.self.dnsName).toBe("pulsar-hs-a.mesh.corp.example");
		expect(ts.self.ownerLogin).toBe("ada");
		// Headscale never offers `tailscale cert` names.
		expect(ts.self.certDomains).toEqual([]);
		expect(ts.peers.map((p) => [p.name, p.sameUser, p.tagged])).toEqual([
			["pulsar-hs-b", true, false],
			["pulsar-hs-tagged", false, true],
		]);
	});

	test("fixes name the control server, never the tailscale.com console", () => {
		const custom = { kind: "custom" as const, url: "https://hs.corp.example" };
		const approval = tailscaleFix(
			{ kind: "needs-approval", control: custom },
			"linux",
		)!;
		expect(approval).toContain("hs.corp.example");
		expect(approval).not.toContain("login.tailscale.com");
		expect(
			tailscaleFix({ kind: "logged-out", control: custom }, "linux"),
		).toContain("--login-server https://hs.corp.example");
		expect(tailscaleFix({ kind: "needs-approval" }, "linux")).toContain(
			"login.tailscale.com",
		);
	});
});

describe("Headscale status and whois", () => {
	test("status: peers, user ids, tags, names", () => {
		const st = parseStatus(sample("status-a.json"))!;
		expect(st.self).toMatchObject({
			nodeId: "1",
			name: "pulsar-hs-a",
			dnsName: "pulsar-hs-a.mesh.corp.example",
			userId: "1",
			login: "ada",
			ownerLogin: "ada",
			tags: [],
		});
		const byName = Object.fromEntries(st.peers.map((p) => [p.name, p]));
		expect(byName["pulsar-hs-b"]).toMatchObject({
			nodeId: "2",
			userId: "1",
			login: "ada",
			online: true,
		});
		expect(byName["pulsar-hs-tagged"]).toMatchObject({
			login: "tagged-devices",
			tags: ["tag:server"],
		});
		expect(parseStatusSelf(sample("status-a.json"))!.ips).toEqual([
			"100.64.0.1",
			"fd7a:115c:a1e0::1",
		]);
	});

	test("whois: a bare user name, its id; a tagged node is tagged-devices", () => {
		expect(parseWhois(sample("whois-b.json"))).toEqual({
			login: "ada",
			userId: "1",
			node: "pulsar-hs-b",
			nodeId: "2",
			displayName: "ada",
			os: "linux",
		});
		const tagged = parseWhois(sample("whois-tagged.json"))!;
		expect(tagged.login).toBe("tagged-devices");
		expect(tagged.displayName).toBeUndefined();
		// Tags win even if a control server named a user for the node.
		const odd = structuredClone(sample("whois-tagged.json")) as {
			UserProfile: { LoginName: string; DisplayName: string };
		};
		odd.UserProfile.LoginName = "ada";
		odd.UserProfile.DisplayName = "Ada";
		expect(parseWhois(odd)!.login).toBe("tagged-devices");
	});

	test("OIDC users log in by email; the operator tag falls back to the login", () => {
		const w = structuredClone(sample("whois-b.json")) as {
			UserProfile: { LoginName: string; DisplayName?: string };
		};
		w.UserProfile.LoginName = "ada@corp.example";
		delete w.UserProfile.DisplayName;
		const who = parseWhois(w)!;
		expect(who.login).toBe("ada@corp.example");
		expect(operatorName(who.displayName, who.login)).toBe("ada@corp.example");
		expect(operatorName(undefined, "ada")).toBe("ada");
		expect(operatorName("", "")).toBe("operator");
	});

	test("ownership needs the user id too, when known", () => {
		expect(isOwner({ login: "ada", userId: "1" }, "ada", "1")).toBe(true);
		expect(isOwner({ login: "ADA", userId: "1" }, "ada", "1")).toBe(true);
		// Another user with the same name (a local user and an OIDC one).
		expect(isOwner({ login: "ada", userId: "7" }, "ada", "1")).toBe(false);
		expect(isOwner({ login: "ada" }, "ada", "1")).toBe(false);
		expect(isOwner({ login: "ada", userId: "7" }, "ada", null)).toBe(true);
		expect(isOwner({ login: "bob", userId: "1" }, "ada", "1")).toBe(false);

		const members = new PoolMembers(null);
		const node = { nodeId: "9", login: "ada", tags: [] as string[] };
		expect(members.admits({ ...node, userId: "1" }, "ada", "1")).toBe(true);
		expect(members.admits({ ...node, userId: "7" }, "ada", "1")).toBe(false);
		const who: Identity = { login: "ada", userId: "7", node: "x", nodeId: "9" };
		expect(members.admitsCaller(who, "ada", "1")).toBe(false);
		expect(members.admitsCaller({ ...who, userId: "1" }, "ada", "1")).toBe(
			true,
		);
	});

	test("peer probes go to this tailnet's MagicDNS names only", async () => {
		const urls: string[] = [];
		const fakeFetch = (async (url: string) => {
			urls.push(url);
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		await probePeerPulsar(
			"pulsar-hs-b.mesh.corp.example",
			7337,
			fakeFetch,
			100,
			"mesh.corp.example",
		);
		await probePeerPulsar(
			"evil.example.com",
			7337,
			fakeFetch,
			100,
			"mesh.corp.example",
		);
		expect(urls).toEqual([
			"https://pulsar-hs-b.mesh.corp.example:7337/fed/v1/hello",
		]);
	});
});

describe("the operator's own certificate", () => {
	let dir: string;
	const files = (name: string, ca = true) => ({
		cert: join(FIX, `${name}.crt`),
		key: join(dir, `${name}.key`),
		...(ca ? { ca: join(FIX, "root.crt") } : {}),
	});

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-byo-"));
		for (const k of ["node", "long", "client"]) {
			copyFileSync(join(FIX, `${k}.key`), join(dir, `${k}.key`));
			chmodSync(join(dir, `${k}.key`), 0o600);
		}
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("a good chain from a private root", () => {
		const r = inspectCert(files("node"), DNS, { now: NOW, env: {} });
		expect(r.problems).toEqual([]);
		expect(r.notes).toEqual([]);
		expect(r.ok).toBe(true);
		expect(r.untrusted).toBeUndefined();
		expect(r.issuer).toBe("Test Intermediate");
		expect(r.publicCa).toBe(false);
		expect(
			pemCertificates(readFileSync(files("node").cert, "utf8")),
		).toHaveLength(2);
	});

	test("hostname, expiry, not-yet-valid", () => {
		expect(
			inspectCert(files("node"), "other.mesh.corp.example", {
				now: NOW,
				env: {},
			}).problems[0],
		).toContain("not for other.mesh.corp.example");
		expect(
			inspectCert(files("node"), `x.${DNS}`, { now: NOW, env: {} }).ok,
		).toBe(false);
		const late = inspectCert(files("node"), DNS, {
			now: NOW + 400 * 86_400_000,
			env: {},
		});
		expect(late.problems.join()).toContain("expired");
		const soon = inspectCert(files("node"), DNS, {
			now: Date.parse("2027-12-15T00:00:00Z"),
			env: {},
		});
		expect(soon.ok).toBe(true);
		expect(soon.notes.join()).toContain("expires in");
		const early = inspectCert(files("node"), DNS, {
			now: Date.parse("2026-01-01T00:00:00Z"),
			env: {},
		});
		expect(early.problems.join()).toContain("not valid until");
	});

	test("trust: no root given, a wrong root, NODE_EXTRA_CA_CERTS", () => {
		const bare = inspectCert(files("node", false), DNS, { now: NOW, env: {} });
		expect(bare.ok).toBe(true);
		expect(bare.untrusted).toContain("--ca");
		const viaEnv = inspectCert(files("node", false), DNS, {
			now: NOW,
			env: { NODE_EXTRA_CA_CERTS: join(FIX, "root.crt") },
		});
		expect(viaEnv.untrusted).toBeUndefined();
		const wrong = inspectCert(
			{ ...files("node"), ca: join(FIX, "int.crt") },
			DNS,
			{ now: NOW, env: {} },
		);
		// The intermediate is in the chain itself, so it vouches only for itself.
		expect(wrong.ok).toBe(true);
		const missing = inspectCert(
			{ ...files("node"), ca: join(dir, "none.pem") },
			DNS,
			{ now: NOW, env: {} },
		);
		expect(missing.problems.join()).toContain("cannot read CA");
	});

	test("key mismatch, key mode, order, usage, Apple's 825 days", () => {
		const mismatch = inspectCert(
			{ ...files("node"), key: join(dir, "long.key") },
			DNS,
			{ now: NOW, env: {} },
		);
		expect(mismatch.problems.join()).toContain("is not the key");
		const loose = join(dir, "loose.key");
		copyFileSync(join(FIX, "node.key"), loose);
		chmodSync(loose, 0o644);
		expect(
			inspectCert({ ...files("node"), key: loose }, DNS, {
				now: NOW,
				env: {},
			}).problems.join(),
		).toContain("chmod 600");
		// Group-readable (a renewer's group): allowed, with a note.
		chmodSync(loose, 0o640);
		const group = inspectCert({ ...files("node"), key: loose }, DNS, {
			now: NOW,
			env: {},
		});
		expect(group.ok).toBe(true);
		expect(group.notes.join()).toContain("readable by its group");
		const misordered = inspectCert(
			{ ...files("node"), cert: join(FIX, "misordered.crt") },
			DNS,
			{ now: NOW, env: {} },
		);
		expect(misordered.problems.join()).toContain("server certificate first");
		expect(
			inspectCert(files("client"), DNS, { now: NOW, env: {} }).problems.join(),
		).toContain("serverAuth");
		const long = inspectCert(files("long"), DNS, { now: NOW, env: {} });
		expect(long.ok).toBe(true);
		expect(long.notes.join()).toContain("825 days");
	});

	test("unreadable files", () => {
		const r = inspectCert(
			{ cert: join(dir, "nope.crt"), key: join(dir, "nope.key") },
			DNS,
			{ now: NOW, env: {} },
		);
		expect(r.ok).toBe(false);
		expect(r.problems[0]).toContain("cannot read certificate");
	});

	test("a renewed file is noticed (rename or rewrite)", async () => {
		const cert = join(dir, "watched.crt");
		const key = join(dir, "watched.key");
		writeFileSync(cert, "a");
		writeFileSync(key, "k");
		let changes = 0;
		const stop = watchTlsFiles({ cert, key }, () => changes++, 20);
		try {
			await new Promise((r) => setTimeout(r, 80));
			expect(changes).toBe(0);
			writeFileSync(`${cert}.new`, "renewed");
			const { renameSync } = await import("node:fs");
			renameSync(`${cert}.new`, cert);
			utimesSync(cert, new Date(), new Date(Date.now() + 5000));
			await new Promise((r) => setTimeout(r, 120));
			expect(changes).toBe(1);
		} finally {
			stop();
		}
	});
});

describe("setup and doctor wording on Headscale", () => {
	test("a per-machine RP id is noted; an override is checked", () => {
		expect(rpIdCheck("studio.mesh.corp.example")).toBeNull();
		expect(rpIdCheck("studio.mesh.corp.example", "corp.example")).toBeNull();
		expect(rpIdCheck("studio.internal")).toEqual({
			note: expect.stringContaining("public suffix or one label"),
		});
		// An invalid setting stops the app: doctor reports it as a problem.
		expect(rpIdCheck("studio.mesh.corp.example", "example")).toEqual({
			bad: expect.stringContaining("public suffix"),
		});
		expect(rpIdCheck("studio.mesh.corp.example", "other.example")).toEqual({
			bad: expect.stringContaining("rpId"),
		});
	});

	test("MagicDNS off on Headscale: the config key, not the console", async () => {
		const status = sample("status-a.json") as {
			CurrentTailnet: { MagicDNSEnabled: boolean };
		};
		status.CurrentTailnet.MagicDNSEnabled = false;
		const st = parseTailscaleState(status);
		expect(st.kind === "running" && st.magicDns).toBe(false);
		const { magicDnsFix } = await import("../src/setup/mesh.ts");
		expect(magicDnsFix({ kind: "custom", url: null })).toContain(
			"dns.magic_dns",
		);
	});
});

describe("Host, Origin and RP id with a custom base domain", () => {
	let dir: string;
	let store: Store;
	let service: PulsarService;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-hs-http-"));
		store = new Store(join(dir, "pulsar.db"));
		service = new PulsarService({ store, scan: false, machine: "pulsar-hs-a" });
	});
	afterAll(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function transport(rpId?: string) {
		const t = new HttpTransport(service, {
			identity: { identify: async () => null },
			owner: "ada",
			ownerId: "1",
			hosts: ["100.64.0.1"],
			port: 7337,
			tls: { cert: join(FIX, "node.crt"), key: join(FIX, "node.key") },
			publicName: "pulsar-hs-a.mesh.corp.example",
			webRoot: null,
			...(rpId ? { rpId } : {}),
		});
		// What listen() sets once bound (binding a Tailscale address needs a tailnet).
		const raw = t as unknown as { boundPort: number; computeOrigins(): void };
		raw.boundPort = 7337;
		raw.computeOrigins();
		return t;
	}

	test("the Headscale MagicDNS name is the app's host and origin", async () => {
		const t = transport();
		expect(t.url).toBe("https://pulsar-hs-a.mesh.corp.example:7337/");
		expect(t.origins).toEqual(["https://pulsar-hs-a.mesh.corp.example:7337"]);
		const get = (headers: Record<string, string>) =>
			t.app.request("/api/v1/hello", {
				headers: { "X-Pulsar": "1", ...headers },
			});
		const good = await get({ Host: "pulsar-hs-a.mesh.corp.example:7337" });
		// Past the Host check; no connection identity in this harness.
		expect(good.status).toBe(403);
		const ts = await get({ Host: "pulsar-hs-a.tail1234.ts.net:7337" });
		expect(ts.status).toBe(421);
		const parent = await get({ Host: "mesh.corp.example:7337" });
		expect(parent.status).toBe(421);
		const evil = await get({
			Host: "pulsar-hs-a.mesh.corp.example:7337",
			Origin: "https://evil.corp.example",
		});
		expect(evil.status).toBe(403);
		expect(
			((await evil.json()) as { error: { code: string } }).error.code,
		).not.toBe("not_owner");
	});

	test("RP id: the base domain, or the override", () => {
		expect(transport().relyingParty().rpId).toBe("mesh.corp.example");
		expect(transport("corp.example").relyingParty().rpId).toBe("corp.example");
	});
});

describe("the app refuses a same-login user with another id", () => {
	test("login ada, user 7, when the owner is ada with id 1", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pulsar-hs-owner-"));
		const store = new Store(join(dir, "pulsar.db"));
		const service = new PulsarService({ store, scan: false, machine: "a" });
		let userId = "7";
		const t = new HttpTransport(service, {
			identity: {
				identify: async () => ({
					login: "ada",
					userId,
					node: "x",
					nodeId: "n",
				}),
			},
			owner: "ada",
			ownerId: "1",
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
		});
		await t.listen();
		try {
			const get = () =>
				fetch(`http://127.0.0.1:${t.port}/api/v1/agents?limit=1`, {
					headers: { "X-Pulsar": "1", Connection: "close" },
				});
			const other = await get();
			expect(other.status).toBe(403);
			expect(
				((await other.json()) as { error: { code: string } }).error.code,
			).toBe("not_owner");
			userId = "1";
			// A new connection: identity is kept per connection.
			const mine = await fetch(
				`http://127.0.0.1:${t.port}/api/v1/agents?limit=1`,
				{ headers: { "X-Pulsar": "1", Connection: "close" } },
			);
			expect(mine.status).toBe(200);
		} finally {
			await t.close();
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
