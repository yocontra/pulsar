import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencode } from "../src/harnesses/opencode.ts";
import {
	opencodePending,
	opencodeReply,
} from "../src/harnesses/opencode-interactions.ts";
import type { ServerPrompt, ServerReply } from "../src/harnesses/types.ts";
import { processSnapshot } from "../src/processes.ts";
import { agentRecord } from "./subagent-fixtures.ts";

/**
 * A fake `opencode` first on PATH: it logs each call's argv (one JSON array
 * per line) and answers `opencode api …` from `routes.json`, keyed
 * "session.active" or "<METHOD> <path without query>". "FAIL" exits 1.
 * A fake `ps` lists OpenCode's shared server, so no real one is needed (or
 * started: a real process would make every daemon here see a server).
 */
const dir = mkdtempSync(join(tmpdir(), "pulsar-oc-"));
const log = join(dir, "calls.jsonl");
const routesFile = join(dir, "routes.json");
const previousPath = process.env.PATH;

function stub(name: string, body: string) {
	const path = join(dir, name);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
}

stub(
	"opencode",
	`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(routesFile)}, "utf8"));
const key = args[1] === "session.active" || args[2] === "/api/session/active" ? "session.active" : args[1] + " " + String(args[2]).split("?")[0];
const out = key in routes ? routes[key] : {};
if (out === "FAIL") process.exit(1);
process.stdout.write(JSON.stringify(out));
`,
);
/** What the fake `ps` does: list the server, list no server, or fail. */
const psMode = join(dir, "ps-mode");
const psLog = join(dir, "ps-calls");
stub(
	"ps",
	`#!/bin/sh
echo >> "${psLog}"
case "$(cat "${psMode}" 2>/dev/null)" in
fail) exit 1;;
none) echo "1 0 /sbin/launchd";;
*) echo "99999 1 opencode-fake serve --service";;
esac
`,
);

function routes(r: Record<string, unknown>) {
	writeFileSync(routesFile, JSON.stringify(r));
	rmSync(log, { force: true });
}

const calls = (): string[][] =>
	existsSync(log)
		? readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l))
				// Which `opencode` to run is asked once with `--version`.
				.filter((c: string[]) => c[0] !== "--version")
		: [];

/** Takes a fresh process snapshot (twice, past any in-flight one). */
async function refreshSnapshot() {
	await processSnapshot(0);
	await processSnapshot(0);
}

/** OpenCode's state folder: empty (no service.json) unless a test writes one. */
const stateDir = join(dir, "state");
const previousState = process.env.XDG_STATE_HOME;

beforeAll(async () => {
	process.env.PATH = `${dir}:${previousPath}`;
	// Never the real service.json (it would reach the operator's OpenCode).
	process.env.XDG_STATE_HOME = stateDir;
	await refreshSnapshot();
});

