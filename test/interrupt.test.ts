import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverFor } from "../src/harnesses/index.ts";
import type { HarnessDriver } from "../src/harnesses/types.ts";
import type { Agent } from "../src/types.ts";
import { restoreEnv, until } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "pulsar-interrupt-"));
const saved = {
	CODEX_HOME: process.env.CODEX_HOME,
	CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};

function agent(over: Partial<Agent>): Agent {
	return {
		id: "x",
		name: "x",
		harness: "codex",
		sessionId: "thread-1",
		pid: null,
		cwd: "/work",
		project: null,
		branch: null,
		tags: [],
		status: "busy",
		model: null,
		activity: null,
		inbound: "accept",
		registered: true,
		reach: "pull",
		lastSeen: 0,
		createdAt: 0,
		meta: {},
		...over,
	};
}

/**
 * A fake Codex app-server: WebSocket (RFC 6455) over a unix socket, JSON-RPC
 * inside text frames, like `codex app-server daemon`.
 */
const calls: Array<{ method: string; params: unknown }> = [];
let turnStatus = "inProgress";
let interruptError: string | null = null;
let server: Server;

function serverFrame(text: string): Buffer {
	const data = Buffer.from(text);
	const head =
		data.length < 126
			? Buffer.from([0x81, data.length])
			: Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]);
	return Buffer.concat([head, data]);
}

beforeAll(async () => {
	const home = join(dir, "codex");
	mkdirSync(join(home, "app-server-control"), { recursive: true });
	process.env.CODEX_HOME = home;
	server = createServer((sock) => {
		let buf = Buffer.alloc(0);
		let open = false;
		sock.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			if (!open) {
				const end = buf.indexOf("\r\n\r\n");
				if (end < 0) return;
				buf = buf.subarray(end + 4);
				open = true;
				sock.write(
					"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
				);
			}
			while (buf.length >= 6) {
				let n = buf[1]! & 0x7f;
				let off = 2;
				if (n === 126) {
					n = buf.readUInt16BE(2);
					off = 4;
				}
				if (buf.length < off + 4 + n) return;
				const mask = buf.subarray(off, off + 4);
				const body = Buffer.from(buf.subarray(off + 4, off + 4 + n));
				for (let i = 0; i < n; i++) body[i] = body[i]! ^ mask[i % 4]!;
				buf = buf.subarray(off + 4 + n);
				const msg = JSON.parse(body.toString()) as {
					id?: number;
					method: string;
					params?: unknown;
				};
				calls.push({ method: msg.method, params: msg.params });
				if (msg.id === undefined) continue;
				const reply = (o: object) =>
					sock.write(serverFrame(JSON.stringify({ id: msg.id, ...o })));
				// A notification first: the client must skip it.
				sock.write(
					serverFrame(
						JSON.stringify({ method: "remoteControl/status/changed" }),
					),
				);
				if (msg.method === "thread/turns/list")
					reply({ result: { data: [{ id: "turn-9", status: turnStatus }] } });
				else if (msg.method === "turn/interrupt" && interruptError)
					reply({ error: { code: -32600, message: interruptError } });
				else reply({ result: {} });
			}
		});
	});
	await new Promise<void>((r) =>
		server.listen(
			join(home, "app-server-control", "app-server-control.sock"),
			r,
		),
	);
});

afterAll(() => {
	server.close();
	restoreEnv("CODEX_HOME", saved.CODEX_HOME);
	restoreEnv("CLAUDE_CONFIG_DIR", saved.CLAUDE_CONFIG_DIR);
	rmSync(dir, { recursive: true, force: true });
});

describe("codex interrupt over the app-server socket", () => {
	const codex = driverFor("codex") as HarnessDriver;

	test("looks up the running turn, then interrupts it", async () => {
		calls.length = 0;
		turnStatus = "inProgress";
		// Seen in the background (canInterrupt runs per row and never blocks).
		await until(() => codex.canInterrupt!(agent({})));
		expect(await codex.interrupt!(agent({}))).toEqual({
			result: "interrupted",
			via: "codex-app-server",
		});
		expect(calls.map((c) => c.method)).toEqual([
			"initialize",
			"initialized",
			"thread/turns/list",
			"initialize",
			"initialized",
			"turn/interrupt",
		]);
		expect(calls.at(-1)!.params).toEqual({
			threadId: "thread-1",
			turnId: "turn-9",
		});
	});

	test("no turn in progress, or it ended in between: not-running", async () => {
		turnStatus = "completed";
		expect((await codex.interrupt!(agent({}))).result).toBe("not-running");
		turnStatus = "inProgress";
		interruptError = "no active turn to interrupt";
		expect((await codex.interrupt!(agent({}))).result).toBe("not-running");
		interruptError = "thread not found: thread-1";
		expect(await codex.interrupt!(agent({}))).toMatchObject({
			result: "unsupported",
			detail: "thread not found: thread-1",
		});
		interruptError = null;
	});

	test("no app-server socket: unsupported, and Stop is not offered", async () => {
		const prev = process.env.CODEX_HOME;
		process.env.CODEX_HOME = join(dir, "no-codex");
		try {
			expect(codex.canInterrupt!(agent({}))).toBe(false);
			expect((await codex.interrupt!(agent({}))).result).toBe("unsupported");
		} finally {
			process.env.CODEX_HOME = prev;
		}
	});
});

