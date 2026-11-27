/**
 * OpenCode's scanner: running sessions from the shared service, idle TUI
 * sessions found by folder, and `opencode api` run from the service's own
 * executable (the daemon's PATH may find an old `opencode` with no `api`).
 * Fake `ps`, `lsof` and service: never the operator's OpenCode.
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	opencode,
	opencodeTuis,
	scanOpencode,
} from "../src/harnesses/opencode.ts";
import { opencodeBin } from "../src/harnesses/opencode-api.ts";
import { processSnapshot } from "../src/processes.ts";
import { restoreEnv } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "pulsar-ocscan-"));
const bin = join(dir, "bin");
const serviceBin = join(dir, "service-bin");
const stateDir = join(dir, "state");
mkdirSync(bin);
mkdirSync(serviceBin);
const saved = { PATH: process.env.PATH, XDG: process.env.XDG_STATE_HOME };

function stub(path: string, body: string) {
	writeFileSync(path, body);
	chmodSync(path, 0o755);
}

const SERVICE_PID = 99_901;
const TUI_IDLE = 99_902;
const TUI_BUSY = 99_903;
const TUI_STANDALONE = 99_904;
const RUN = 99_905;
const SERVICE_EXE = join(serviceBin, "opencode");

stub(
	join(bin, "ps"),
	`#!/bin/sh
echo "${SERVICE_PID} ${TUI_IDLE} ${SERVICE_EXE} serve --service"
echo "${TUI_IDLE} 1 opencode --session ses_old"
echo "${TUI_BUSY} 1 /usr/local/bin/opencode /work/busy"
echo "${TUI_STANDALONE} 1 opencode --standalone"
echo "${RUN} 1 opencode run hi"
`,
);
stub(
	join(bin, "lsof"),
	`#!/bin/sh
echo "p${TUI_IDLE}"; echo "fcwd"; echo "n/work/idle"
echo "p${TUI_BUSY}"; echo "fcwd"; echo "n/work/busy"
`,
);
// An OpenCode first on PATH with no `api` command; its `--version` says
// what the file `path-version` holds (nothing: it prints a banner).
const pathVersion = join(dir, "path-version");
stub(
	join(bin, "opencode"),
	`#!/bin/sh\ncat "${pathVersion}" 2>/dev/null || echo "banner"\nexit 0\n`,
);

const SESSIONS: Record<string, unknown> = {
	ses_old: { id: "ses_old", location: { directory: "/work/idle" } },
	ses_busy: {
		id: "ses_busy",
		title: "busy one",
		model: { id: "m1" },
		location: { directory: "/work/busy" },
	},
	ses_kid: { id: "ses_kid", parentID: "ses_busy" },
};
const LISTS: Record<string, unknown[]> = {
	"/work/idle": [
		{
			id: "ses_old",
			time: { updated: 1000 },
			location: { directory: "/work/idle" },
		},
		{
			id: "ses_new",
			title: "the open one",
			time: { updated: 5000 },
			location: { directory: "/work/idle" },
		},
		{
			id: "ses_child",
			parentID: "ses_new",
			time: { updated: 9000 },
			location: { directory: "/work/idle" },
		},
	],
};
const ACTIVE = { ses_busy: { type: "running" }, ses_kid: { type: "running" } };

/** What the service answers for a path; used by the HTTP stub and the CLI stub. */
function answer(path: string, prompt?: { id: string }): unknown {
	const url = new URL(path, "http://x");
	if (url.pathname === "/api/session/active") return { data: ACTIVE };
	if (url.pathname === "/api/session")
		return { data: LISTS[url.searchParams.get("directory") ?? ""] ?? [] };
	const id = url.pathname.split("/")[3] ?? "";
	if (prompt && url.pathname.endsWith("/prompt"))
		return { data: { id: prompt.id, sessionID: id, type: "user" } };
	return { data: SESSIONS[id] ?? null };
}

const cliLog = join(dir, "cli.jsonl");
stub(
	SERVICE_EXE,
	`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(cliLog)}, JSON.stringify(args) + "\\n");
const answer = ${answer.toString()};
const ACTIVE = ${JSON.stringify(ACTIVE)}, SESSIONS = ${JSON.stringify(SESSIONS)}, LISTS = ${JSON.stringify(LISTS)};
const prompt = args[1] === "POST" ? JSON.parse(args[4]) : undefined;
process.stdout.write(JSON.stringify(answer(args[2], prompt)));
`,
);

