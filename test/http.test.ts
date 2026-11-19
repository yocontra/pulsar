import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	brotliCompressSync,
	brotliDecompressSync,
	gunzipSync,
	gzipSync,
} from "node:zlib";
import { EventHub } from "../src/http/events.ts";
import { IdentityUnavailable, StaticIdentity } from "../src/http/identity.ts";
import type {
	AgentsPage,
	AttentionList,
	Hello,
	Page,
	SessionOptionsResponse,
	SessionVerifyResponse,
	TreePage,
} from "../src/http/wire.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import type { AgentRow, TreeNode } from "../src/service/views.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import type { Agent } from "../src/types.ts";
import { registration, until } from "./helpers.ts";
import { SoftAuthenticator } from "./webauthn.ts";

const OWNER = "me@example.com";
const PROJECTS = 20;
const PER_PROJECT = 100;
const HARNESSES = ["alpha", "beta", "gamma", "delta"];

let dir: string;
let store: Store;
let service: PulsarService;
let http: HttpTransport;
let base: string;
const pushes: Array<{ text: string }> = [];
const interrupts: Array<{ requestId: string }> = [];
let extCaller: Caller;
let extAgent: Agent;
let n = 0;

function project(i: number) {
	return `p${String(i).padStart(2, "0")}`;
}

/** A synthetic agent with no push path (its harness has no driver). */
function addAgent(p: string, harness = HARNESSES[n % HARNESSES.length]!) {
	const i = n++;
	return service.registry.upsert({
		harness,
		sessionId: `s${i}`,
		pid: null,
		cwd: `/work/${p}`,
		project: p,
		branch: i % 3 === 0 ? "main" : `feat-${i % 7}`,
		tags: [
			`harness:${harness}`,
			`project:${p}`,
			...(i % 50 === 0 ? ["role:reviewer"] : []),
		],
		name: `${harness}-${i}`,
		meta: {},
		registered: false,
		status: "idle",
		model: i % 2 ? "claude-fable-5-2" : "gpt-5.5",
	});
}

function api(path: string, init: RequestInit = {}) {
	return fetch(`${base}${path}`, {
		...init,
		headers: {
			"X-Pulsar": "1",
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...(init.headers as Record<string, string> | undefined),
		},
	});
}

async function json<T = Record<string, unknown>>(
	path: string,
	init?: RequestInit,
) {
	const res = await api(path, init);
	return { status: res.status, body: (await res.json()) as T, res };
}

function post(path: string, body: unknown) {
	return json(path, { method: "POST", body: JSON.stringify(body) });
}

/** A POST with the passkey session (the user confirmed with Face ID / Touch ID). */
function postAs(path: string, body: unknown) {
	return json(path, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { Authorization: `Bearer ${sessionToken}` },
	});
}

let sessionToken = "";

