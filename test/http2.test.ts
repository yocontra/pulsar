import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type ClientHttp2Session, connect } from "node:http2";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { StaticIdentity } from "../src/http/identity.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";

/**
 * The TLS server speaks HTTP/2 (and HTTP/1.1 by ALPN): one connection
 * carries the app's requests and its event stream. A self-signed
 * certificate for `localhost`, on loopback (`testing.loopbackTls`).
 */
const OWNER = "me@example.com";
let dir: string;
let store: Store;
let service: PulsarService;
let http: HttpTransport;
let authority: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pulsar-h2-"));
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:P-256",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost",
			"-keyout",
			join(dir, "key.pem"),
			"-out",
			join(dir, "cert.pem"),
		],
		{ stdio: "ignore" },
	);
	store = new Store(join(dir, "pulsar.db"));
	service = new PulsarService({ store, scan: false, machine: "studio" });
	for (let i = 0; i < 40; i++)
		service.registry.upsert({
			harness: "pi",
			sessionId: `s-${i}`,
			pid: null,
			cwd: "/work/demo",
			project: "demo",
			branch: "main",
			tags: [],
			meta: {},
			registered: false,
		});
	http = new HttpTransport(service, {
		identity: new StaticIdentity(OWNER, "laptop"),
		owner: OWNER,
		hosts: ["127.0.0.1"],
		port: 0,
		webRoot: null,
		tls: { cert: join(dir, "cert.pem"), key: join(dir, "key.pem") },
		publicName: "localhost",
		testing: { loopbackTls: true },
	});
	await http.listen();
	authority = `localhost:${http.port}`;
});

afterAll(async () => {
	await http.close();
	service.stop();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function session(): ClientHttp2Session {
	return connect(`https://127.0.0.1:${http.port}`, {
		rejectUnauthorized: false,
		servername: "localhost",
	});
}

function get(
	s: ClientHttp2Session,
	path: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
	return new Promise((ok, fail) => {
		const req = s.request({
			":path": path,
			":authority": authority,
			"x-pulsar": "1",
			...headers,
		});
		const chunks: Buffer[] = [];
		let head: Record<string, unknown> = {};
		req.on("response", (h) => {
			head = h;
		});
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () =>
			ok({
				status: Number(head[":status"]),
				headers: head,
				body: Buffer.concat(chunks),
			}),
		);
		req.on("error", fail);
		req.end();
	});
}

describe("HTTP/2 on the TLS server", () => {
	test("the API answers over h2, identified by the connection's address", async () => {
		const s = session();
		try {
			const r = await get(s, "/api/v1/hello");
			expect(r.status).toBe(200);
			const hello = JSON.parse(r.body.toString()) as {
				you?: { login: string };
			};
			expect(hello.you?.login).toBe(OWNER);
			expect(s.alpnProtocol).toBe("h2");
		} finally {
			s.close();
		}
	});

	test("one connection carries many requests at once", async () => {
		const s = session();
		try {
			const rs = await Promise.all(
				Array.from({ length: 30 }, () => get(s, "/api/v1/tree?group=machines")),
			);
			expect(rs.every((r) => r.status === 200)).toBe(true);
		} finally {
			s.close();
		}
	});

	test("Host (:authority), Origin and the custom header are checked as on HTTP/1.1", async () => {
		const s = session();
		try {
			expect(
				(await get(s, "/api/v1/hello", { ":authority": "evil.example:1" }))
					.status,
			).toBe(421);
			expect(
				(await get(s, "/api/v1/agents", { origin: "https://evil.example" }))
					.status,
			).toBe(403);
			expect(
				(await get(s, "/api/v1/agents", { origin: `https://${authority}` }))
					.status,
			).toBe(200);
			const noHeader = await new Promise<number>((ok) => {
				const req = s.request({
					":path": "/api/v1/agents",
					":authority": authority,
				});
				req.on("response", (h) => ok(Number(h[":status"])));
				req.resume();
				req.end();
			});
			expect(noHeader).toBe(403);
		} finally {
			s.close();
		}
	});

	test("JSON is compressed over h2", async () => {
		const s = session();
		try {
			const r = await get(s, "/api/v1/agents?limit=40", {
				"accept-encoding": "br",
			});
			expect(r.headers["content-encoding"]).toBe("br");
			const body = JSON.parse(brotliDecompressSync(r.body).toString()) as {
				total: number;
			};
			expect(body.total).toBe(40);
		} finally {
			s.close();
		}
	});

	test("the event stream stays open on the connection while other requests run; close() ends it", async () => {
		const s = session();
		const req = s.request({
			":path": "/api/v1/events",
			":authority": authority,
			"x-pulsar": "1",
		});
		let text = "";
		req.on("data", (c: Buffer) => {
			text += c.toString();
		});
		req.on("error", () => {});
		req.end();
		const start = Date.now();
		while (!text.includes("event: ready") && Date.now() - start < 5000)
			await new Promise((ok) => setTimeout(ok, 20));
		expect(text).toContain("event: ready");
		// The stream holds no connection slot: a request on the same session answers.
		expect((await get(s, "/api/v1/attention")).status).toBe(200);
		s.close();
	});

	test("HTTP/1.1 over TLS still works (ALPN), with the Host header", async () => {
		const status = await new Promise<number>((ok, fail) => {
			const req = httpsRequest(
				{
					host: "127.0.0.1",
					port: http.port,
					path: "/api/v1/hello",
					servername: "localhost",
					rejectUnauthorized: false,
					headers: { host: authority, "x-pulsar": "1" },
				},
				(res) => {
					res.resume();
					ok(res.statusCode ?? 0);
				},
			);
			req.on("error", fail);
			req.end();
		});
		expect(status).toBe(200);
	});
});

test("close() returns with an HTTP/2 event stream still open", async () => {
	const t = new HttpTransport(service, {
		identity: new StaticIdentity(OWNER, "laptop"),
		owner: OWNER,
		hosts: ["127.0.0.1"],
		port: 0,
		webRoot: null,
		tls: { cert: join(dir, "cert.pem"), key: join(dir, "key.pem") },
		publicName: "localhost",
		testing: { loopbackTls: true },
	});
	await t.listen();
	const s = connect(`https://127.0.0.1:${t.port}`, {
		rejectUnauthorized: false,
		servername: "localhost",
	});
	s.on("error", () => {});
	const req = s.request({
		":path": "/api/v1/events",
		":authority": `localhost:${t.port}`,
		"x-pulsar": "1",
	});
	req.on("error", () => {});
	let got = false;
	req.on("data", () => {
		got = true;
	});
	req.end();
	const start = Date.now();
	while (!got && Date.now() - start < 5000)
		await new Promise((ok) => setTimeout(ok, 20));
	const t0 = Date.now();
	await t.close();
	expect(Date.now() - t0).toBeLessThan(2000);
});