afterAll(async () => {
	process.env.PATH = previousPath;
	if (previousState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = previousState;
	await refreshSnapshot();
	rmSync(dir, { recursive: true, force: true });
});

const FORM = {
	id: "frm_1",
	sessionID: "ses_1",
	title: "Questions",
	metadata: { kind: "question" },
	fields: [
		{
			key: "q0",
			title: "Color",
			description: "Which color?",
			type: "string",
			options: [
				{ value: "red", label: "Red" },
				{ value: "green", label: "Green" },
			],
		},
		{
			key: "q1",
			title: "Sizes",
			type: "multiselect",
			options: [
				{ value: "S", label: "Small" },
				{ value: "M", label: "Medium" },
			],
		},
	],
};

const GOOD = {
	"session.active": { data: { ses_1: {} } },
	"GET /api/session/ses_1/permission": {
		data: [
			{
				id: "per_1",
				sessionID: "ses_1",
				action: "bash",
				resources: ["rm -rf build"],
				save: ["rm *"],
			},
		],
	},
	"GET /api/session/ses_1/form": { data: [FORM] },
};

beforeEach(() => routes(GOOD));

describe("opencodePending (fake opencode on PATH)", () => {
	test("reads each active session's permissions and forms", async () => {
		const got = await opencodePending();
		expect(got.map((p) => [p.key, p.kind, p.tool])).toEqual([
			["per_1", "permission", "bash"],
			["frm_1", "question", "question"],
		]);
		expect(got[0]).toMatchObject({
			sessionId: "ses_1",
			input: { action: "bash", resources: ["rm -rf build"] },
			// OpenCode's `save` patterns are what "Always allow" remembers.
			sessionRules: ["bash: rm *"],
		});
		expect(got[1]!.prompt?.kind).toBe("question");
		const [first, ...rest] = calls();
		expect(first).toEqual(["api", "GET", "/api/session/active"]);
		// The two per-session reads run in parallel: any order.
		expect(rest.map((c) => c.join(" ")).sort()).toEqual([
			"api GET /api/session/ses_1/form",
			"api GET /api/session/ses_1/permission",
		]);
	});

	test("a permission without save patterns has no session rules", async () => {
		routes({
			...GOOD,
			"GET /api/session/ses_1/permission": {
				data: [{ id: "per_2", action: "edit", resources: ["a.ts"] }],
			},
			"GET /api/session/ses_1/form": { data: [] },
		});
		const got = await opencodePending();
		expect(got).toHaveLength(1);
		expect(got[0]!.sessionRules).toBeNull();
	});

	test("an unreadable session list throws instead of reading as no prompts", async () => {
		routes({ ...GOOD, "session.active": "FAIL" });
		await expect(opencodePending()).rejects.toThrow("opencode api failed");
	});

	test("an unreadable session's prompts throw", async () => {
		routes({ ...GOOD, "GET /api/session/ses_1/form": "FAIL" });
		await expect(opencodePending()).rejects.toThrow("opencode api failed");
	});

	describe("the process list", () => {
		/** Sets the fake `ps` mode and takes a snapshot with it. */
		const ps = async (mode: "fail" | "none") => {
			writeFileSync(psMode, mode);
			await refreshSnapshot();
		};
		afterEach(async () => {
			writeFileSync(psMode, "server");
			await refreshSnapshot();
		});

		test("a failed ps throws instead of reading as no server", async () => {
			await ps("fail");
			await expect(opencodePending()).rejects.toThrow(
				"process list unreadable",
			);
			expect(calls()).toEqual([]);
		});

		test("ps with no OpenCode server is no prompts, and asks OpenCode nothing", async () => {
			await ps("none");
			expect(await opencodePending()).toEqual([]);
			expect(calls()).toEqual([]);
		});

		test("with no OpenCode server, polls start no process for 10 s (a recent table will do)", async () => {
			await ps("none");
			expect(await opencodePending()).toEqual([]);
			rmSync(psLog, { force: true });
			try {
				setSystemTime(new Date(Date.now() + 5000));
				for (let i = 0; i < 10; i++)
					expect(await opencodePending()).toEqual([]);
				expect(existsSync(psLog)).toBe(false);
				// Older than that, it looks again.
				setSystemTime(new Date(Date.now() + 6000));
				await opencodePending();
				expect(existsSync(psLog)).toBe(true);
			} finally {
				setSystemTime();
			}
			expect(calls()).toEqual([]);
		});

		test("while the server runs, a table over 2 s old is not trusted (a stopped server is never restarted)", async () => {
			expect((await opencodePending()).length).toBeGreaterThan(0);
			// The server stops; the cached table still lists it.
			writeFileSync(psMode, "none");
			routes(GOOD);
			try {
				setSystemTime(new Date(Date.now() + 2500));
				expect(await opencodePending()).toEqual([]);
			} finally {
				setSystemTime();
			}
			expect(calls()).toEqual([]);
		});
	});

	test("no active sessions is no prompts", async () => {
		routes({ "session.active": { data: {} } });
		expect(await opencodePending()).toEqual([]);
	});
});

describe("opencodePending over the service's HTTP API", () => {
	/** A stand-in OpenCode service: the routes above, behind Basic auth. */
	async function service(password: string, onPrompt?: RequestListener) {
		// node:http, not Bun.serve: other test files replace the global Response.
		const server = createServer((req, res) => {
			const want = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
			const send = (status: number, body: string) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(body);
			};
			if (req.headers.authorization !== want)
				return send(401, '{"_tag":"UnauthorizedError"}');
			const path = new URL(req.url ?? "/", "http://x").pathname;
			if (req.method === "POST" && onPrompt) return onPrompt(req, res);
			const r = JSON.parse(readFileSync(routesFile, "utf8"));
			const key =
				path === "/api/session/active" ? "session.active" : `GET ${path}`;
			const out = key in r ? r[key] : {};
			if (out === "FAIL") return send(500, "");
			send(200, JSON.stringify(out));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as AddressInfo).port;
		mkdirSync(join(stateDir, "opencode"), { recursive: true });
		writeFileSync(
			join(stateDir, "opencode", "service.json"),
			JSON.stringify({
				url: `http://127.0.0.1:${port}`,
				pid: 99999,
				password: "pw",
			}),
		);
		return () => {
			server.close();
			server.closeAllConnections();
			rmSync(join(stateDir, "opencode"), { recursive: true, force: true });
		};
	}

	for (const reply of [
		"confirmed",
		"wrong session",
		"wrong prompt",
		"lost response",
		"server error",
	]) {
		test(`a submitted OpenCode prompt handles a ${reply} acknowledgement once`, async () => {
			let submitted = 0;
			const close = await service("pw", async (req, res) => {
				let body = "";
				for await (const chunk of req) body += chunk;
				const prompt = JSON.parse(body);
				submitted++;
				if (reply === "lost response") return req.socket.destroy();
				if (reply === "server error") {
					res.writeHead(500);
					return res.end();
				}
				res.end(
					JSON.stringify({
						data: {
							id: reply === "wrong prompt" ? "msg_other" : prompt.id,
							sessionID: reply === "wrong session" ? "ses_other" : "ses_test",
							type: "user",
						},
					}),
				);
			});
			try {
				const target = agentRecord({
					harness: "opencode",
					sessionId: "ses_test",
				});
				const result = await opencode.push!.deliver(
					target,
					"Read this",
					"urgent",
					"Operator",
				);
				expect(result.ok).toBe(reply === "confirmed");
				if (!result.ok) expect(result.uncertain).toBe(true);
				expect(submitted).toBe(1);
				expect(calls().filter((args) => args[1] === "POST")).toEqual([]);
			} finally {
				close();
			}
		});
	}

	test("reads from the service directly: same prompts, no `opencode` process", async () => {
		const stop = await service("pw");
		try {
			const got = await opencodePending();
			expect(got.map((p) => [p.key, p.kind, p.tool])).toEqual([
				["per_1", "permission", "bash"],
				["frm_1", "question", "question"],
			]);
			expect(calls()).toEqual([]);
		} finally {
			stop();
		}
	});

	test("when the service refuses (auth changed), the same reads go through `opencode api`", async () => {
		const stop = await service("other");
		try {
			const got = await opencodePending();
			expect(got.map((p) => p.key)).toEqual(["per_1", "frm_1"]);
			expect(calls().length).toBe(3);
		} finally {
			stop();
		}
	});

	test('unreadable both ways still throws (never "no prompts")', async () => {
		const stop = await service("pw");
		try {
			routes({ ...GOOD, "GET /api/session/ses_1/form": "FAIL" });
			await expect(opencodePending()).rejects.toThrow("opencode api failed");
		} finally {
			stop();
		}
	});
});

describe("opencodeReply (fake opencode on PATH)", () => {
	const perm: ServerPrompt = {
		key: "per_1",
		sessionId: "ses_1",
		kind: "permission",
		tool: "bash",
		input: {},
		prompt: null,
		sessionRules: ["bash: rm *"],
		data: { type: "permission", id: "per_1" },
	};
	const reply = (r: Partial<ServerReply>): ServerReply => ({
		decision: "deny",
		answer: null,
		note: null,
		...r,
	});
	const sent = () => {
		const c = calls();
		expect(c).toHaveLength(1);
		const [api, method, path, flag, body] = c[0]!;
		expect(api).toBe("api");
		return { method, path, flag, body: body ? JSON.parse(body) : undefined };
	};
	const REPLY = "/api/session/ses_1/permission/per_1/reply";

	for (const [decision, want] of [
		["allow-session", { decision: "always" }],
		["allow-once", { decision: "once" }],
		["deny", { decision: "reject", message: "Denied from the Pulsar app" }],
	] as const)
		test(`${decision} is sent as ${want.decision}`, async () => {
			expect(await opencodeReply(perm, reply({ decision }))).toBe(true);
			expect(sent()).toEqual({
				method: "POST",
				path: REPLY,
				flag: "-d",
				body: want,
			});
		});

	test("a deny carries the operator's note", async () => {
		await opencodeReply(perm, reply({ decision: "deny", note: "not now" }));
		expect(sent().body).toEqual({
			decision: "reject",
			message: "Denied from the Pulsar app: not now",
		});
	});

	test("a failed reply returns false", async () => {
		routes({ ...GOOD, [`POST ${REPLY}`]: "FAIL" });
		expect(await opencodeReply(perm, reply({ decision: "allow-once" }))).toBe(
			false,
		);
	});

	const form = async () =>
		(await opencodePending()).find((p) => p.key === "frm_1")!;

	test("a form answer is sent as values, not labels", async () => {
		const p = await form();
		routes(GOOD);
		const ok = await opencodeReply(
			p,
			reply({
				decision: "answer",
				answer: {
					kind: "question",
					answers: { q0: ["Green"], q1: ["Small", "Medium"] },
				},
			}),
		);
		expect(ok).toBe(true);
		expect(sent()).toEqual({
			method: "POST",
			path: "/api/session/ses_1/form/frm_1/reply",
			flag: "-d",
			body: { answer: { q0: "green", q1: ["S", "M"] } },
		});
	});

	test("a cancelled form is dismissed with DELETE", async () => {
		const p = await form();
		routes(GOOD);
		expect(await opencodeReply(p, reply({ decision: "deny" }))).toBe(true);
		const c = calls();
		expect(c).toEqual([
			[
				"api",
				"DELETE",
				`/api/session/ses_1/form/frm_1?message=${encodeURIComponent("The user declined to answer from the Pulsar app.")}`,
			],
		]);
	});
});