/** Registers a software passkey and signs a passkey session with it. */
async function startSession(): Promise<string> {
	const origin = base;
	const headers = {
		"X-Pulsar": "1",
		"Content-Type": "application/json",
		Origin: origin,
	};
	const call = async <T>(path: string, body: unknown) =>
		(await (
			await fetch(`${base}/api/v1${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			})
		).json()) as T;
	const key = new SoftAuthenticator({ origin, rpId: "localhost" });
	const reg = await call<{ options: never }>("/passkeys/register/options", {
		label: "MacBook",
	});
	await call("/passkeys/register/verify", {
		response: key.register(reg.options),
	});
	const o = await call<SessionOptionsResponse>("/session/options", {
		device: "MacBook",
	});
	const v = await call<SessionVerifyResponse>("/session/verify", {
		requestId: o.requestId,
		assertion: key.assert(o.options as never),
	});
	return v.token;
}

/** A request with a Host header fetch would not let us set. */
const BUNDLE = "export const answer = 42;\n".repeat(400);

function rawGet(path: string, headers: Record<string, string>) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = httpRequest(
			{ host: "127.0.0.1", port: http.port, path, headers },
			(res) => {
				let body = "";
				res.on("data", (d) => {
					body += d;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

/** A GET with the response's raw headers and (still encoded) bytes. */
function rawFetch(path: string, headers: Record<string, string>) {
	return new Promise<{
		status: number;
		headers: Record<string, string | string[] | undefined>;
		body: Buffer;
	}>((resolve, reject) => {
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port: http.port,
				path,
				headers: { Host: `127.0.0.1:${http.port}`, ...headers },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (d: Buffer) => chunks.push(d));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

interface SseEvent {
	id: string;
	event: string;
	data: Record<string, unknown>;
}

async function openEvents(lastEventId?: string) {
	const ac = new AbortController();
	const res = await fetch(`${base}/api/v1/events`, {
		headers: {
			"X-Pulsar": "1",
			...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
		},
		signal: ac.signal,
	});
	const events: SseEvent[] = [];
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	void (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				let end = buffer.indexOf("\n\n");
				while (end !== -1) {
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const e: Partial<SseEvent> & { raw?: string } = {};
					for (const line of block.split("\n")) {
						if (line.startsWith("id: ")) e.id = line.slice(4);
						else if (line.startsWith("event: ")) e.event = line.slice(7);
						else if (line.startsWith("data: "))
							e.data = JSON.parse(line.slice(6));
					}
					if (e.event) events.push(e as SseEvent);
					end = buffer.indexOf("\n\n");
				}
			}
		} catch {}
	})();
	const wait = async (pred: (e: SseEvent) => boolean, ms = 2000) => {
		let found: SseEvent | undefined;
		await until(() => {
			found = events.find(pred);
			return Boolean(found);
		}, ms);
		return found!;
	};
	return { res, events, wait, close: () => ac.abort() };
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pulsar-http-"));
	const web = join(dir, "web");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(web);
	writeFileSync(
		join(web, "index.html"),
		"<!doctype html><title>pulsar</title>",
	);
	writeFileSync(join(web, "app.js"), "console.log(1)");
	// A hashed build asset with its precompressed sidecars (finish-dist.ts).
	mkdirSync(join(web, "_app"));
	writeFileSync(join(web, "_app", "main.abc123.js"), BUNDLE);
	writeFileSync(
		join(web, "_app", "main.abc123.js.br"),
		brotliCompressSync(BUNDLE),
	);
	writeFileSync(join(web, "_app", "main.abc123.js.gz"), gzipSync(BUNDLE));
	store = new Store(join(dir, "pulsar.db"));
	service = new PulsarService({ store, scan: false, machine: "studio" });
	for (let p = 0; p < PROJECTS; p++)
		for (let i = 0; i < PER_PROJECT; i++) addAgent(project(p));
	// One agent whose session pulsar can push into (an extension connection).
	const controller = new AbortController();
	const ext: Caller = {
		principal: { kind: "terminal" },
		closed: controller.signal,
		emit: (event, data) => {
			if (event === "push") pushes.push(data as { text: string });
			if (event === "interrupt") interrupts.push(data as { requestId: string });
		},
	};
	extCaller = ext;
	service.attach(ext);
	service.setRole(ext, "extension");
	extAgent = service.registerAgent(
		ext,
		registration({
			harness: "pi",
			project: "zz-ext",
			sessionId: "ext-1",
			role: "extension",
		}),
	);
	http = new HttpTransport(service, {
		identity: new StaticIdentity(OWNER, "phone"),
		owner: OWNER,
		hosts: ["127.0.0.1"],
		port: 0,
		webRoot: web,
		hub: { coalesceMs: 40 },
	});
	await http.listen();
	base = `http://127.0.0.1:${http.port}`;
	sessionToken = await startSession();
});

afterAll(async () => {
	await http.close();
	service.stop();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const TOTAL = PROJECTS * PER_PROJECT + 1;

describe("identity and browser checks", () => {
	test("hello needs only identity", async () => {
		const res = await fetch(`${base}/api/v1/hello`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			machineId: service.machineId,
			machine: "studio",
			fedProtocol: [1, 1],
			you: { login: OWNER, node: "phone" },
		});
		expect(typeof body.version).toBe("string");
	});

	test("an API call without X-Pulsar is refused", async () => {
		const res = await fetch(`${base}/api/v1/agents`);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"missing_header",
		);
		const wrong = await fetch(`${base}/api/v1/agents`, {
			headers: { "X-Pulsar": "yes" },
		});
		expect(wrong.status).toBe(403);
	});

	test("a POST without the header is refused before it runs", async () => {
		const res = await fetch(`${base}/api/v1/send`, {
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: JSON.stringify({ to: "*", body: "hi" }),
		});
		expect(res.status).toBe(403);
	});

	test("a foreign Origin is refused; an allowed one gets CORS", async () => {
		const bad = await api("/api/v1/agents", {
			headers: { Origin: "https://evil.example" },
		});
		expect(bad.status).toBe(403);
		expect(bad.headers.get("access-control-allow-origin")).toBeNull();
		const good = await api("/api/v1/agents?limit=1", {
			headers: { Origin: base },
		});
		expect(good.status).toBe(200);
		expect(good.headers.get("access-control-allow-origin")).toBe(base);
		const pre = await fetch(`${base}/api/v1/send`, {
			method: "OPTIONS",
			headers: {
				Origin: `http://localhost:${http.port}`,
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "x-pulsar, content-type",
			},
		});
		expect(pre.status).toBe(204);
		expect(pre.headers.get("access-control-allow-headers")).toContain(
			"X-Pulsar",
		);
		const evilPre = await fetch(`${base}/api/v1/send`, {
			method: "OPTIONS",
			headers: { Origin: "https://evil.example" },
		});
		expect(evilPre.status).toBe(403);
	});

	test("a cross-site fetch is refused", async () => {
		const res = await api("/api/v1/agents", {
			headers: { "Sec-Fetch-Site": "cross-site" },
		});
		expect(res.status).toBe(403);
	});

	test("an unknown Host is refused (DNS rebinding)", async () => {
		const r = await rawGet("/api/v1/hello", { Host: "evil.example:80" });
		expect(r.status).toBe(421);
		const ok = await rawGet("/api/v1/hello", {
			Host: `localhost:${http.port}`,
		});
		expect(ok.status).toBe(200);
	});

	test("security headers on the API, static files and refusals", async () => {
		for (const res of [
			await api("/api/v1/agents?limit=1"),
			await fetch(`${base}/`),
			await fetch(`${base}/api/v1/agents`),
		]) {
			expect(res.headers.get("content-security-policy")).toBe(
				"default-src 'self'; script-src 'self'; img-src 'self' data: blob:; frame-src blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'",
			);
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		}
		expect(
			(await api("/api/v1/agents?limit=1")).headers.get("cache-control"),
		).toBe("no-store");
	});

	test("the static app: files, SPA routes, no traversal", async () => {
		const index = await fetch(`${base}/`);
		expect(index.headers.get("content-type")).toContain("text/html");
		expect(await index.text()).toContain("<title>pulsar</title>");
		const js = await fetch(`${base}/app.js`);
		expect(js.headers.get("content-type")).toContain("text/javascript");
		expect(await (await fetch(`${base}/agents/some-id`)).text()).toContain(
			"<title>",
		);
		expect((await fetch(`${base}/missing.js`)).status).toBe(404);
		expect(
			(
				await rawGet("/..%2F..%2Fetc%2Fpasswd", {
					Host: `127.0.0.1:${http.port}`,
				})
			).body,
		).not.toContain("root:");
	});

	test("static files: precompressed by Accept-Encoding, ETags, cache policy", async () => {
		const path = "/_app/main.abc123.js";
		const br = await rawFetch(path, { "Accept-Encoding": "gzip, deflate, br" });
		expect(br.status).toBe(200);
		expect(br.headers["content-encoding"]).toBe("br");
		expect(br.headers.vary).toBe("Accept-Encoding");
		expect(Number(br.headers["content-length"])).toBe(br.body.length);
		expect(brotliDecompressSync(br.body).toString()).toBe(BUNDLE);
		expect(br.headers["cache-control"]).toBe(
			"public, max-age=31536000, immutable",
		);
		// Security headers stay on static files.
		expect(br.headers["content-security-policy"]).toContain(
			"script-src 'self'",
		);
		expect(br.headers["x-content-type-options"]).toBe("nosniff");

		const gz = await rawFetch(path, { "Accept-Encoding": "gzip" });
		expect(gz.headers["content-encoding"]).toBe("gzip");
		const plain = await rawFetch(path, {});
		expect(plain.headers["content-encoding"]).toBeUndefined();
		expect(plain.body.toString()).toBe(BUNDLE);

		const etag = String(br.headers.etag);
		const again = await rawFetch(path, {
			"Accept-Encoding": "br",
			"If-None-Match": etag,
		});
		expect(again.status).toBe(304);
		expect(again.body.length).toBe(0);
		expect(again.headers["cache-control"]).toBe(
			"public, max-age=31536000, immutable",
		);

		// HTML and sw.js revalidate; a missing build asset is not cached.
		for (const p of ["/", "/agents/x", "/app.js"])
			expect((await rawFetch(p, {})).headers["cache-control"]).toBe("no-cache");
		const missing = await rawFetch("/_app/gone.js", {});
		expect(missing.status).toBe(404);
		expect(missing.headers["cache-control"]).toBe("no-cache");
		// The API stays no-store.
		expect(
			(await api("/api/v1/agents?limit=1")).headers.get("cache-control"),
		).toBe("no-store");
	});

	test("the QR endpoint returns the app URL as SVG", async () => {
		const res = await api("/api/v1/qr");
		expect(res.headers.get("content-type")).toContain("image/svg+xml");
		expect(await res.text()).toContain("<svg");
		const sameOrigin = await fetch(`${base}/api/v1/qr`, {
			headers: { "Sec-Fetch-Site": "same-origin" },
		});
		expect(sameOrigin.status).toBe(200);
	});

	test("unknown endpoints are JSON 404s", async () => {
		const r = await json<{ error: { code: string } }>("/api/v1/nope");
		expect(r.status).toBe(404);
		expect(r.body.error.code).toBe("not_found");
	});
});

describe("identity from the connection only", () => {
	async function withIdentity(
		login: string,
		fn: (url: string) => Promise<void>,
	) {
		const t = new HttpTransport(service, {
			identity: new StaticIdentity(login, "laptop"),
			owner: OWNER,
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
		});
		await t.listen();
		try {
			await fn(`http://127.0.0.1:${t.port}`);
		} finally {
			await t.close();
		}
	}

	test("a login other than the owner is refused, whatever the headers claim", async () => {
		await withIdentity("intruder@evil.example", async (url) => {
			for (const path of ["/api/v1/hello", "/api/v1/agents", "/"]) {
				const res = await fetch(`${url}${path}`, {
					headers: {
						"X-Pulsar": "1",
						"Tailscale-User-Login": OWNER,
						"Tailscale-User-Name": "Me",
						"X-Forwarded-For": "100.64.0.1",
					},
				});
				expect(res.status).toBe(403);
				if (path !== "/")
					expect(
						((await res.json()) as { error: { code: string } }).error.code,
					).toBe("not_owner");
			}
		});
	});

	test("an identity lookup that cannot finish is a 503 to retry, never a 403", async () => {
		let calls = 0;
		const t = new HttpTransport(service, {
			identity: {
				identify: async () => {
					calls++;
					if (calls === 1) throw new IdentityUnavailable("tailscaled is slow");
					return { login: OWNER, node: "laptop", nodeId: "dev" };
				},
			},
			owner: OWNER,
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
		});
		await t.listen();
		try {
			const url = `http://127.0.0.1:${t.port}/api/v1/hello`;
			const first = await fetch(url, { headers: { "X-Pulsar": "1" } });
			expect(first.status).toBe(503);
			expect(first.headers.get("retry-after")).toBe("2");
			expect(
				((await first.json()) as { error: { code: string } }).error.code,
			).toBe("identity_unavailable");
			// The failure is not kept for the connection: the retry is asked again.
			const again = await fetch(url, { headers: { "X-Pulsar": "1" } });
			expect(again.status).toBe(200);
		} finally {
			await t.close();
		}
	});

	test("identity headers on the owner's connection are ignored", async () => {
		const r = await json<{
			you: { login: string; node: string; name?: string };
		}>("/api/v1/hello", {
			headers: {
				"Tailscale-User-Login": "intruder@evil.example",
				"Tailscale-User-Name": "x",
			},
		});
		expect(r.body.you).toEqual({ login: OWNER, node: "phone", name: OWNER });
	});

	test("an unidentified connection is refused", async () => {
		const t = new HttpTransport(service, {
			identity: { identify: async () => null },
			owner: OWNER,
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
		});
		await t.listen();
		try {
			const res = await fetch(`http://127.0.0.1:${t.port}/api/v1/hello`);
			expect(res.status).toBe(403);
		} finally {
			await t.close();
		}
	});

	test("a failed whois isn't kept for the connection: the next request on it looks again", async () => {
		const { Agent, request } = await import("node:http");
		let calls = 0;
		const t = new HttpTransport(service, {
			identity: {
				identify: async () =>
					++calls === 1 ? null : { login: OWNER, node: "phone", nodeId: "n" },
			},
			owner: OWNER,
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
		});
		await t.listen();
		const agent = new Agent({ keepAlive: true, maxSockets: 1 });
		const ports: number[] = [];
		const get = () =>
			new Promise<number>((resolve, reject) => {
				const req = request(
					{
						host: "127.0.0.1",
						port: t.port,
						path: "/api/v1/hello",
						agent,
						headers: { "X-Pulsar": "1" },
					},
					(res) => {
						ports.push(req.socket?.localPort ?? 0);
						res.resume();
						res.on("end", () => resolve(res.statusCode ?? 0));
					},
				);
				req.on("error", reject);
				req.end();
			});
		try {
			expect(await get()).toBe(403);
			expect(await get()).toBe(200);
			// The same keep-alive connection both times.
			expect(ports[0]).toBe(ports[1]!);
			expect(calls).toBe(2);
		} finally {
			agent.destroy();
			await t.close();
		}
	});

	test("a stale identity isn't kept for the connection: it is asked again until a fresh whois confirms it", async () => {
		const { Agent, request } = await import("node:http");
		let calls = 0;
		const t = new HttpTransport(service, {
			identity: {
				identify: async () => {
					calls++;
					return { login: OWNER, node: "phone", nodeId: "n" };
				},
				// The first answer came from the cache while whois ran again.
				confirmed: () => calls >= 2,
			},
			owner: OWNER,
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
		});
		await t.listen();
		const agent = new Agent({ keepAlive: true, maxSockets: 1 });
		const ports: number[] = [];
		const get = () =>
			new Promise<number>((resolve, reject) => {
				const req = request(
					{
						host: "127.0.0.1",
						port: t.port,
						path: "/api/v1/hello",
						agent,
						headers: { "X-Pulsar": "1" },
					},
					(res) => {
						ports.push(req.socket?.localPort ?? 0);
						res.resume();
						res.on("end", () => resolve(res.statusCode ?? 0));
					},
				);
				req.on("error", reject);
				req.end();
			});
		try {
			expect(await get()).toBe(200);
			expect(await get()).toBe(200);
			expect(await get()).toBe(200);
			// The same keep-alive connection every time.
			expect(new Set(ports).size).toBe(1);
			// Stale: asked again; confirmed on the second: kept.
			expect(calls).toBe(2);
		} finally {
			agent.destroy();
			await t.close();
		}
	});

	test("binding every interface is refused", () => {
		for (const host of ["0.0.0.0", "::", "192.168.1.9"])
			expect(
				() =>
					new HttpTransport(service, {
						identity: new StaticIdentity(OWNER),
						owner: OWNER,
						hosts: [host],
						port: 0,
					}),
			).toThrow();
	});
});

describe("pool views on 2,000 agents", () => {
	test("tree by machine: one local machine with rollups", async () => {
		const t0 = performance.now();
		const r = await json<{
			items: TreeNode[];
			total: number;
			nextCursor: string | null;
		}>("/api/v1/tree");
		const ms = performance.now() - t0;
		expect(r.body.total).toBe(1);
		const m = r.body.items[0]!;
		expect(m).toMatchObject({
			kind: "machine",
			label: "studio",
			machineId: service.machineId,
			link: "local",
			childCount: PROJECTS + 1,
		});
		expect(m.rollup).toMatchObject({
			agents: TOTAL,
			needsYou: 0,
			busy: 0,
			idle: TOTAL,
			offline: 0,
		});
		// Generous: a loaded machine (a parallel build) must not fail it; the
		// federation load test reports real timings.
		expect(ms).toBeLessThan(2500);
	});

	test("children page through projects, then agents", async () => {
		const m = (await json<{ items: TreeNode[] }>("/api/v1/tree")).body
			.items[0]!;
		const first = await json<{
			items: TreeNode[];
			total: number;
			nextCursor: string;
		}>(`/api/v1/tree/${encodeURIComponent(m.id)}/children?limit=5`);
		expect(first.body.total).toBe(PROJECTS + 1);
		expect(first.body.items.map((i) => i.label)).toEqual([
			"p00",
			"p01",
			"p02",
			"p03",
			"p04",
		]);
		expect(first.body.items[0]!.rollup!.agents).toBe(PER_PROJECT);
		const second = await json<{ items: TreeNode[] }>(
			`/api/v1/tree/${encodeURIComponent(m.id)}/children?limit=5&cursor=${first.body.nextCursor}`,
		);
		expect(second.body.items[0]!.label).toBe("p05");
		const p00 = first.body.items[0]!;
		const agents = await json<{
			items: TreeNode[];
			total: number;
			nextCursor: string | null;
		}>(`/api/v1/tree/${encodeURIComponent(p00.id)}/children?limit=60`);
		expect(agents.body.total).toBe(PER_PROJECT);
		expect(agents.body.items.length).toBe(60);
		expect(agents.body.items[0]!.kind).toBe("agent");
		expect(agents.body.items[0]!.agent!.project).toBe("p00");
		expect(agents.body.nextCursor).not.toBeNull();
	});

	test("tree with expand: the named branches' first pages ride along", async () => {
		const plain = await json<TreePage>("/api/v1/tree");
		expect(plain.body.expanded).toBeUndefined();
		const m = plain.body.items[0]!;
		const p00 = `${m.id}/p:p00`;
		// default: this machine (a pool of one is small: every machine).
		const r = await json<TreePage>("/api/v1/tree?expand=default");
		expect(r.body.items).toEqual(plain.body.items);
		expect(Object.keys(r.body.expanded!)).toEqual([m.id]);
		const kids = r.body.expanded![m.id]!;
		expect(kids.total).toBe(PROJECTS + 1);
		expect(kids.items.length).toBe(PROJECTS + 1);
		expect(kids.items[0]!.label).toBe("p00");
		// Named ids, an unknown one skipped, the same page as /children.
		const named = await json<TreePage>(
			`/api/v1/tree?expand=${encodeURIComponent(`${p00},zz`)}`,
		);
		const direct = await json<Page<TreeNode>>(
			`/api/v1/tree/${encodeURIComponent(p00)}/children`,
		);
		expect(named.body.expanded).toEqual({ [p00]: direct.body });
	});

	test("JSON responses are compressed for clients that accept it", async () => {
		const plain = await api("/api/v1/agents?limit=200", {
			headers: { "Accept-Encoding": "identity" },
		});
		const text = await plain.text();
		expect(plain.headers.get("content-encoding")).toBeNull();
		for (const enc of ["br", "gzip"]) {
			const res = await fetch(`${base}/api/v1/agents?limit=200`, {
				headers: { "X-Pulsar": "1", "Accept-Encoding": enc },
				decompress: false,
			} as RequestInit);
			expect(res.headers.get("content-encoding")).toBe(enc);
			expect(res.headers.get("vary")).toContain("Accept-Encoding");
			const raw = Buffer.from(await res.arrayBuffer());
			expect(raw.length).toBeLessThan(text.length / 3);
			const back = enc === "br" ? brotliDecompressSync(raw) : gunzipSync(raw);
			expect(back.toString("utf8")).toBe(text);
		}
		// Small bodies and the event stream go as they are.
		const small = await fetch(`${base}/api/v1/hello`, {
			headers: { "X-Pulsar": "1", "Accept-Encoding": "br" },
			decompress: false,
		} as RequestInit);
		expect(small.headers.get("content-encoding")).toBeNull();
		expect(
			((await small.json()) as { machineId: string }).machineId,
		).toBeTruthy();
	});

	test("tree by project, filtered", async () => {
		const r = await json<{ items: TreeNode[]; total: number }>(
			"/api/v1/tree?group=projects&filter=harness%3Dalpha&limit=500",
		);
		expect(r.body.total).toBe(PROJECTS);
		expect(r.body.items[0]!.rollup!.agents).toBe(PER_PROJECT / 4);
		const kids = await json<{ items: TreeNode[] }>(
			`/api/v1/tree/${encodeURIComponent(r.body.items[0]!.id)}/children?filter=harness%3Dalpha`,
		);
		expect(kids.body.items).toHaveLength(1);
		expect(kids.body.items[0]).toMatchObject({
			kind: "machine",
			childCount: PER_PROJECT / 4,
		});
	});

	test("bad node ids and cursors are 400s", async () => {
		expect((await api("/api/v1/tree/zz/children")).status).toBe(400);
		expect((await api("/api/v1/agents?cursor=bogus")).status).toBe(400);
		expect((await api("/api/v1/agents?limit=0")).status).toBe(400);
		expect((await api("/api/v1/tree?group=planets")).status).toBe(400);
	});

	test("agents: selector, paging, counts and wakeability", async () => {
		const held = service.registry.get("alpha:s0")!;
		held.inbound = "hold";
		const refusing = service.registry.get("beta:s1")!;
		refusing.inbound = "refuse";
		try {
			const t0 = performance.now();
			const one = await json<{
				items: AgentRow[];
				total: number;
				machines: number;
				nextCursor: string;
			}>("/api/v1/agents?selector=project%3Dp00&limit=60&sort=name");
			expect(performance.now() - t0).toBeLessThan(2500);
			expect(one.body.total).toBe(PER_PROJECT);
			expect(one.body.machines).toBe(1);
			expect(one.body.items).toHaveLength(60);
			const two = await json<{ items: AgentRow[]; nextCursor: string | null }>(
				`/api/v1/agents?selector=project%3Dp00&limit=60&sort=name&cursor=${one.body.nextCursor}`,
			);
			expect(two.body.items).toHaveLength(40);
			expect(two.body.nextCursor).toBeNull();
			const all = [...one.body.items, ...two.body.items];
			expect(new Set(all.map((a) => a.id)).size).toBe(PER_PROJECT);
			const byId = new Map(all.map((a) => [a.id, a]));
			expect(byId.get("alpha:s0")!.wake).toBe("held");
			expect(byId.get("beta:s1")!.wake).toBe("refuses");
			expect(byId.get("gamma:s2")!.wake).toBe("inbox-only");
			expect(byId.get("gamma:s2")!.address).toBe(
				`${service.machineId}/gamma:s2`,
			);
			const ext = await json<{ items: AgentRow[] }>(
				`/api/v1/agents?selector=${extAgent.id}`,
			);
			expect(ext.body.items[0]!.wake).toBe("wakes");
			const everyone = await json<{ total: number }>("/api/v1/agents?limit=1");
			expect(everyone.body.total).toBe(TOTAL);
		} finally {
			held.inbound = "accept";
			refusing.inbound = "accept";
		}
	});

	test("facets count within the match, each ignoring its own filter", async () => {
		const r = await json<{
			total: number;
			facet: string;
			values: Array<{ value: string; count: number; term: string }>;
			more: number;
		}>(
			"/api/v1/facets?selector=project%3Dp03%20harness%3Dalpha&facet=project&top=5",
		);
		expect(r.body.total).toBe(PER_PROJECT / 4);
		expect(r.body.values).toHaveLength(5);
		expect(r.body.values.every((v) => v.count === PER_PROJECT / 4)).toBe(true);
		expect(r.body.values[0]!.term).toBe("project=p00");
		expect(r.body.more).toBe(PROJECTS - 5);
		const search = await json<{
			values: Array<{ value: string }>;
			more: number;
		}>("/api/v1/facets?selector=project%3Dp03&facet=project&q=p1");
		expect(search.body.values.map((v) => v.value)).toContain("p10");
		expect(search.body.values.every((v) => v.value.includes("p1"))).toBe(true);
		const t0 = performance.now();
		const every = await json<{
			total: number;
			facets: Record<
				string,
				{ values: Array<{ value: string; count: number }>; more: number }
			>;
		}>("/api/v1/facets?selector=project%3Dp03");
		expect(performance.now() - t0).toBeLessThan(4000);
		expect(every.body.total).toBe(PER_PROJECT);
		expect(every.body.facets.harness!.values.map((v) => v.count)).toEqual([
			25, 25, 25, 25,
		]);
		expect(every.body.facets.machine!.values).toEqual([
			{ value: "studio", count: PER_PROJECT, term: "machine=studio" } as never,
		]);
		expect(every.body.facets.role!.values[0]).toMatchObject({
			value: "reviewer",
			count: 2,
		});
	});

	test("search groups machines, projects, agents and tags, five each", async () => {
		const r = await json<{
			machines: Array<{ name: string }>;
			projects: Array<{ name: string; agents: number }>;
			agents: AgentRow[];
			tags: Array<{ tag: string }>;
		}>("/api/v1/search?q=p1");
		expect(r.body.projects.length).toBe(5);
		expect(r.body.projects[0]!.agents).toBe(PER_PROJECT);
		expect(r.body.tags.length).toBeLessThanOrEqual(5);
		const m = await json<{ machines: Array<{ name: string; agents: number }> }>(
			"/api/v1/search?q=stud",
		);
		expect(m.body.machines).toEqual([
			expect.objectContaining({ name: "studio", agents: TOTAL }),
		]);
		const empty = await json<{ agents: unknown[] }>("/api/v1/search?q=");
		expect(empty.body.agents).toEqual([]);
	});

	test("recent lists the latest agents", async () => {
		const r = await json<{ items: AgentRow[] }>("/api/v1/recent?limit=3");
		expect(r.body.items).toHaveLength(3);
	});

	test("needs-you: derived status, virtual tag, attention, rollups", async () => {
		const agent = service.registry.get("delta:s3")!;
		service.registry.setNeedsYou(agent.id, {
			reason: "approval",
			detail: "Bash",
		});
		try {
			const att = await json<AttentionList>("/api/v1/attention");
			expect(att.body.total).toBe(1);
			expect(att.body.items[0]).toMatchObject({
				kind: "approval",
				title: "Bash",
				agent: {
					id: agent.id,
					state: "needs-you",
					needsYou: { reason: "approval", detail: "Bash" },
				},
			});
			const tagged = await json<{ items: AgentRow[]; total: number }>(
				"/api/v1/agents?selector=needs%3Dyou",
			);
			expect(tagged.body.items.map((a) => a.id)).toEqual([agent.id]);
			expect(tagged.body.items[0]!.tags).toContain("needs:you");
			const first = await json<{ items: AgentRow[] }>(
				`/api/v1/agents?selector=project%3D${agent.project}&limit=1`,
			);
			expect(first.body.items[0]!.id).toBe(agent.id);
			const tree = await json<{ items: TreeNode[] }>("/api/v1/tree");
			expect(tree.body.items[0]!.rollup).toMatchObject({
				needsYou: 1,
				idle: TOTAL - 1,
			});
			// The tag is pulsar's: never stored, never claimable by an agent.
			expect(agent.tags).not.toContain("needs:you");
		} finally {
			service.registry.setNeedsYou(agent.id, null);
		}
		expect(
			(await json<{ total: number }>("/api/v1/attention")).body.total,
		).toBe(0);
	});
});

describe("hardening", () => {
	test("CSP forbids base, form and object targets; big bodies get 413", async () => {
		const r = await api("/api/v1/hello");
		const csp = r.headers.get("content-security-policy")!;
		for (const d of [
			"base-uri 'none'",
			"form-action 'none'",
			"object-src 'none'",
		])
			expect(csp).toContain(d);
		const big = await api("/api/v1/send", {
			method: "POST",
			body: JSON.stringify({ to: "*", body: "x".repeat(3 * 1024 * 1024) }),
		});
		expect(big.status).toBe(413);
		expect(((await big.json()) as { error: { code: string } }).error.code).toBe(
			"too_large",
		);
	});
});

describe("app contract", () => {
	test("hello names the app URL, the login, totals and features", async () => {
		const r = await json<Hello>("/api/v1/hello");
		expect(r.body).toMatchObject({
			machine: "studio",
			appUrl: `http://127.0.0.1:${http.port}/`,
			you: { login: OWNER },
			machines: 1,
			firstRun: false,
		});
		expect(r.body.agents).toBeGreaterThan(0);
		expect(r.body.features).toContain("send");
		expect(r.body.features).toContain("stop");
		expect(r.body.features).toContain("approvals");
	});

	test("one agent by id, a 404 for an unknown one", async () => {
		const r = await json<AgentRow>(
			`/api/v1/agents/${encodeURIComponent(extAgent.id)}`,
		);
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ id: extAgent.id, wake: "wakes" });
		expect(typeof r.body.stateSince).toBe("number");
		const missing = await api("/api/v1/agents/pi%3Anobody");
		expect(missing.status).toBe(404);
	});

	test("attention: approvals first, then questions, newest first", async () => {
		const ids = ["gamma:s10", "delta:s11", "alpha:s12"];
		const at = Date.now;
		let now = at();
		Date.now = () => now;
		try {
			service.registry.setNeedsYou(ids[0]!, {
				reason: "approval",
				detail: null,
			});
			now += 10;
			service.registry.setNeedsYou(ids[1]!, { reason: "asked", detail: "q?" });
			now += 10;
			service.registry.setNeedsYou(ids[2]!, {
				reason: "approval",
				detail: null,
			});
		} finally {
			Date.now = at;
		}
		try {
			const r = await json<AttentionList>("/api/v1/attention");
			expect(r.body.items.map((i) => i.agent.id)).toEqual([
				ids[2]!,
				ids[0]!,
				ids[1]!,
			]);
		} finally {
			for (const id of ids) service.registry.setNeedsYou(id, null);
		}
	});

	test("stop asks the agent's extension and audits the result", async () => {
		const row = await json<AgentRow>(
			`/api/v1/agents/${encodeURIComponent(extAgent.id)}`,
		);
		expect(row.body.canStop).toBe(true);
		for (const answer of ["interrupted", "not-running"] as const) {
			const pending = postAs(
				`/api/v1/agents/${encodeURIComponent(extAgent.id)}/stop`,
				{},
			);
			await until(() => interrupts.length > 0);
			const { requestId } = interrupts.shift()!;
			// Nobody else may answer for the agent.
			expect(
				service.interrupts.answer("alpha:s0", {
					requestId,
					result: "interrupted",
				}),
			).toEqual({ ok: false });
			await service.handle(extCaller, "interrupt_result", {
				requestId,
				result: answer,
			});
			const r = await pending;
			expect(r.status).toBe(200);
			expect(r.body).toEqual({
				agentId: extAgent.id,
				result: answer,
				via: "extension",
			});
		}
		const audit = store.auditLog(2);
		expect(audit[0]).toMatchObject({
			principal: `human:${OWNER}@phone`,
			op: "stop",
			target: extAgent.id,
			detail: "not-running · extension",
			ok: true,
		});
		expect(audit[1]!.detail).toBe("interrupted · extension");
	});

	test("stop on an agent no driver can reach says unsupported", async () => {
		const row = await json<AgentRow>("/api/v1/agents/alpha%3As0");
		expect(row.body.canStop).toBe(false);
		const unverified = await post("/api/v1/agents/alpha%3As0/stop", {});
		expect(unverified.status).toBe(401);
		const r = await postAs("/api/v1/agents/alpha%3As0/stop", {});
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({
			agentId: "alpha:s0",
			result: "unsupported",
		});
		expect(store.auditLog(1)[0]).toMatchObject({
			target: "alpha:s0",
			ok: false,
		});
		const missing = await postAs("/api/v1/agents/pi%3Anobody/stop", {});
		expect(missing.status).toBe(404);
		// A malformed body is a bad request, not "no assertion".
		const bad = await json("/api/v1/agents/alpha%3As0/stop", {
			method: "POST",
			body: "{not json",
			headers: { Authorization: `Bearer ${sessionToken}` },
		});
		expect(bad.status).toBe(400);
		const extra = await postAs("/api/v1/agents/alpha%3As0/stop", {
			assertion: {},
			junk: 1,
		});
		expect(extra.status).toBe(400);
	});

	test("approvals check their body", async () => {
		const decide = await post("/api/v1/approvals/x/decide", {});
		expect(decide.status).toBe(400);
	});

	test("tree nodes carry selectors that pick their agents; sort orders groups", async () => {
		const top = await json<Page<TreeNode>>(
			"/api/v1/tree?group=projects&limit=3&sort=name",
		);
		const p00 = top.body.items[0]!;
		expect(p00.selector).toBe("project=p00");
		const picked = await json<AgentsPage>(
			`/api/v1/agents?selector=${encodeURIComponent(p00.selector)}&limit=1`,
		);
		expect(picked.body.total).toBe(p00.rollup!.agents);
		expect(picked.body.totals["inbox-only"]).toBeGreaterThan(0);
		const machine = (await json<Page<TreeNode>>("/api/v1/tree")).body.items[0]!;
		expect(machine.selector).toBe("machine=studio");
		const kids = await json<Page<TreeNode>>(
			`/api/v1/tree/${encodeURIComponent(machine.id)}/children?sort=name&limit=1`,
		);
		expect(kids.body.items[0]!.selector).toBe("machine=studio project=p00");
		const agents = await json<Page<TreeNode>>(
			`/api/v1/tree/${encodeURIComponent(kids.body.items[0]!.id)}/children?sort=name&limit=1`,
		);
		const leaf = agents.body.items[0]!;
		expect(leaf.selector).toBe(`id=${leaf.agent!.id}`);
		const bad = await api("/api/v1/tree?sort=sideways");
		expect(bad.status).toBe(400);
	});

	test("a dry run breaks recipients down by machine", async () => {
		const dry = await post("/api/v1/send", {
			to: "project=p01",
			body: "hi",
			dryRun: true,
		});
		expect(dry.body.breakdown).toEqual([
			{ machineId: service.machineId, machine: "studio", count: PER_PROJECT },
		]);
	});
});

