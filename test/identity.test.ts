import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appUrl, remoteConfig } from "../src/http/config.ts";
import type { TailscaleRunner } from "../src/http/identity.ts";
import {
	certsDisabled,
	ENABLE_HTTPS_HINT,
	fetchCert,
	IdentityUnavailable,
	isTailscaleAddr,
	localApiRunner,
	normalizeAddr,
	parseStatusSelf,
	parseWhois,
	type RunResult,
	StaticIdentity,
	TailscaleIdentity,
	tailscaleCertPaths,
	tailscaleSelf,
	whoisTarget,
} from "../src/http/identity.ts";
import { discoverLocalApi, localApiGet } from "../src/http/localapi.ts";
import { checkBindAddress } from "../src/transport/http.ts";

/**
 * Hand-written from Tailscale's documented `status --json` / `whois --json`
 * shapes and the R0 notes (DNSName has a trailing dot, Peer and CertDomains
 * can be null). Not recorded from a live tailscaled.
 */
function fixture(name: string): unknown {
	return JSON.parse(
		readFileSync(join(import.meta.dir, "fixtures", "tailscale", name), "utf8"),
	);
}

function runner(results: Record<string, RunResult>) {
	const calls: string[][] = [];
	return {
		calls,
		run: async (args: string[]) => {
			calls.push(args);
			return results[args[0]!] ?? { ok: false, stdout: "", stderr: "nope" };
		},
	};
}

describe("tailscale parsing", () => {
	test("whois gives the login, short node name and stable id", () => {
		expect(parseWhois(fixture("whois.json"))).toEqual({
			login: "me@example.com",
			node: "iphone",
			nodeId: "nXyZ12CNTRL",
			userId: "1234567890",
			displayName: "Me",
			os: "iOS",
		});
	});

	test("a tagged node parses as tagged-devices (refused as not the owner)", () => {
		expect(parseWhois(fixture("whois-tagged.json"))).toEqual({
			login: "tagged-devices",
			node: "build-01",
			nodeId: "nTaG55CNTRL",
			userId: "0",
		});
	});

	test("whois without a login or node is null", () => {
		expect(parseWhois({ Node: { StableID: "x", Name: "a.b." } })).toBeNull();
		expect(parseWhois({ UserProfile: { LoginName: "me@x" } })).toBeNull();
		expect(parseWhois(null)).toBeNull();
		expect(parseWhois("text")).toBeNull();
	});

	test("status gives this node's name, addresses, owner and cert domains", () => {
		expect(parseStatusSelf(fixture("status.json"))).toEqual({
			dnsName: "studio.tail1234.ts.net",
			name: "studio",
			ips: ["100.101.102.103", "fd7a:115c:a1e0::1234:5678"],
			ownerLogin: "me@example.com",
			ownerId: "1234567890",
			certDomains: ["studio.tail1234.ts.net"],
		});
	});

	test("null CertDomains and Peer are fine; non-Tailscale IPs are dropped", () => {
		const self = parseStatusSelf(fixture("status-no-certs.json"));
		expect(self?.certDomains).toEqual([]);
		expect(self?.ips).toEqual(["100.101.102.103"]);
	});

	test("a stopped backend is null", () => {
		const stopped = {
			...(fixture("status.json") as object),
			BackendState: "Stopped",
		};
		expect(parseStatusSelf(stopped)).toBeNull();
	});

	test("addresses: mapped IPv4, brackets, zones, Tailscale ranges", () => {
		expect(normalizeAddr("::ffff:100.64.0.1")).toBe("100.64.0.1");
		expect(normalizeAddr("[fd7a:115c:a1e0::1]")).toBe("fd7a:115c:a1e0::1");
		expect(normalizeAddr("fe80::1%en0")).toBe("fe80::1");
		expect(whoisTarget("fd7a:115c:a1e0::1", 443)).toBe(
			"[fd7a:115c:a1e0::1]:443",
		);
		expect(whoisTarget("::ffff:100.64.0.1", 5)).toBe("100.64.0.1:5");
		expect(isTailscaleAddr("100.64.0.1")).toBe(true);
		expect(isTailscaleAddr("100.127.255.255")).toBe(true);
		expect(isTailscaleAddr("100.128.0.1")).toBe(false);
		expect(isTailscaleAddr("10.0.0.1")).toBe(false);
		expect(isTailscaleAddr("fd7a:115c:a1e0:ab12::1")).toBe(true);
		expect(isTailscaleAddr("fd00::1")).toBe(false);
	});
});