let server: Server;
const posts: Array<{ path: string; body: unknown }> = [];
let postStatus = 200;
let password = "pw";
let httpHits = 0;

beforeAll(async () => {
	process.env.PATH = `${bin}:${saved.PATH}`;
	process.env.XDG_STATE_HOME = stateDir;
	server = createServer((req, res) => {
		httpHits++;
		const want = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
		res.setHeader("content-type", "application/json");
		if (req.headers.authorization !== want) {
			res.writeHead(401);
			return res.end("{}");
		}
		if (req.method === "POST") {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				const path = req.url ?? "";
				const prompt = JSON.parse(body);
				posts.push({ path, body: prompt });
				res.writeHead(postStatus);
				res.end(
					postStatus === 200 ? JSON.stringify(answer(path, prompt)) : "{}",
				);
			});
			return;
		}
		res.end(JSON.stringify(answer(req.url ?? "/")));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	mkdirSync(join(stateDir, "opencode"), { recursive: true });
	writeFileSync(
		join(stateDir, "opencode", "service.json"),
		JSON.stringify({
			url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			password: "pw",
			pid: SERVICE_PID,
		}),
	);
	await processSnapshot(0);
	await processSnapshot(0);
});

afterAll(async () => {
	server.close();
	server.closeAllConnections();
	restoreEnv("PATH", saved.PATH);
	restoreEnv("XDG_STATE_HOME", saved.XDG);
	await processSnapshot(0);
	await processSnapshot(0);
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	password = "pw";
	postStatus = 200;
	posts.length = 0;
	httpHits = 0;
	rmSync(cliLog, { force: true });
});

const byId = (rows: Awaited<ReturnType<typeof scanOpencode>>) =>
	Object.fromEntries(rows.map((r) => [r.sessionId, r]));

describe("OpenCode scan", () => {
	test("TUIs: only interactive ones on the shared service", async () => {
		const tuis = opencodeTuis(await processSnapshot(0));
		expect(tuis.map((t) => t.pid).sort()).toEqual([TUI_IDLE, TUI_BUSY]);
	});

	test("running sessions are busy; an idle TUI shows its folder's newest session, idle", async () => {
		const rows = byId(await scanOpencode());
		expect(Object.keys(rows).sort()).toEqual(["ses_busy", "ses_new"]);
		expect(rows.ses_busy).toMatchObject({
			status: "busy",
			cwd: "/work/busy",
			model: "m1",
			pid: null,
		});
		expect(rows.ses_new).toMatchObject({
			status: "idle",
			cwd: "/work/idle",
			pid: null,
			meta: {
				title: "the open one",
				tuiPid: String(TUI_IDLE),
				sessionFrom: "folder",
			},
		});
		// Straight from the service: no `opencode` process.
		expect(httpHits).toBeGreaterThan(0);
		expect(existsSync(cliLog)).toBe(false);
	});

	test("a resumed TUI must name the same session as its sole workspace tab", async () => {
		const path = join(stateDir, "opencode/latest/tui");
		mkdirSync(path, { recursive: true });
		const file = join(path, "tabs.json");
		const setTabs = (ids: string[]) =>
			writeFileSync(
				file,
				JSON.stringify({
					global: { tabs: [] },
					cwd: {
						"/work/idle": { tabs: ids.map((sessionID) => ({ sessionID })) },
					},
				}),
			);
		try {
			setTabs(["ses_old"]);
			const selected = byId(await scanOpencode());
			expect(selected.ses_old).toMatchObject({
				pid: null,
				meta: { sessionFrom: "tab", tuiPid: String(TUI_IDLE) },
			});
			expect(selected.ses_new).toBeUndefined();
			for (const tabs of [["ses_old", "ses_new"], ["ses_new"]]) {
				setTabs(tabs);
				const ambiguous = byId(await scanOpencode());
				expect(ambiguous.ses_old).toBeUndefined();
				expect(ambiguous.ses_new?.meta.sessionFrom).toBe("folder");
			}
		} finally {
			rmSync(file, { force: true });
		}
	});

	test("when HTTP is refused, `opencode api` runs from the service's executable, not PATH's", async () => {
		password = "changed";
		expect(await opencodeBin(await processSnapshot(0), SERVICE_PID)).toBe(
			SERVICE_EXE,
		);
		const rows = byId(await scanOpencode());
		expect(Object.keys(rows).sort()).toEqual(["ses_busy", "ses_new"]);
		const calls = readFileSync(cliLog, "utf8").trim().split("\n");
		expect(calls.length).toBeGreaterThan(0);
		expect(JSON.parse(calls[0]!)).toEqual([
			"api",
			"GET",
			"/api/session/active",
		]);
	});

	test("an unknown or unrelated service pid falls back to PATH", async () => {
		const table = await processSnapshot(0);
		expect(await opencodeBin(table, null)).toBe("opencode");
		expect(await opencodeBin(table, TUI_IDLE)).toBe("opencode");
	});

	test("an unreadable session list throws (never 'no sessions')", async () => {
		password = "changed";
		// PATH's old opencode only: the service's executable is not known.
		const file = join(stateDir, "opencode", "service.json");
		const keep = readFileSync(file, "utf8");
		writeFileSync(file, "{}");
		try {
			await expect(scanOpencode()).rejects.toThrow("unreadable");
		} finally {
			writeFileSync(file, keep);
		}
	});
});