describe("send as the user", () => {
	test("without a passkey session a send is the app's, never the user's", async () => {
		const r = await post("/api/v1/send", {
			ids: [extAgent.id],
			body: "unverified hello",
		});
		expect(r.status).toBe(200);
		const text = pushes.at(-1)!.text;
		expect(text).toStartWith(
			"[pulsar] Pulsar app on phone (not verified as your operator):",
		);
		expect(text).not.toContain("[human operator");
	});

	test("a held message keeps its own framing when a verified send follows", async () => {
		service.registry.setIdentity(extAgent, { inbound: "hold" });
		const before = pushes.length;
		try {
			// Unverified (no session), held; then the user sends with a session.
			expect(
				(
					await post("/api/v1/send", {
						ids: [extAgent.id],
						body: "HELD unverified",
					})
				).status,
			).toBe(200);
			expect(
				(
					await postAs("/api/v1/send", {
						ids: [extAgent.id],
						body: "HELD verified",
					})
				).status,
			).toBe(200);
		} finally {
			service.registry.setIdentity(extAgent, { inbound: "accept" });
		}
		await until(() => pushes.length >= before + 2);
		const text = (body: string) =>
			pushes.slice(before).find((p) => p.text.includes(body))!.text;
		expect(text("HELD unverified")).toStartWith(
			"[pulsar] Pulsar app on phone (not verified as your operator):",
		);
		expect(text("HELD verified")).toStartWith(
			`[human operator - ${OWNER}] HELD verified\n— via Pulsar from phone · reply: respond `,
		);
	});

	test("framed as the user's, pushed to a session that can take it", async () => {
		const r = await postAs("/api/v1/send", {
			ids: [extAgent.id],
			body: "rebase on main before pushing",
			expectReply: true,
		});
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({
			dryRun: false,
			count: 1,
			totals: { sent: 1 },
		});
		const text = pushes.at(-1)!.text;
		expect(text).toStartWith(
			`[human operator - ${OWNER}] rebase on main before pushing\n`,
		);
		expect(text).toContain("rebase on main before pushing");
		expect(text).toBe(
			`[human operator - ${OWNER}] rebase on main before pushing\n— via Pulsar from phone · waiting for your reply: respond ${(r.body.message as { id: string }).id}`,
		);
		const message = r.body.message as {
			id: string;
			fromId: string;
			fromName: string;
		};
		expect(message.fromId).toBe(`user:${OWNER}`);
		expect(message.fromName).toBe("user");

		// The agent replies; the user sees it with the receipts.
		const ext = [...service.sessions.forAgent(extAgent.id)][0]!;
		await service.handle(ext, "reply", { messageId: message.id, body: "done" });
		const receipts = await json<{
			totals: Record<string, number>;
			items: Array<{ agentId: string }>;
			replies: Array<{ body: string; replyTo: string }>;
		}>(`/api/v1/messages/${message.id}/receipts`);
		expect(receipts.body.items[0]!.agentId).toBe(extAgent.id);
		expect(receipts.body.items[0]).toMatchObject({
			machine: "studio",
			reply: "done",
		});
		expect(receipts.body.replies.map((m) => m.body)).toEqual(["done"]);
	});

	test("dry run predicts receipts; a large send needs its token", async () => {
		service.registry.get("alpha:s400")!.inbound = "hold";
		try {
			const dry = await post("/api/v1/send", {
				to: "project=p04",
				body: "hi",
				dryRun: true,
			});
			expect(dry.status).toBe(200);
			expect(dry.body).toMatchObject({
				dryRun: true,
				count: PER_PROJECT,
				machines: 1,
				totals: {
					wakes: 0,
					"inbox-only": PER_PROJECT - 1,
					held: 1,
					refuses: 0,
					queued: 0,
				},
			});
			expect((dry.body.preview as unknown[]).length).toBe(20);
			const fyi = await post("/api/v1/send", {
				to: "project=p04",
				dryRun: true,
				priority: "fyi",
			});
			expect(fyi.body.count).toBe(PER_PROJECT);

			const unconfirmed = await post("/api/v1/send", {
				to: "project=p04",
				body: "hi",
			});
			expect(unconfirmed.status).toBe(409);
			expect((unconfirmed.body.error as { code: string }).code).toBe("confirm");
			expect(typeof unconfirmed.body.resolveToken).toBe("string");

			const sent = await post("/api/v1/send", {
				to: "project=p04",
				body: "hi",
				resolveToken: dry.body.resolveToken,
			});
			expect(sent.status).toBe(200);
			expect(sent.body).toMatchObject({
				count: PER_PROJECT,
				totals: { queued: 99, held: 1 },
			});
			expect((sent.body.receipts as unknown[]).length).toBe(50);

			// Tokens are single use.
			const again = await post("/api/v1/send", {
				to: "project=p04",
				body: "hi",
				resolveToken: dry.body.resolveToken,
			});
			expect(again.status).toBe(409);
			expect((again.body.error as { code: string }).code).toBe("stale_token");

			const id = (sent.body.message as { id: string }).id;
			const page = await json<{
				items: unknown[];
				total: number;
				nextCursor: string;
			}>(`/api/v1/messages/${id}/receipts?limit=30`);
			expect(page.body.total).toBe(PER_PROJECT);
			expect(page.body.items).toHaveLength(30);
			const held = await json<{
				items: Array<{ agentId: string }>;
				total: number;
			}>(`/api/v1/messages/${id}/receipts?state=held`);
			expect(held.body.items.map((r) => r.agentId)).toEqual(["alpha:s400"]);
		} finally {
			service.registry.get("alpha:s400")!.inbound = "accept";
		}
	});

	test("a match that drifted more than 5% since the dry run is a 409", async () => {
		const dry = await post("/api/v1/send", {
			to: "project=p05",
			body: "x",
			dryRun: true,
		});
		const added = Array.from({ length: 10 }, () => addAgent("p05"));
		try {
			const drifted = await post("/api/v1/send", {
				to: "project=p05",
				body: "x",
				resolveToken: dry.body.resolveToken,
			});
			expect(drifted.status).toBe(409);
			expect((drifted.body.error as { code: string }).code).toBe("drift");
			expect(drifted.body.count).toBe(PER_PROJECT + 10);
			// One more agent (under 1%) does not invalidate the fresh token.
			added.push(addAgent("p05"));
			const ok = await post("/api/v1/send", {
				to: "project=p05",
				body: "x",
				resolveToken: drifted.body.resolveToken,
			});
			expect(ok.status).toBe(200);
			expect(ok.body.count).toBe(PER_PROJECT + 11);
		} finally {
			for (const a of added) service.registry.markGone(a);
		}
	});

	test("a token is bound to its recipients spec", async () => {
		const dry = await post("/api/v1/send", { to: "project=p06", dryRun: true });
		const other = await post("/api/v1/send", {
			to: "project=p07",
			body: "x",
			resolveToken: dry.body.resolveToken,
		});
		expect((other.body.error as { code: string }).code).toBe("stale_token");
	});

	test("bad sends are 400/404s", async () => {
		expect((await post("/api/v1/send", { body: "x" })).status).toBe(400);
		expect(
			(await post("/api/v1/send", { to: "a", ids: ["b"], body: "x" })).status,
		).toBe(400);
		expect(
			(await post("/api/v1/send", { to: "nobody-here", body: "x" })).status,
		).toBe(404);
		expect(
			(await post("/api/v1/send", { ids: [extAgent.id], body: "  " })).status,
		).toBe(400);
		expect(
			(await post("/api/v1/send", { to: "*", body: "x", extra: 1 })).status,
		).toBe(400);
		const notJson = await api("/api/v1/send", { method: "POST", body: "{" });
		expect(notJson.status).toBe(400);
	});

	test("receipts of messages the user did not send read as missing", async () => {
		const op = (await service.mailbox.send(service.registry.operator(), {
			to: extAgent.id,
			body: "from the terminal",
			priority: "fyi",
			replyTo: null,
			expectReply: false,
		})) as { message: { id: string } };
		expect(
			(await api(`/api/v1/messages/${op.message.id}/receipts`)).status,
		).toBe(404);
	});
});