describe("claude interrupt (Esc into its tmux pane)", () => {
	const claude = driverFor("claude") as HarnessDriver;
	const config = join(dir, "claude");
	const record = (pid: number, rec: object) =>
		writeFileSync(
			join(config, "sessions", `${pid}.json`),
			JSON.stringify({ pid, ...rec }),
		);

	// Never the user's tmux: a private server folder, and a fake `tmux` first
	// on PATH that answers like tmux does for a pane that doesn't exist
	// (nothing, exit 0).
	const fakeBin = join(dir, "fake-bin");
	const saved = {
		PATH: process.env.PATH,
		TMUX: process.env.TMUX,
		TMUX_TMPDIR: process.env.TMUX_TMPDIR,
	};
	beforeAll(() => {
		mkdirSync(join(config, "sessions"), { recursive: true });
		process.env.CLAUDE_CONFIG_DIR = config;
		mkdirSync(fakeBin, { recursive: true });
		writeFileSync(join(fakeBin, "tmux"), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
		process.env.PATH = `${fakeBin}:${saved.PATH ?? "/usr/bin:/bin"}`;
		process.env.TMUX_TMPDIR = join(dir, "tmux");
		delete process.env.TMUX;
	});
	afterAll(() => {
		for (const [k, v] of Object.entries(saved))
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
	});

	test("outside tmux: unsupported, and Stop is not offered", async () => {
		record(910001, { status: "busy" });
		const a = agent({ harness: "claude", pid: 910001 });
		expect(claude.canInterrupt!(a)).toBe(false);
		expect(await claude.interrupt!(a)).toMatchObject({
			result: "unsupported",
			via: "tmux-escape",
		});
	});

	test("in tmux but idle: not-running, no key sent", async () => {
		record(910002, { status: "idle", tmux: "work:@3.%17" });
		const a = agent({ harness: "claude", pid: 910002 });
		// The record is read in the background (the scan normally keeps it).
		await until(() => claude.canInterrupt!(a));
		expect((await claude.interrupt!(a)).result).toBe("not-running");
	});

	test("a pane that is not this session's process is refused", async () => {
		// %999999 does not exist (or is not this pid): never send the key.
		record(910003, { status: "busy", tmux: "work:@3.%999999" });
		const a = agent({ harness: "claude", pid: 910003 });
		expect(await claude.interrupt!(a)).toMatchObject({
			result: "unsupported",
			detail: "no tmux pane %999999",
		});
	});
});

describe("pi/omp interrupt through the pulsar extension", () => {
	test("the extension aborts a running turn and reports idle as not-running", async () => {
		const { startDaemon } = await import("./helpers.ts");
		const { default: pulsarExtension } = await import("../src/extension.ts");
		const { daemon, cleanup } = await startDaemon();
		// biome-ignore lint/suspicious/noExplicitAny: a fake host
		const handlers = new Map<string, Array<(e: unknown, c: any) => unknown>>();
		let idle = false;
		let aborted = 0;
		const ctx = {
			isIdle: () => idle,
			abort: () => {
				aborted++;
			},
		};
		pulsarExtension({
			on: (event, fn) => {
				handlers.set(event, [...(handlers.get(event) ?? []), fn]);
			},
			sendMessage: () => {},
		});
		const fire = async (event: string) => {
			for (const fn of handlers.get(event) ?? []) await fn({}, ctx);
		};
		try {
			await fire("session_start");
			await fire("agent_start");
			const { until } = await import("./helpers.ts");
			let id = "";
			await until(() => {
				const ext = daemon.service.registry
					.live()
					.find((a) => a.pid === process.pid);
				id = ext?.id ?? "";
				return Boolean(ext && daemon.service.interrupts.can(ext));
			});
			const operator = { kind: "terminal" } as const;
			expect(await daemon.service.stopAgent(operator, id)).toEqual({
				agentId: id,
				result: "interrupted",
				via: "extension",
			});
			expect(aborted).toBe(1);
			idle = true;
			expect((await daemon.service.stopAgent(operator, id)).result).toBe(
				"not-running",
			);
			expect(aborted).toBe(1);
		} finally {
			await fire("session_shutdown").catch(() => {});
			for (const fn of handlers.get("session_shutdown") ?? [])
				await fn({ reason: "quit" }, ctx);
			await daemon.stop();
			cleanup();
		}
	});
});

describe("stopAgent is the one entry point", () => {
	for (const harness of ["opencode", "codex"]) {
		test(`${harness} stops only the confirmed child session, including when this node has peers`, async () => {
			const { Store } = await import("../src/store.ts");
			const { PulsarService } = await import("../src/service/index.ts");
			const store = new Store(":memory:");
			const service = new PulsarService({ store, scan: false, machine: "t" });
			const driver = driverFor(harness)!;
			const saved = {
				canInterrupt: driver.canInterrupt,
				interrupt: driver.interrupt,
			};
			const sent: string[] = [];
			try {
				const parent = service.registry.upsert({
					harness,
					sessionId: "session-parent",
					pid: 4242,
					cwd: null,
					project: null,
					branch: null,
					tags: [],
					meta: {},
					registered: false,
				});
				const child = agent({
					harness,
					id: `${parent.id}/sub:child`,
					pid: parent.pid,
					sessionId: "session-child",
					meta: { subagentOf: parent.id, subagentNative: "1" },
				});
				service.registry.discoveredSubagent = (id) =>
					id === child.id ? child : undefined;
				service.registry.pool = {
					stopAgent() {
						throw new Error("local Stop reached a peer");
					},
					stopOptions() {
						throw new Error("local options reached a peer");
					},
				} as unknown as NonNullable<typeof service.registry.pool>;
				driver.canInterrupt = () => true;
				driver.interrupt = async (target) => {
					sent.push(target.sessionId!);
					return { result: "interrupted", via: harness };
				};
				const operator = { kind: "terminal" } as const;
				expect(service.registry.view(child).capabilities?.stop).toBe(true);
				expect((await service.stopAgent(operator, child.id)).result).toBe(
					"interrupted",
				);
				await expect(
					service.stopOptions(operator, child.id),
				).rejects.toMatchObject({ code: "bad_request" });
				child.sessionId = parent.sessionId;
				expect(service.registry.view(child).capabilities?.stop).toBe(false);
				expect((await service.stopAgent(operator, child.id)).result).toBe(
					"unsupported",
				);
				child.sessionId = "session-child";
				child.meta.subagentPull = "inbox";
				expect(service.registry.view(child).capabilities?.stop).toBe(false);
				expect((await service.stopAgent(operator, child.id)).result).toBe(
					"unsupported",
				);
				expect(sent).toEqual(["session-child"]);
			} finally {
				Object.assign(driver, saved);
				service.registry.pool = null;
				service.stop();
				store.close();
			}
		});
	}
	test("it authorizes itself: an agent may not stop another", async () => {
		const { Store } = await import("../src/store.ts");
		const { PulsarService } = await import("../src/service/index.ts");
		const store = new Store(":memory:");
		const service = new PulsarService({ store, scan: false, machine: "t" });
		const other = service.registry.upsert({
			harness: "pi",
			sessionId: "s-other",
			pid: null,
			cwd: null,
			project: null,
			branch: null,
			tags: [],
			meta: {},
			registered: false,
		});
		await expect(
			service.stopAgent({ kind: "agent", agentId: "pi:s-me" }, other.id),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(
			service.stopAgent({ kind: "peer", machineId: "m2", node: "b" }, other.id),
		).rejects.toMatchObject({ code: "forbidden" });
		expect(
			(await service.stopAgent({ kind: "terminal" }, other.id)).result,
		).toBe("unsupported");
		service.stop();
		store.close();
	});
});

describe("claude transcript paths", () => {
	test("a session id with path parts never reaches the filesystem", async () => {
		const { isClaudeSessionId } = await import("../src/harnesses/claude.ts");
		const config = join(dir, "claude-paths");
		const project = join(config, "projects", "-work-demo");
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, "0000aaaa-1111-4222-8333-444455556666.jsonl"),
			"",
		);
		// A file a crafted id could point at, outside the project folder.
		writeFileSync(join(config, "secret.jsonl"), "");
		const prev = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = config;
		try {
			const claude = driverFor("claude") as HarnessDriver;
			const locate = (sessionId: string) =>
				claude.transcript!.locate(
					agent({ harness: "claude", cwd: "/work/demo", sessionId }),
				);
			expect(
				await locate("0000aaaa-1111-4222-8333-444455556666"),
			).toMatchObject({
				kind: "file",
			});
			expect(await locate("../../secret")).toBeNull();
			expect(await locate("../secret")).toBeNull();
			for (const bad of ["../x", "a/b", "a\\b", "..", "", "x".repeat(129)])
				expect(isClaudeSessionId(bad)).toBe(false);
		} finally {
			process.env.CLAUDE_CONFIG_DIR = prev;
		}
	});
});
