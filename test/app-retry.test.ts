import { afterEach, describe, expect, test } from "bun:test";
import type { Tailnet, TailnetStatus } from "../src/federation/tailnet.ts";
import type { RemoteApp, RemoteOptions } from "../src/http/start.ts";
import { TailscaleNotReady, watchAddresses } from "../src/http/start.ts";
import { takeOver } from "../src/run-daemon.ts";
import { appWaitingLine } from "../src/setup/mesh-doctor.ts";
import type { HttpTransport } from "../src/transport/http.ts";
import type { AppStatus } from "../src/types.ts";
import { operator, startDaemon, until } from "./helpers.ts";

/**
 * The daemon serves the app once Tailscale is up, whenever that is: it
 * retries in every mode (service and on demand) and listens again when
 * Tailscale moves the node to other addresses. Tailscale is a fake here: a
 * real app would need this machine's tailnet addresses.
 */
function fakeTailscale() {
	const ts = {
		up: false,
		ips: ["100.64.0.1"],
		tries: 0,
		/** Listeners open now, and the most ever open at once. */
		open: 0,
		maxOpen: 0,
		/** Tries running now, and the most ever at once. */
		running: 0,
		maxRunning: 0,
		onAddressesChanged: null as ((ips: string[]) => void) | null,
		async startRemote(
			_service: unknown,
			_cfg: unknown,
			opts: RemoteOptions,
		): Promise<RemoteApp> {
			ts.tries++;
			ts.running++;
			ts.maxRunning = Math.max(ts.maxRunning, ts.running);
			try {
				await new Promise((r) => setTimeout(r, 5));
				if (!ts.up)
					throw new TailscaleNotReady(
						"Tailscale is not running or not logged in (backend state Stopped)",
					);
				ts.onAddressesChanged = opts.onAddressesChanged ?? null;
				ts.open++;
				ts.maxOpen = Math.max(ts.maxOpen, ts.open);
				const hosts = [...ts.ips];
				return {
					transport: {
						url: `https://node.example.ts.net:7337/ on ${hosts.join(",")}`,
					} as unknown as HttpTransport,
					hosts,
					close: async () => {
						ts.open--;
					},
				};
			} finally {
				ts.running--;
			}
		},
	};
	return ts;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

async function daemonWith(serviceMode: boolean) {
	const ts = fakeTailscale();
	const d = await startDaemon({
		serviceMode,
		remote: { mode: "tailscale", port: 7337 },
		startRemote: ts.startRemote,
		appRetryMs: () => 20,
	});
	cleanups.push(async () => {
		await d.daemon.stop();
		d.cleanup();
	});
	return { ...d, ts };
}

async function statusApp(): Promise<{ service: boolean; app: AppStatus }> {
	const client = await operator();
	try {
		return await client.call("status");
	} finally {
		client.close();
	}
}

describe("serving the app when Tailscale is not up yet", () => {
	for (const serviceMode of [true, false]) {
		const mode = serviceMode ? "service" : "on-demand";
		test(`${mode} daemon keeps running, retries, and serves once Tailscale is up`, async () => {
			const { daemon, ts } = await daemonWith(serviceMode);
			await until(() => ts.tries >= 3);
			const waiting = await statusApp();
			expect(waiting.service).toBe(serviceMode);
			expect(waiting.app).toMatchObject({
				state: "retrying",
				tailscale: true,
				error: expect.stringContaining("Tailscale is not running"),
			});
			// Waiting for Tailscale is not idle: the app may be opened any time.
			expect(daemon.idleTooLong(Date.now() + 24 * 3600_000)).toBe(false);

			ts.up = true;
			await until(() => daemon.appStatus().state === "serving");
			const served = await statusApp();
			expect(served.app).toEqual({
				state: "serving",
				url: "https://node.example.ts.net:7337/ on 100.64.0.1",
				hosts: ["100.64.0.1"],
			});
			// Served: no more tries.
			const tries = ts.tries;
			await new Promise((r) => setTimeout(r, 100));
			expect(ts.tries).toBe(tries);
			expect(ts.maxRunning).toBe(1);
			expect(ts.open).toBe(1);
		});
	}

	test("listens again when Tailscale moves the node to other addresses", async () => {
		const { daemon, ts } = await daemonWith(true);
		ts.up = true;
		await until(() => daemon.appStatus().state === "serving");
		ts.ips = ["100.64.0.9"];
		ts.onAddressesChanged?.(["100.64.0.9"]);
		// A second report from the same poll while the first is handled.
		ts.onAddressesChanged?.(["100.64.0.9"]);
		await until(() => {
			const app = daemon.appStatus();
			return app.state === "serving" && app.hosts[0] === "100.64.0.9";
		});
		expect(ts.open).toBe(1);
		expect(ts.maxOpen).toBe(1);
		expect(ts.maxRunning).toBe(1);
	});

	test("an address change while Tailscale is down again retries until it is back", async () => {
		const { daemon, ts } = await daemonWith(false);
		ts.up = true;
		await until(() => daemon.appStatus().state === "serving");
		ts.up = false;
		ts.onAddressesChanged?.(["100.64.0.9"]);
		await until(() => daemon.appStatus().state === "retrying");
		expect(ts.open).toBe(0);
		ts.ips = ["100.64.0.9"];
		ts.up = true;
		await until(() => daemon.appStatus().state === "serving");
		expect(ts.open).toBe(1);
	});

	test("all shutdown callers wait for the in-flight app startup and close", async () => {
		const ts = fakeTailscale();
		ts.up = true;
		const start = Promise.withResolvers<void>();
		const { daemon, cleanup } = await startDaemon({
			remote: { mode: "tailscale", port: 7337 },
			startRemote: async (...args) => {
				await start.promise;
				return ts.startRemote(...args);
			},
		});
		try {
			const stopping = daemon.stop();
			expect(daemon.stop()).toBe(stopping);
			start.resolve();
			await stopping;
			expect(ts.tries).toBe(1);
			expect(ts.open).toBe(0);
		} finally {
			start.resolve();
			await daemon.stop();
			cleanup();
		}
	});

	test("a stopped daemon stops retrying", async () => {
		const { daemon, ts } = await daemonWith(true);
		await until(() => ts.tries >= 2);
		await daemon.stop();
		const tries = ts.tries;
		await new Promise((r) => setTimeout(r, 100));
		expect(ts.tries).toBe(tries);
	});

	test("the mesh off: nothing to serve, the daemon may idle out", async () => {
		const { daemon, cleanup } = await startDaemon({ serviceMode: false });
		cleanups.push(async () => {
			await daemon.stop();
			cleanup();
		});
		expect(daemon.appStatus()).toEqual({ state: "off" });
	});
});

describe("doctor: why the app is not served", () => {
	test("Tailscale not ready, and the daemon retrying", () => {
		const now = Date.parse("2026-11-23T01:34:00Z");
		const line = appWaitingLine(
			{
				state: "retrying",
				error:
					"Tailscale is not running or not logged in (backend state Stopped)",
				tailscale: true,
				attempt: 3,
				since: Date.parse("2026-11-23T01:33:45Z"),
				retryAt: now + 5_000,
			},
			now,
		);
		expect(line).toBe(
			"the app is not served because Tailscale was not ready: Tailscale is not running or not logged in (backend state Stopped); the daemon keeps retrying, next try in 5 s (3 tries since 2026-11-23T01:33:45.000Z)",
		);
	});

	test("another failure is named as is", () => {
		const line = appWaitingLine({
			state: "retrying",
			error: "HTTPS certificates are off",
			tailscale: false,
			attempt: 1,
			since: 0,
			retryAt: 0,
		});
		expect(line).toStartWith(
			"the app is not served: HTTPS certificates are off; the daemon keeps retrying, next try in 0 s (1 try since",
		);
	});

	test("served or off: nothing to say", () => {
		expect(appWaitingLine({ state: "off" })).toBeNull();
		expect(
			appWaitingLine({ state: "serving", url: "https://x/", hosts: [] }),
		).toBeNull();
	});
});

describe("the pool's status polls report new addresses", () => {
	function tailnetWith(ips: string[] | undefined) {
		const tn = {
			ips,
			async status(): Promise<TailnetStatus | null> {
				if (!tn.ips) return null;
				return {
					self: {
						nodeId: "n1",
						name: "studio",
						dnsName: "studio.tail1234.ts.net",
						userId: "7",
						login: "me@example.com",
						tags: [],
						online: true,
						ownerLogin: "me@example.com",
						...(tn.ips.length ? { ips: tn.ips } : {}),
					},
					peers: [],
				};
			},
			fetch: () => Promise.reject(new Error("unused")),
		};
		return tn;
	}

	test("only a different set of addresses is a change", async () => {
		const tn = tailnetWith(["100.64.0.1", "fd7a::1"]);
		const changes: string[][] = [];
		const watched: Tailnet = watchAddresses(
			tn,
			["fd7a::1", "100.64.0.1"],
			(ips) => changes.push(ips),
		);
		expect((await watched.status())?.self.name).toBe("studio");
		// Tailscale down, or a status without addresses: no change to act on.
		tn.ips = undefined;
		await watched.status();
		tn.ips = [];
		await watched.status();
		expect(changes).toEqual([]);
		tn.ips = ["100.64.0.9", "fd7a::1"];
		await watched.status();
		expect(changes).toEqual([["100.64.0.9", "fd7a::1"]]);
	});
});

describe("the service taking the socket over", () => {
	test("another service keeps it: refused", async () => {
		const d = await startDaemon({ serviceMode: true });
		cleanups.push(async () => {
			await d.daemon.stop();
			d.cleanup();
		});
		expect(
			await takeOver(
				async () => false,
				async () => null,
				{ timeoutMs: 2000, pollMs: 10 },
			),
		).toBe("refused");
	});

	test("a lock that never lets go: failed (the service exits 1 to be restarted)", async () => {
		const d = await startDaemon();
		await d.daemon.stop();
		cleanups.push(async () => d.cleanup());
		// Nothing answers on the socket, and the claim never succeeds.
		let claims = 0;
		const r = await takeOver(
			async () => {
				claims++;
				return false;
			},
			async () => 4242,
			{ timeoutMs: 300, pollMs: 10 },
		);
		expect(r).toBe("failed");
		expect(claims).toBeGreaterThan(5);
	});

	test("claims once it lets go", async () => {
		const d = await startDaemon();
		await d.daemon.stop();
		cleanups.push(async () => d.cleanup());
		let claims = 0;
		const r = await takeOver(
			async () => ++claims >= 4,
			async () => null,
			{ timeoutMs: 5000, pollMs: 10 },
		);
		expect(r).toBe("claimed");
		expect(claims).toBe(4);
	});
});