describe("TailscaleIdentity", () => {
	const ok = {
		ok: true,
		stdout: JSON.stringify(fixture("whois.json")),
		stderr: "",
	};

	test("asks whois per address and caches it across ports", async () => {
		const r = runner({ whois: ok });
		const id = new TailscaleIdentity({ run: r.run });
		expect(await id.identify("100.90.80.70", 50000)).toMatchObject({
			login: "me@example.com",
		});
		await id.identify("::ffff:100.90.80.70", 50000);
		// A new connection (new port) from the same node: no new process.
		await id.identify("100.90.80.70", 50001);
		expect(r.calls).toEqual([["whois", "--json", "100.90.80.70"]]);
		await new TailscaleIdentity({ run: r.run }).identify(
			"fd7a:115c:a1e0::aaaa:bbbb",
			7,
		);
		expect(r.calls[1]).toEqual([
			"whois",
			"--json",
			"fd7a:115c:a1e0::aaaa:bbbb",
		]);
	});

	test("a recently known address answers at once while it is re-checked; a no-match forgets it", async () => {
		let answer: typeof ok | { ok: false; stdout: string; stderr: string } = ok;
		let release: (() => void) | null = null;
		let calls = 0;
		const run: TailscaleRunner = async () => {
			calls++;
			if (calls === 2) await new Promise<void>((r) => (release = r));
			return answer;
		};
		const id = new TailscaleIdentity({ run, ttlMs: 1 });
		expect(await id.identify("100.90.80.70", 1)).toMatchObject({
			login: "me@example.com",
		});
		await new Promise((r) => setTimeout(r, 5));
		// Expired, but known: served at once while a whois runs in the background.
		expect(await id.identify("100.90.80.70", 2)).toMatchObject({
			login: "me@example.com",
		});
		await new Promise((r) => setTimeout(r, 5));
		expect(calls).toBe(2);
		// The re-check finds no node at that address: the entry is dropped.
		answer = { ok: false, stdout: "", stderr: "no match for IP:port" };
		release!();
		await new Promise((r) => setTimeout(r, 5));
		answer = { ok: false, stdout: "", stderr: "no match for IP:port" };
		expect(await id.identify("100.90.80.70", 3)).toBeNull();
	});

	test("a connection flood starts one lookup per address, a bounded number at once", async () => {
		let running = 0;
		let peak = 0;
		const gates: Array<() => void> = [];
		const slow: TailscaleRunner = async () => {
			running++;
			peak = Math.max(peak, running);
			await new Promise<void>((r) => gates.push(r));
			running--;
			return ok;
		};
		const id = new TailscaleIdentity({
			run: slow,
			maxConcurrent: 2,
			maxQueued: 3,
		});
		const settle = <T>(p: Promise<T>) =>
			p.then(
				(v) => v,
				(e: Error) => e,
			);
		// 200 connections from one node share a single whois.
		const same = Array.from({ length: 200 }, (_, i) =>
			settle(id.identify("100.90.80.70", 1000 + i)),
		);
		// Distinct addresses: 2 run, 3 wait, the rest are refused at once
		// (unavailable: the client retries, it is not told it is someone else).
		const many = Array.from({ length: 10 }, (_, i) =>
			settle(id.identify(`100.90.80.${i + 1}`, 5)),
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(peak).toBe(2);
		while (gates.length || running) {
			gates.shift()?.();
			await new Promise((r) => setTimeout(r, 1));
		}
		const sameResults = await Promise.all(same);
		expect(
			sameResults.every(
				(v) => !(v instanceof Error) && v?.login === "me@example.com",
			),
		).toBe(true);
		const manyResults = await Promise.all(many);
		expect(
			manyResults.filter((v) => v instanceof IdentityUnavailable).length,
		).toBe(6);
		expect(id.lookups).toBe(5);
		expect(peak).toBe(2);
	});

	test("fails closed: a failing whois is retried, then unavailable, never cached; non-tailnet addresses never ask", async () => {
		const r = runner({});
		const id = new TailscaleIdentity({ run: r.run, waitMs: 100, retryMs: 20 });
		await expect(id.identify("100.90.80.70", 1)).rejects.toBeInstanceOf(
			IdentityUnavailable,
		);
		const first = r.calls.length;
		expect(first).toBeGreaterThan(1);
		await expect(id.identify("100.90.80.70", 1)).rejects.toBeInstanceOf(
			IdentityUnavailable,
		);
		expect(r.calls.length).toBeGreaterThan(first);
		const asked = r.calls.length;
		expect(await id.identify("127.0.0.1", 1)).toBeNull();
		expect(await id.identify("192.168.1.4", 1)).toBeNull();
		expect(r.calls.length).toBe(asked);
		// whois knows no one at that address: a definite answer, at once.
		const nobody = runner({
			whois: { ok: false, stdout: "", stderr: "no match for IP:port" },
		});
		expect(
			await new TailscaleIdentity({ run: nobody.run }).identify(
				"100.64.0.8",
				3,
			),
		).toBeNull();
		expect(nobody.calls.length).toBe(1);
		const garbage = runner({
			whois: { ok: true, stdout: "not json", stderr: "" },
		});
		expect(
			await new TailscaleIdentity({ run: garbage.run }).identify(
				"100.64.0.9",
				3,
			),
		).toBeNull();
	});

	test("the cache expires", async () => {
		const r = runner({ whois: ok });
		const id = new TailscaleIdentity({ run: r.run, ttlMs: 0 });
		await id.identify("100.90.80.70", 9);
		await id.identify("100.90.80.70", 9);
		expect(r.calls.length).toBe(2);
	});

	test("StaticIdentity is the same user for every loopback connection, nobody else", async () => {
		const id = new StaticIdentity("dev@example.com", "laptop");
		const dev = { login: "dev@example.com", node: "laptop", nodeId: "dev" };
		expect(await id.identify()).toEqual(dev);
		expect(await id.identify("127.0.0.1")).toEqual(dev);
		expect(await id.identify("::ffff:127.0.0.1")).toEqual(dev);
		expect(await id.identify("::1")).toEqual(dev);
		expect(await id.identify("192.168.1.20")).toBeNull();
		expect(await id.identify("100.64.0.9")).toBeNull();
	});

	test("tailscaleSelf parses status, null on failure", async () => {
		const good = runner({
			status: {
				ok: true,
				stdout: JSON.stringify(fixture("status.json")),
				stderr: "",
			},
		});
		expect((await tailscaleSelf(good.run))?.ownerLogin).toBe("me@example.com");
		expect(good.calls[0]).toEqual(["status", "--json"]);
		expect(await tailscaleSelf(runner({}).run)).toBeNull();
	});
});

describe("certificates", () => {
	test("paths live under the state dir's tls folder", () => {
		expect(tailscaleCertPaths("studio.tail1234.ts.net", "/s/tls")).toEqual({
			cert: "/s/tls/studio.tail1234.ts.net.crt",
			key: "/s/tls/studio.tail1234.ts.net.key",
		});
	});

	test("fetchCert runs tailscale cert with both files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pulsar-tls-"));
		try {
			const r = runner({ cert: { ok: true, stdout: "", stderr: "" } });
			const paths = await fetchCert("studio.tail1234.ts.net", {
				dir,
				run: r.run,
			});
			expect(r.calls[0]).toEqual([
				"cert",
				"--cert-file",
				paths.cert,
				"--key-file",
				paths.key,
				"studio.tail1234.ts.net",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("certificates turned off for the tailnet name the admin-console fix", async () => {
		const stderr =
			"500 Internal Server Error: your Tailscale account does not support getting TLS certs";
		expect(certsDisabled(stderr)).toBe(true);
		const dir = mkdtempSync(join(tmpdir(), "pulsar-tls-"));
		try {
			const r = runner({ cert: { ok: false, stdout: "", stderr } });
			await expect(
				fetchCert("studio.tail1234.ts.net", { dir, run: r.run }),
			).rejects.toThrow(ENABLE_HTTPS_HINT);
			const other = runner({ cert: { ok: false, stdout: "", stderr: "boom" } });
			await expect(
				fetchCert("studio.tail1234.ts.net", { dir, run: other.run }),
			).rejects.toThrow("tailscale cert studio.tail1234.ts.net failed: boom");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("remote config", () => {
	test("off by default; dev identity and PULSAR_REMOTE turn it on", () => {
		expect(remoteConfig({}, {})).toEqual({ mode: "off" });
		expect(remoteConfig({}, { remote: true })).toEqual({
			mode: "tailscale",
			port: 7337,
		});
		expect(remoteConfig({ PULSAR_REMOTE: "0" }, { remote: true })).toEqual({
			mode: "off",
		});
		expect(
			remoteConfig({ PULSAR_REMOTE: "1", PULSAR_HTTP_PORT: "8443" }, {}),
		).toEqual({
			mode: "tailscale",
			port: 8443,
		});
		expect(remoteConfig({ PULSAR_DEV_IDENTITY: "me@x" }, {})).toEqual({
			mode: "dev",
			login: "me@x",
			port: 7337,
		});
	});

	test("app URL: loopback in dev, the ts.net name otherwise", async () => {
		expect(await appUrl({ mode: "dev", login: "a", port: 9 })).toBe(
			"http://127.0.0.1:9/",
		);
		const self = async () => parseStatusSelf(fixture("status.json"));
		expect(await appUrl({ mode: "tailscale", port: 7337 }, self)).toBe(
			"https://studio.tail1234.ts.net:7337/",
		);
		expect(await appUrl({ mode: "tailscale", port: 443 }, self)).toBe(
			"https://studio.tail1234.ts.net/",
		);
		expect(
			await appUrl({ mode: "tailscale", port: 1 }, async () => null),
		).toBeNull();
		expect(await appUrl({ mode: "off" })).toBeNull();
	});
});

describe("bind addresses", () => {
	test("never every interface, never the LAN", () => {
		for (const host of ["0.0.0.0", "::", "", "192.168.1.5", "10.0.0.2"]) {
			expect(() => checkBindAddress(host, false)).toThrow();
			expect(() => checkBindAddress(host, true)).toThrow();
		}
	});

	test("plain HTTP is loopback only; TLS is Tailscale addresses only", () => {
		expect(() => checkBindAddress("127.0.0.1", false)).not.toThrow();
		expect(() => checkBindAddress("::1", false)).not.toThrow();
		expect(() => checkBindAddress("100.101.102.103", false)).toThrow();
		expect(() => checkBindAddress("100.101.102.103", true)).not.toThrow();
		expect(() => checkBindAddress("fd7a:115c:a1e0::1", true)).not.toThrow();
		expect(() => checkBindAddress("127.0.0.1", true)).toThrow();
	});
});

describe("TailscaleIdentity with a slow tailscale CLI", () => {
	// A fake `tailscale` first on PATH: it counts its runs, sleeps, then
	// answers whois from the fixture (or fails the first N runs).
	function fakeTailscale(opts: { sleep: number; failFirst?: number }) {
		const dir = mkdtempSync(join(tmpdir(), "pulsar-ts-"));
		const count = join(dir, "count");
		const whois = join(import.meta.dir, "fixtures", "tailscale", "whois.json");
		writeFileSync(
			join(dir, "tailscale"),
			`#!/bin/sh
n=$(($(cat "${count}" 2>/dev/null || echo 0) + 1)); echo $n > "${count}"
sleep ${opts.sleep}
if [ "$n" -le ${opts.failFirst ?? 0} ]; then echo "tailscaled busy" >&2; exit 1; fi
cat "${whois}"
`,
			{ mode: 0o755 },
		);
		const prev = process.env.PATH;
		process.env.PATH = `${dir}:${prev}`;
		return {
			runs: () => Number(readFileSync(count, "utf8").trim() || 0),
			done: () => {
				process.env.PATH = prev;
				rmSync(dir, { recursive: true, force: true });
			},
		};
	}

	test("a whois that takes a second still identifies (no 403)", async () => {
		const ts = fakeTailscale({ sleep: 1 });
		try {
			const id = new TailscaleIdentity();
			expect(await id.identify("100.90.80.70", 1)).toMatchObject({
				login: "me@example.com",
			});
		} finally {
			ts.done();
		}
	});

	test("a failing whois is retried with backoff inside the wait", async () => {
		const ts = fakeTailscale({ sleep: 0, failFirst: 2 });
		try {
			const id = new TailscaleIdentity({ retryMs: 50 });
			expect(await id.identify("100.90.80.70", 1)).toMatchObject({
				login: "me@example.com",
			});
			expect(ts.runs()).toBe(3);
		} finally {
			ts.done();
		}
	});

	test("a whois slower than the wait is unavailable (503), not anonymous", async () => {
		const ts = fakeTailscale({ sleep: 10 });
		try {
			const id = new TailscaleIdentity({ waitMs: 1500 });
			const start = Date.now();
			await expect(id.identify("100.90.80.70", 1)).rejects.toBeInstanceOf(
				IdentityUnavailable,
			);
			expect(Date.now() - start).toBeLessThan(4000);
		} finally {
			ts.done();
		}
	}, 10_000);
});

describe("TailscaleIdentity persisted cache", () => {
	const ok = {
		ok: true,
		stdout: JSON.stringify(fixture("whois.json")),
		stderr: "",
	};
	const me = { login: "me@example.com", node: "iphone", nodeId: "nXyZ12CNTRL" };
	function tmp() {
		const dir = mkdtempSync(join(tmpdir(), "pulsar-idcache-"));
		return { dir, file: join(dir, "state", "identity-cache.json") };
	}
	const write = (file: string, data: unknown) => {
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, JSON.stringify(data));
	};
	const settle = () => new Promise((ok) => setTimeout(ok, 20));

	test("a lookup is saved (mode 0600) and answers at once after a restart, then is re-checked", async () => {
		const { dir, file } = tmp();
		try {
			const first = new TailscaleIdentity({
				run: runner({ whois: ok }).run,
				file,
			});
			await first.identify("100.90.80.70", 1);
			await first.save();
			expect(statSync(file).mode & 0o777).toBe(0o600);
			// A restart: whois now hangs, yet the known address answers from the file.
			let release: (r: RunResult) => void = () => {};
			const calls: string[][] = [];
			const second = new TailscaleIdentity({
				file,
				run: (args) => {
					calls.push(args);
					return new Promise((r) => {
						release = r;
					});
				},
			});
			// Every field comes back, the user id (the owner check) included.
			expect(await second.identify("100.90.80.70", 2)).toEqual(
				(await first.identify("100.90.80.70", 1))!,
			);
			// …and the loaded entry is re-checked on first use, though it is fresh.
			expect(calls).toEqual([["whois", "--json", "100.90.80.70"]]);
			release(ok);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a loaded entry keeps the user id, so the owner's node is still the owner after a restart", async () => {
		const { dir, file } = tmp();
		try {
			const first = new TailscaleIdentity({
				run: runner({ whois: ok }).run,
				file,
			});
			const fresh = await first.identify("100.90.80.70", 1);
			expect(fresh?.userId).toBe("1234567890");
			await first.save();
			// After a restart whois hangs; the answer from the file must match the fresh one.
			const second = new TailscaleIdentity({
				file,
				run: () => new Promise(() => {}),
			});
			expect(await second.identify("100.90.80.70", 2)).toEqual(fresh);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a reassigned address is caught by the re-check and dropped from the file", async () => {
		const { dir, file } = tmp();
		try {
			write(file, {
				v: 1,
				entries: [{ addr: "100.90.80.70", at: Date.now() - 1000, value: me }],
			});
			const nobody = runner({
				whois: { ok: false, stdout: "", stderr: "no match for IP:port" },
			});
			const id = new TailscaleIdentity({ run: nobody.run, file });
			// The first answer is the cached one (the residual: one whois long)…
			expect(await id.identify("100.90.80.70", 1)).toMatchObject(me);
			await settle();
			// …the re-check said no match: the next connection is refused, the file forgets it.
			expect(await id.identify("100.90.80.70", 2)).toBeNull();
			await id.save();
			expect(JSON.parse(readFileSync(file, "utf8")).entries).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("only an answer from a fresh lookup is confirmed (a connection may keep it)", async () => {
		const { dir, file } = tmp();
		try {
			write(file, {
				v: 1,
				entries: [{ addr: "100.90.80.70", at: Date.now() - 1000, value: me }],
			});
			const id = new TailscaleIdentity({
				run: runner({ whois: ok }).run,
				file,
			});
			// Served from the file while whois checks it again: not confirmed.
			expect(await id.identify("100.90.80.70", 1)).toMatchObject(me);
			expect(id.confirmed("100.90.80.70")).toBe(false);
			await settle();
			expect(id.confirmed("100.90.80.70")).toBe(true);
			expect(id.confirmed("100.90.80.71")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("entries past the stale window, from the future, or malformed are ignored", async () => {
		const { dir, file } = tmp();
		try {
			write(file, {
				v: 1,
				entries: [
					{ addr: "100.90.80.71", at: Date.now() - 2 * 3600_000, value: me },
					{ addr: "100.90.80.72", at: Date.now() + 3600_000, value: me },
					{ addr: "10.0.0.1", at: Date.now(), value: me },
					{ addr: "100.90.80.73", at: Date.now(), value: { login: "x" } },
					null,
				],
			});
			const r = runner({});
			const id = new TailscaleIdentity({ run: r.run, file, waitMs: 0 });
			for (const a of ["100.90.80.71", "100.90.80.72", "100.90.80.73"])
				await expect(id.identify(a, 1)).rejects.toBeInstanceOf(
					IdentityUnavailable,
				);
			expect(await id.identify("10.0.0.1", 1)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a corrupt or foreign file is ignored and replaced", async () => {
		const { dir, file } = tmp();
		try {
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, "{not json");
			const r = runner({ whois: ok });
			const id = new TailscaleIdentity({ run: r.run, file });
			expect(await id.identify("100.90.80.70", 1)).toMatchObject(me);
			expect(r.calls.length).toBe(1);
			await id.save();
			expect(JSON.parse(readFileSync(file, "utf8")).v).toBe(1);
			write(file, { v: 2, entries: [] });
			expect(() => new TailscaleIdentity({ run: r.run, file })).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("whois over the LocalAPI", () => {
	const body = JSON.stringify(fixture("whois.json"));
	const ep = { kind: "tcp" as const, port: 41112, token: "t" };

	test("whois goes to the LocalAPI; everything else to the CLI", async () => {
		const paths: string[] = [];
		const cli = runner({ status: { ok: true, stdout: "{}", stderr: "" } });
		const run = localApiRunner({
			fallback: cli.run,
			discover: () => ep,
			get: async (_ep, path) => {
				paths.push(path);
				return { status: 200, body };
			},
		});
		expect(await run(["whois", "--json", "[fd7a:115c:a1e0::1]:443"])).toEqual({
			ok: true,
			stdout: body,
			stderr: "",
		});
		expect(paths).toEqual([
			"/localapi/v0/whois?addr=%5Bfd7a%3A115c%3Aa1e0%3A%3A1%5D%3A443",
		]);
		await run(["status", "--json"]);
		expect(cli.calls).toEqual([["status", "--json"]]);
	});

	test("a 404 is a definite no match (no CLI)", async () => {
		const cli = runner({});
		const run = localApiRunner({
			fallback: cli.run,
			discover: () => ep,
			get: async () => ({ status: 404, body: "no match for IP:port" }),
		});
		const id = new TailscaleIdentity({ run });
		expect(await id.identify("100.90.80.70", 1)).toBeNull();
		expect(cli.calls).toEqual([]);
	});

	test("a refused or rejected LocalAPI looks again once, then falls back to the CLI", async () => {
		let discovered = 0;
		const cli = runner({ whois: { ok: true, stdout: body, stderr: "" } });
		const run = localApiRunner({
			fallback: cli.run,
			discover: () => {
				discovered++;
				return ep;
			},
			get: async () => {
				if (discovered === 1) throw new Error("ECONNREFUSED");
				return { status: 401, body: "" };
			},
		});
		expect((await run(["whois", "--json", "100.90.80.70:1"])).ok).toBe(true);
		expect(discovered).toBe(2);
		expect(cli.calls.length).toBe(1);
		// No LocalAPI at all: straight to the CLI.
		const none = localApiRunner({ fallback: cli.run, discover: () => null });
		expect((await none(["whois", "--json", "100.90.80.70:1"])).ok).toBe(true);
		expect(cli.calls.length).toBe(2);
	});

	test("discovery: macsys port and token, the App Store's shared dir, a unix socket", async () => {
		const fs = (
			files: Record<string, string>,
			links: Record<string, string> = {},
			sockets: string[] = [],
		) => ({
			readlink: async (p: string) => {
				if (p in links) return links[p]!;
				throw new Error("ENOENT");
			},
			readFile: async (p: string) => {
				if (p in files) return files[p]!;
				throw new Error("ENOENT");
			},
			readdir: async (p: string) => {
				const names = Object.keys(files)
					.filter((f) => f.startsWith(`${p}/`))
					.map((f) => f.slice(p.length + 1));
				if (!names.length) throw new Error("ENOENT");
				return names;
			},
			isSocket: async (p: string) => sockets.includes(p),
		});
		expect(
			await discoverLocalApi({
				platform: "darwin",
				home: "/Users/me",
				fs: fs(
					{ "/Library/Tailscale/sameuserproof-56986": "secret\n" },
					{ "/Library/Tailscale/ipnport": "56986" },
				),
			}),
		).toEqual({ kind: "tcp", port: 56986, token: "secret" });
		expect(
			await discoverLocalApi({
				platform: "darwin",
				home: "/Users/me",
				fs: fs({
					"/Users/me/Library/Group Containers/io.tailscale.ipn.macos/sameuserproof-61577-2ae2ec9e":
						"",
				}),
			}),
		).toEqual({ kind: "tcp", port: 61577, token: "2ae2ec9e" });
		// An empty token file or a bad port is no endpoint.
		expect(
			await discoverLocalApi({
				platform: "darwin",
				home: "/Users/me",
				fs: fs(
					{ "/Library/Tailscale/sameuserproof-56986": "" },
					{ "/Library/Tailscale/ipnport": "56986" },
				),
			}),
		).toBeNull();
		expect(
			await discoverLocalApi({
				platform: "linux",
				fs: fs({}, {}, ["/var/run/tailscale/tailscaled.sock"]),
			}),
		).toEqual({ kind: "unix", path: "/var/run/tailscale/tailscaled.sock" });
		expect(
			await discoverLocalApi({ platform: "linux", fs: fs({}) }),
		).toBeNull();
	});

	test("localApiGet speaks HTTP with the token as Basic auth and the CSRF header", async () => {
		const { createServer } = await import("node:http");
		const seen: Record<string, string | undefined> = {};
		const server = createServer((req, res) => {
			seen.auth = req.headers.authorization;
			seen.csrf = req.headers["sec-tailscale"] as string | undefined;
			seen.url = req.url;
			res.writeHead(200).end(body);
		});
		await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
		try {
			const port = (server.address() as { port: number }).port;
			const r = await localApiGet(
				{ kind: "tcp", port, token: "tok" },
				"/localapi/v0/whois?addr=x",
				2000,
			);
			expect(r).toEqual({ status: 200, body });
			expect(seen).toEqual({
				auth: `Basic ${Buffer.from(":tok").toString("base64")}`,
				csrf: "localapi",
				url: "/localapi/v0/whois?addr=x",
			});
		} finally {
			server.close();
		}
	});
});