describe("live updates", () => {
	test("watched receipts stream as the agent reads and replies", async () => {
		const sent = await post("/api/v1/send", {
			ids: [extAgent.id],
			body: "status?",
			expectReply: true,
		});
		const messageId = (sent.body.message as { id: string }).id;
		const s = await openEvents();
		const ready = await s.wait((e) => e.event === "ready");
		await api(`/api/v1/subscriptions/${ready.data.streamId as string}`, {
			method: "PUT",
			body: JSON.stringify({ receipts: [messageId, "not-a-message"] }),
		});
		const first = await s.wait(
			(e) => e.event === "receipts" && e.data.messageId === messageId,
		);
		expect(first.data).toMatchObject({ full: true, total: 1 });
		await s
			.wait(
				(e) => e.event === "receipts" && e.data.messageId === "not-a-message",
			)
			.then((e) => expect(e.data.missing).toBe(true));
		const ext = [...service.sessions.forAgent(extAgent.id)][0]!;
		await service.handle(ext, "reply", { messageId, body: "green" });
		const replied = await s.wait(
			(e) =>
				e.event === "receipts" &&
				e.data.messageId === messageId &&
				e.data.full === false,
			5000,
		);
		expect(replied.data.items).toEqual([
			expect.objectContaining({ reply: "green" }),
		]);
		s.close();
	});

	test("subscribe, get coalesced rollups, resume with Last-Event-ID", async () => {
		const streams = http.hub.streamCount;
		const s = await openEvents();
		const ready = await s.wait((e) => e.event === "ready");
		expect(ready.data).toMatchObject({ resumed: false });
		expect(s.res.headers.get("content-type")).toContain("text/event-stream");
		expect(s.res.headers.get("cache-control")).toBe("no-store");
		const streamId = ready.data.streamId as string;
		const machine = (await json<{ items: TreeNode[] }>("/api/v1/tree")).body
			.items[0]!;
		const put = await api(`/api/v1/subscriptions/${streamId}`, {
			method: "PUT",
			body: JSON.stringify({
				window: { group: "machines" },
				expanded: [machine.id],
				query: "status=busy",
			}),
		});
		expect(put.status).toBe(200);
		const snap = await s.wait(
			(e) => e.event === "tree" && e.data.full === true,
		);
		expect((snap.data.items as TreeNode[])[0]!.rollup!.busy).toBe(0);
		await s.wait((e) => e.event === "children" && e.data.full === true);
		await s.wait((e) => e.event === "query" && e.data.full === true);

		// Three changes in one tick arrive as one tree update.
		const before = s.events.length;
		for (const id of ["alpha:s800", "beta:s801", "gamma:s802"])
			service.registry.setStatus(service.registry.get(id)!, "busy");
		const update = await s.wait(
			(e) =>
				e.event === "tree" &&
				e.data.full === false &&
				s.events.indexOf(e) >= before,
		);
		expect((update.data.items as TreeNode[])[0]!.rollup!.busy).toBe(3);
		await new Promise((r) => setTimeout(r, 150));
		expect(
			s.events.filter((e, i) => i >= before && e.event === "tree"),
		).toHaveLength(1);
		const query = await s.wait(
			(e) => e.event === "query" && e.data.full === false,
		);
		expect(query.data.total).toBe(3);

		// Disconnect, miss an update, come back.
		const lastId = s.events.at(-1)!.id;
		s.close();
		await until(() => http.hub.streamCount === streams + 1);
		await new Promise((r) => setTimeout(r, 50));
		service.registry.setStatus(service.registry.get("delta:s803")!, "busy");
		await new Promise((r) => setTimeout(r, 150));
		const back = await openEvents(lastId);
		const resumed = await back.wait((e) => e.event === "ready");
		expect(resumed.data).toMatchObject({ resumed: true, streamId });
		// `ready` carries the resume point, not the newest seq: a drop right
		// after it resumes from there and still gets the missed events.
		expect(resumed.id).toBe(lastId);
		const missed = await back.wait((e) => e.event === "tree");
		expect((missed.data.items as TreeNode[])[0]!.rollup!.busy).toBe(4);
		// Replayed from the topic's log, not a fresh snapshot.
		expect(missed.data.full).toBe(false);
		back.close();
		for (const id of ["alpha:s800", "beta:s801", "gamma:s802", "delta:s803"])
			service.registry.setStatus(service.registry.get(id)!, "idle");
	});

	test("needs-you reaches subscribers at once, not on the tick", async () => {
		// A tick that never comes in this test: arrival alone proves immediacy.
		const hub = new EventHub(service, { coalesceMs: 600_000 });
		hub.start();
		try {
			const reader = hub.open(OWNER, null).getReader();
			const decode = async () =>
				new TextDecoder().decode((await reader.read()).value);
			expect(await decode()).toContain("event: ready");
			expect(await decode()).toContain("event: attention");
			service.registry.setNeedsYou("alpha:s4", {
				reason: "asked",
				detail: null,
			});
			const update = await decode();
			expect(update).toContain("event: attention");
			expect(update).toContain('"id":"alpha:s4"');
			expect(update).toContain('"full":false');
			await reader.cancel();
		} finally {
			service.registry.setNeedsYou("alpha:s4", null);
			hub.stop();
		}
	});

	test("an unknown or stale Last-Event-ID starts over with a gap", async () => {
		const s = await openEvents(`${http.hub.bootId}.nosuchstream.5`);
		await s.wait((e) => e.event === "ready" && e.data.resumed === false);
		await s.wait((e) => e.event === "gap" && e.data.reason === "expired");
		s.close();
		const old = await openEvents("oldboot.x.1");
		await old.wait((e) => e.event === "gap");
		old.close();
	});

	test("subscriptions need a live stream of the same user", async () => {
		const res = await api("/api/v1/subscriptions/nope", {
			method: "PUT",
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
		const bad = await api("/api/v1/subscriptions/nope", {
			method: "PUT",
			body: JSON.stringify({ window: { group: "planets" } }),
		});
		expect(bad.status).toBe(400);
	});

	test("EventSource from the same origin needs no custom header", async () => {
		const ac = new AbortController();
		const res = await fetch(`${base}/api/v1/events`, {
			headers: { "Sec-Fetch-Site": "same-origin" },
			signal: ac.signal,
		});
		expect(res.status).toBe(200);
		ac.abort();
		const noHeader = await fetch(`${base}/api/v1/events`);
		expect(noHeader.status).toBe(403);
	});
});

describe("event hub", () => {
	test("a client that falls behind gets a gap instead of an unbounded queue", async () => {
		const hub = new EventHub(service, { coalesceMs: 5, queueMax: 4 });
		hub.start();
		try {
			const body = hub.open(OWNER, null);
			const reader = body.getReader();
			const first = new TextDecoder().decode((await reader.read()).value);
			expect(first).toContain("event: ready");
			const streamId = /"streamId":"([^"]+)"/.exec(first)![1]!;
			hub.setSubscription(streamId, OWNER, {
				expanded: [],
				window: { group: "projects" },
				session: null,
				query: null,
				results: null,
				receipts: [],
			});
			// Many separate ticks of changes while nothing reads.
			for (let i = 0; i < 8; i++) {
				const a = service.registry.get(`alpha:s${i * 4}`)!;
				service.registry.setStatus(a, "busy");
				await new Promise((r) => setTimeout(r, 15));
			}
			// Whatever is still queued: it starts with (or holds) the gap.
			let text = "";
			for (;;) {
				const r = await Promise.race([
					reader.read(),
					new Promise<null>((done) => setTimeout(() => done(null), 200)),
				]);
				if (!r || r.done) break;
				text += new TextDecoder().decode(r.value);
			}
			expect(text).toContain("event: gap");
			expect(text).toContain('"reason":"overflow"');
			await reader.cancel();
		} finally {
			hub.stop();
			for (let i = 0; i < 8; i++)
				service.registry.setStatus(
					service.registry.get(`alpha:s${i * 4}`)!,
					"idle",
				);
		}
	});

	test("watched receipts recompute only when messages or receipts changed", async () => {
		const sent = await post("/api/v1/send", { ids: ["alpha:s0"], body: "hi" });
		const messageId = (sent.body.message as { id: string }).id;
		const hub = new EventHub(service, { coalesceMs: 5 });
		const app = service.app;
		const original = app.receipts.bind(app);
		let computed = 0;
		app.receipts = (...args: Parameters<typeof app.receipts>) => {
			computed++;
			return original(...args);
		};
		hub.start();
		try {
			const reader = hub.open(OWNER, null).getReader();
			const first = new TextDecoder().decode((await reader.read()).value);
			const streamId = /"streamId":"([^"]+)"/.exec(first)![1]!;
			hub.setSubscription(streamId, OWNER, {
				expanded: [],
				window: null,
				session: null,
				query: null,
				results: null,
				receipts: [messageId],
			});
			await new Promise((r) => setTimeout(r, 50));
			const settled = computed;
			// ~30 ticks with nothing written: no recompute.
			await new Promise((r) => setTimeout(r, 150));
			expect(computed).toBe(settled);
			// The agent reads it: recomputed on the next tick.
			service.store.markRead("alpha:s0", [messageId], Date.now());
			await new Promise((r) => setTimeout(r, 50));
			expect(computed).toBeGreaterThan(settled);
			await reader.cancel();
		} finally {
			app.receipts = original;
			hub.stop();
		}
	});

	test("one login holds a bounded number of streams; the oldest go first", () => {
		const hub = new EventHub(service, { maxStreamsPerLogin: 3 });
		const bodies = Array.from({ length: 6 }, () => hub.open(OWNER, null));
		expect(hub.streamCount).toBe(3);
		hub.open("other@example.com", null);
		expect(hub.streamCount).toBe(4);
		for (const b of bodies) void b.cancel().catch(() => {});
		hub.stop();
	});

	test("another user cannot take over a stream", () => {
		const hub = new EventHub(service);
		const body = hub.open(OWNER, null);
		void body.cancel();
		expect(
			hub.setSubscription("whatever", "other@example.com", {
				expanded: [],
				window: null,
				session: null,
				query: null,
				results: null,
				receipts: [],
			}),
		).toBe(false);
		hub.stop();
	});
});

