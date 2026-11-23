import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClientErrorReport,
	ClientErrors,
	clientErrorLine,
	clientErrorNote,
	KEEP,
	PER_MINUTE,
} from "../src/diagnostics/client-errors.ts";
import { parseClientError } from "../src/diagnostics/client-errors-schema.ts";
import { StaticIdentity } from "../src/http/identity.ts";
import { flushLog } from "../src/log.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { restoreEnv } from "./helpers.ts";

/**
 * App load error reports (`POST /api/v1/client-errors`): the schema, the
 * rate limit, the daemon.log line and doctor's note.
 */

const report = (over: Partial<ClientErrorReport> = {}): ClientErrorReport => ({
	kind: "chunk",
	build: "abc123def456",
	urls: ["https://studio.example.ts.net/_app/UsageView.Bx3k.js"],
	error: { name: "TypeError", message: "Importing a module script failed." },
	sw: {
		controller: "0123456789ab",
		state: "active",
		caches: ["pulsar-shell-0123456789ab"],
		failed: ["/_app/UsageView.Bx3k.js 404"],
	},
	online: true,
	standalone: true,
	ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X)",
	route: "/usage",
	reloaded: false,
	at: 1_700_000_000_000,
	...over,
});

describe("the report schema", () => {
	test("a full report passes", () => {
		expect(parseClientError(JSON.stringify(report()))).toEqual(report());
	});

	test("unknown fields, kinds, long text and non-JSON are refused", () => {
		const bad = [
			{ ...report(), draft: "hello" },
			{ ...report(), kind: "other" },
			{ ...report(), build: "x".repeat(65) },
			{ ...report(), urls: Array(6).fill("/_app/a.js") },
			{ ...report(), error: { name: "E", message: "m".repeat(501) } },
			{ ...report(), sw: { ...report().sw, token: "t" } },
			{ ...report(), online: "yes" },
		];
		for (const b of bad) expect(parseClientError(JSON.stringify(b))).toBeNull();
		expect(parseClientError("not json")).toBeNull();
		expect(parseClientError(" ".repeat(9000))).toBeNull();
	});
});

describe("ClientErrors", () => {
	test("keeps the last reports and limits the rate over every device", () => {
		let now = 0;
		const c = new ClientErrors(() => now);
		for (let i = 0; i < PER_MINUTE; i++) expect(c.add(report())).toBe(true);
		expect(c.add(report())).toBe(false);
		expect(c.summary().dropped).toBe(1);
		now += 60_000;
		expect(c.add(report())).toBe(true);
		for (let m = 0; m < 3; m++) {
			now += 60_000;
			for (let i = 0; i < PER_MINUTE; i++) c.add(report({ build: `b${m}` }));
		}
		expect(c.recent()).toHaveLength(KEEP);
	});

	test("counts by build and by file", () => {
		const c = new ClientErrors(() => 5000);
		c.add(report());
		c.add(report({ build: "fff000fff000", urls: [] }));
		c.add(report({ urls: [], sw: { ...report().sw, failed: [] } }));
		const s = c.summary();
		expect(s.byBuild).toEqual({ abc123def456: 2, fff000fff000: 1 });
		expect(s.byUrl).toEqual({
			"/_app/UsageView.Bx3k.js": 2,
			"(unknown file)": 1,
		});
		expect(s.last?.receivedAt).toBe(5000);
	});
});

describe("the log line and doctor's note", () => {
	test("one line with the fields, no control characters", () => {
		const line = clientErrorLine(
			report({
				error: { name: "TypeError", message: "bad\nline\u2028two" },
				route: "/a/claude:x",
			}),
		);
		expect(line).not.toMatch(/[\n\r\u2028]/);
		expect(line).toStartWith("client load error: kind=chunk");
		for (const part of [
			"build=abc123def456",
			"sw=0123456789ab/active",
			"url=/_app/UsageView.Bx3k.js",
			"err=TypeError: bad line two",
			"route=/a/claude:x",
			"standalone=true",
			"ua=Mozilla/5.0 (iPhone",
		])
			expect(line).toContain(part);
	});

	test("doctor notes nothing without reports, then counts per build and file", () => {
		expect(clientErrorNote(undefined)).toBeNull();
		expect(clientErrorNote(new ClientErrors().summary())).toBeNull();
		const c = new ClientErrors(() => 1000);
		c.add(report());
		c.add(report());
		c.add(report({ build: "fff000fff000", kind: "boot" }));
		const note = clientErrorNote(c.summary(), 121_000);
		expect(note?.text).toBe(
			"recent app load errors: 3 report(s); by build: abc123def456: 2, fff000fff000: 1; by file: /_app/UsageView.Bx3k.js: 3; last 2 min ago: boot, TypeError: Importing a module script failed.",
		);
		expect(note?.fix).toContain("daemon.log");
	});
});

describe("POST /api/v1/client-errors", () => {
	let dir: string;
	let store: Store;
	let service: PulsarService;
	let http: HttpTransport;
	let base: string;
	const previousHome = process.env.PULSAR_HOME;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-clienterr-"));
		process.env.PULSAR_HOME = dir;
		store = new Store(join(dir, "pulsar.db"));
		service = new PulsarService({ store, scan: false, machine: "studio" });
		http = new HttpTransport(service, {
			identity: new StaticIdentity("me@example.com", "phone"),
			owner: "me@example.com",
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
		});
		await http.listen();
		base = `http://127.0.0.1:${http.port}/api/v1/client-errors`;
	});

	afterAll(async () => {
		await http.close();
		service.stop();
		store.close();
		restoreEnv("PULSAR_HOME", previousHome);
		rmSync(dir, { recursive: true, force: true });
	});

	const send = (body: string, headers: Record<string, string>) =>
		fetch(base, { method: "POST", body, headers });

	test("a report is logged, kept and in status", async () => {
		const res = await send(JSON.stringify(report()), {
			"X-Pulsar": "1",
			"Content-Type": "application/json",
		});
		expect(res.status).toBe(204);
		expect(service.clientErrors.recent()).toHaveLength(1);
		await flushLog();
		const log = readFileSync(join(dir, "daemon.log"), "utf8");
		expect(log).toContain(
			"client load error: kind=chunk build=abc123def456 sw=0123456789ab/active url=/_app/UsageView.Bx3k.js",
		);
		const status = (await service.handle(
			{
				principal: { kind: "terminal" },
				closed: new AbortController().signal,
				emit: () => {},
			},
			"status",
			{},
		)) as { clientErrors: { count: number } };
		expect(status.clientErrors.count).toBe(1);
	});

	test("a same-origin beacon needs no X-Pulsar; another request does", async () => {
		const beacon = await send(JSON.stringify(report({ kind: "boot" })), {
			"Content-Type": "text/plain",
			"Sec-Fetch-Site": "same-origin",
		});
		expect(beacon.status).toBe(204);
		const bare = await send(JSON.stringify(report()), {
			"Content-Type": "text/plain",
		});
		expect(bare.status).toBe(403);
	});

	test("a bad, oversized or too frequent report is refused", async () => {
		const h = { "X-Pulsar": "1", "Content-Type": "application/json" };
		expect((await send('{"kind":"chunk"}', h)).status).toBe(400);
		expect(
			(await send(JSON.stringify({ ...report(), pad: "x".repeat(9000) }), h))
				.status,
		).toBe(413);
		let last = 0;
		for (let i = 0; i < PER_MINUTE; i++)
			last = (await send(JSON.stringify(report()), h)).status;
		expect(last).toBe(429);
	});
});
