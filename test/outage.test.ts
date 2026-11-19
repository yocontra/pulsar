import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RETIRED } from "../src/service/sessions.ts";
import { MAX_CONNECTIONS } from "../src/transport/socket.ts";
import { builtCli } from "./helpers.ts";

/**
 * The 2.0 outage (a 1.x extension opening a connection per retry, never
 * closing the old ones, until the daemon starved): a real daemon from the
 * built CLI, in a temp HOME and state folder with scanners off.
 */
const node = execFileSync("node", ["-p", "process.execPath"], {
	encoding: "utf8",
}).trim();
const children: ChildProcess[] = [];
const dirs: string[] = [];
const open: Socket[] = [];

afterAll(() => {
	for (const s of open) s.destroy();
	for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function daemon() {
	const dir = mkdtempSync(join(tmpdir(), "pulsar-out-"));
	dirs.push(dir);
	const state = join(dir, "state");
	mkdirSync(join(dir, "home"));
	mkdirSync(state, { mode: 0o700 });
	const child = spawn(node, [builtCli(), "daemon"], {
		env: {
			PATH: "/usr/bin:/bin",
			HOME: join(dir, "home"),
			PULSAR_HOME: state,
			PULSAR_INSTALL_ROOT: join(dir, "install"),
			PULSAR_NO_MESH: "1",
			PULSAR_NO_SCAN: "1",
		},
		stdio: "ignore",
	});
	children.push(child);
	const sock = join(state, "bus.sock");
	for (let i = 0; i < 100; i++) {
		if ((await rpc(sock, "status", {}).catch(() => null)) !== null) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	return sock;
}

/** One raw connection, kept open (as the 1.x client did). */
function raw(path: string): Promise<{
	socket: Socket;
	call: (method: string, params: unknown) => Promise<Record<string, unknown>>;
	closed: Promise<void>;
}> {
	return new Promise((resolve, reject) => {
		const socket = connect(path);
		open.push(socket);
		let buf = "";
		let next = 1;
		const waiting = new Map<number, (f: Record<string, unknown>) => void>();
		socket.setEncoding("utf8");
		socket.on("data", (d: string) => {
			buf += d;
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const f = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
				buf = buf.slice(nl + 1);
				const w = waiting.get(f.id as number);
				if (w) {
					waiting.delete(f.id as number);
					w(f);
				}
				nl = buf.indexOf("\n");
			}
		});
		const closed = new Promise<void>((r) => socket.once("close", () => r()));
		socket.on("error", () => {});
		socket.once("connect", () =>
			resolve({
				socket,
				closed,
				call: (method, params) =>
					new Promise((res) => {
						const id = next++;
						waiting.set(id, res);
						socket.write(`${JSON.stringify({ id, method, params })}\n`);
					}),
			}),
		);
		socket.once("error", reject);
	});
}

/** A one-shot request on a fresh connection, closed after. */
async function rpc(path: string, method: string, params: unknown) {
	const c = await raw(path);
	try {
		return await c.call(method, params);
	} finally {
		c.socket.destroy();
	}
}

const helloAs = (
	pid: number,
	sessionId = "omp-session-1",
	role: "extension" | "mcp" = "extension",
) => ({
	protocol: 1,
	version: "1.4.0",
	registration: {
		harness: "omp",
		sessionId,
		pid,
		cwd: "/tmp/work",
		project: "work",
		branch: "main",
		tags: [],
		role,
	},
});
const helloAsOldExtension = (pid: number) => helloAs(pid);

describe("a client that leaks connections can't take the daemon down", () => {
	test("a 1.x extension reconnecting 300 times without closing: bounded, and others still connect", async () => {
		const sock = await daemon();
		const pid = 424242;
		// The agent's MCP server (same claimed pid) must survive the churn.
		const mcp = await raw(sock);
		expect(
			(await mcp.call("hello", helloAs(pid, "omp-session-1", "mcp"))).error,
		).toBeUndefined();
		const conns = [];
		for (let i = 0; i < 300; i++) {
			const c = await raw(sock);
			const r = await c.call("hello", helloAsOldExtension(pid));
			// Never refused: a refusal makes such a client retry harder.
			expect(r.error).toBeUndefined();
			conns.push(c);
		}
		// Its replaced connections past the cap were closed: the newest
		// extension plus at most MAX_RETIRED old ones stay open.
		await new Promise((r) => setTimeout(r, 300));
		const stillOpen = conns.filter((c) => !c.socket.destroyed).length;
		expect(stillOpen).toBeLessThanOrEqual(1 + MAX_RETIRED);
		expect(conns.at(-1)!.socket.destroyed).toBe(false);
		expect(mcp.socket.destroyed).toBe(false);
		// The daemon answers anyone else at once.
		const t0 = Date.now();
		const status = await rpc(sock, "status", {});
		expect(status.result).toBeTruthy();
		expect(Date.now() - t0).toBeLessThan(1000);
		// The agent is still one agent, with one extension that can push.
		const ls = (await rpc(sock, "list", { selector: "*" })) as {
			result: { id: string }[] | { agents: { id: string }[] };
		};
		const agents = Array.isArray(ls.result) ? ls.result : ls.result.agents;
		expect(agents.filter((a) => a.id.includes("omp-session-1"))).toHaveLength(
			1,
		);
	}, 60_000);

	test("many sessions in one process (one claimed pid) all stay connected", async () => {
		const sock = await daemon();
		const conns = [];
		for (let i = 0; i < 40; i++) {
			const c = await raw(sock);
			const r = await c.call("hello", helloAs(777, `thread-${i}`));
			expect(r.error).toBeUndefined();
			conns.push(c);
		}
		await new Promise((r) => setTimeout(r, 300));
		expect(conns.filter((c) => c.socket.destroyed)).toHaveLength(0);
	}, 60_000);

	test("a refused hello's connection is closed by the daemon", async () => {
		const sock = await daemon();
		const c = await raw(sock);
		const r = await c.call("hello", { protocol: 999 });
		expect((r.error as { code: string }).code).toBe("protocol_too_new");
		const closed = await Promise.race([
			c.closed.then(() => true),
			new Promise((r) => setTimeout(() => r(false), 2000)),
		]);
		expect(closed).toBe(true);
	}, 30_000);

	test("past the total cap, new connections get a clear error; closing frees them", async () => {
		const sock = await daemon();
		const held = [];
		for (let i = 0; i < MAX_CONNECTIONS; i++) {
			const c = await raw(sock);
			held.push(c);
			// Pace to the daemon's accepts (macOS caps the backlog at 128): an
			// answer on this connection means every earlier one was accepted.
			if (i % 64 === 63) await c.call("status", {});
		}
		const over = await raw(sock);
		const r = await over.call("status", {});
		expect((r.error as { code: string }).code).toBe("too_many_connections");
		for (const c of held) c.socket.destroy();
		await new Promise((r) => setTimeout(r, 300));
		expect((await rpc(sock, "status", {})).result).toBeTruthy();
	}, 60_000);
});

describe("clients don't start daemons in a burst", () => {
	test("maySpawn: once per gap across clients, never while a live daemon holds the lock", async () => {
		const { maySpawn, SPAWN_GAP_MS } = await import("../src/client.ts");
		const { processStart } = await import("../src/processes.ts");
		const { writeFileSync, rmSync: rm } = await import("node:fs");
		const dir = mkdtempSync(join(tmpdir(), "pulsar-spawn-"));
		dirs.push(dir);
		const sock = join(dir, "bus.sock");
		const t = Date.now() + 10 * SPAWN_GAP_MS;
		// A live daemon holds the lock (busy, not accepting): don't start another.
		writeFileSync(
			`${sock}.lock`,
			`${process.ppid}\n${(await processStart(process.ppid)) ?? ""}\n`,
		);
		expect(await maySpawn(sock, t)).toBe(false);
		rm(`${sock}.lock`);
		// Another client started one a moment ago (the stamp is fresh).
		writeFileSync(`${sock}.spawn`, "");
		expect(await maySpawn(sock, Date.now())).toBe(false);
		// Later, one start; then this client waits out the gap.
		expect(await maySpawn(sock, t)).toBe(true);
		expect(await maySpawn(sock, t + 10)).toBe(false);
	});
});