describe("passkey sessions", () => {
	test("hello reports the session; list, revoke; a revoked token is plain again", async () => {
		const token = await startSession();
		const withSession = await json<Hello>("/api/v1/hello", {
			headers: { Authorization: `Bearer ${token}` },
		});
		const s = withSession.body.session!;
		expect(s.device).toBe("MacBook");
		// A browser on a pulsar node (here: loopback development): 12 hours.
		expect(s.expiresAt - s.createdAt).toBe(12 * 3600_000);
		expect((await json<Hello>("/api/v1/hello")).body.session).toBeNull();
		const bogus = await json<Hello>("/api/v1/hello", {
			headers: { Authorization: "Bearer not-a-token" },
		});
		expect(bogus.body.session).toBeNull();
		const list = await json<{ sessions: { id: string }[] }>("/api/v1/sessions");
		expect(list.body.sessions.map((x) => x.id)).toContain(s.id);
		// Without a session, signing a browser out is refused (an agent can't log you out).
		const plain = await post(`/api/v1/sessions/${s.id}/revoke`, {});
		expect(plain.status).toBe(401);
		const rv = await json(`/api/v1/sessions/${s.id}/revoke`, {
			method: "POST",
			body: "{}",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(rv.status).toBe(200);
		const after = await json<Hello>("/api/v1/hello", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(after.body.session).toBeNull();
		expect(
			store
				.auditLog(5)
				.some((a) => a.op === "session.revoke" && a.target === s.id),
		).toBe(true);
		// A session request can't be replayed.
		const o = await post("/api/v1/session/verify", {
			requestId: "session:nope",
			assertion: {},
		});
		expect(o.status).toBe(403);
	});
});