describe("OpenCode push over the service's HTTP API", () => {
	const agent = {
		id: "opencode:ses_busy",
		harness: "opencode",
		sessionId: "ses_busy",
	} as Parameters<NonNullable<typeof opencode.push>["deliver"]>[0];

	test("a message is one POST to the service, no `opencode` process", async () => {
		const r = await opencode.push!.deliver(agent, "hello", "urgent", "x");
		expect(r).toEqual({ ok: true, via: "opencode-api" });
		expect(posts).toEqual([
			{
				path: "/api/session/ses_busy/prompt",
				body: {
					id: expect.stringMatching(/^msg_pulsar_/),
					text: "hello",
					delivery: "steer",
					resume: true,
				},
			},
		]);
		expect(existsSync(cliLog)).toBe(false);
	});

	test("a 5xx is not sent again through the CLI (it may have landed)", async () => {
		postStatus = 500;
		const r = await opencode.push!.deliver(agent, "once", "normal", "x");
		expect(r).toMatchObject({ ok: false, uncertain: true });
		expect(posts).toHaveLength(1);
		expect(existsSync(cliLog)).toBe(false);
	});

	test("refused unread (auth changed): sent through the service's CLI instead", async () => {
		password = "changed";
		const r = await opencode.push!.deliver(agent, "via cli", "normal", "x");
		expect(r.ok).toBe(true);
		expect(posts).toHaveLength(0);
		const lines = readFileSync(cliLog, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const call = JSON.parse(lines[0]!);
		expect(JSON.parse(call[4])).toMatchObject({
			id: expect.stringMatching(/^msg_pulsar_/),
			text: "via cli",
			delivery: "queue",
			resume: true,
		});
		expect(call.slice(0, 3)).toEqual([
			"api",
			"POST",
			"/api/session/ses_busy/prompt",
		]);
	});
});

describe("which `opencode` runs `opencode api` without the service's pid", () => {
	test("PATH's 1.x is skipped for OpenCode's installer copy; 2.x on PATH is used", async () => {
		const home = join(dir, "home");
		const installed = join(home, ".opencode", "bin", "opencode");
		mkdirSync(join(home, ".opencode", "bin"), { recursive: true });
		stub(installed, "#!/bin/sh\necho 2.2.5\n");
		const savedHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const table = await processSnapshot(0);
			// The version cache keys on the executable's mtime: touch it per change.
			const touch = (s: number) => {
				const t = new Date(Date.now() + s * 1000);
				utimesSync(join(bin, "opencode"), t, t);
			};
			writeFileSync(pathVersion, "1.19.6\n");
			touch(5);
			expect(await opencodeBin(table, null)).toBe(installed);
			writeFileSync(pathVersion, "opencode v2.3.0\n");
			touch(10);
			expect(await opencodeBin(table, null)).toBe("opencode");
		} finally {
			restoreEnv("HOME", savedHome);
			rmSync(pathVersion, { force: true });
		}
	});
});
