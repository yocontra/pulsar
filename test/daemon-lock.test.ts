import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonLock } from "../src/daemon-lock.ts";
import { processStart } from "../src/processes.ts";
import { builtCli } from "./helpers.ts";

/**
 * Exactly one daemon per state folder: concurrent starts leave one, and a
 * daemon whose lock or socket another daemon took exits instead of running
 * on unseen. Real processes from the built CLI, in a temp HOME and state
 * folder with scanners off.
 */
const node = execFileSync("node", ["-p", "process.execPath"], {
	encoding: "utf8",
}).trim();
const children: ChildProcess[] = [];
const dirs: string[] = [];

afterAll(() => {
	for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sandbox() {
	const dir = mkdtempSync(join(tmpdir(), "pulsar-lock-"));
	dirs.push(dir);
	const home = join(dir, "home");
	const state = join(dir, "state");
	mkdirSync(home);
	mkdirSync(state, { mode: 0o700 });
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: home,
		PULSAR_HOME: state,
		PULSAR_INSTALL_ROOT: join(dir, "install"),
		PULSAR_NO_MESH: "1",
		PULSAR_NO_SCAN: "1",
	};
	return { state, env };
}

function startDaemon(env: Record<string, string>) {
	const cli = builtCli();
	const child = spawn(node, [cli, "daemon"], { env, stdio: "ignore" });
	children.push(child);
	const exited = new Promise<number | null>((r) => child.once("exit", r));
	return { child, exited };
}

const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

async function until(check: () => boolean | Promise<boolean>, ms: number) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return check();
}

/** Waits until the socket answers with `pid` (a loaded machine starts node slowly). */
async function answers(state: string, pid: number, ms = 30_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if ((await socketPid(state)) === pid) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

/** The `status` pid the socket answers with. */
function socketPid(state: string): Promise<number | null> {
	return new Promise((resolve) => {
		const s = connect(join(state, "bus.sock"));
		let buf = "";
		s.setEncoding("utf8");
		s.on("error", () => resolve(null));
		s.on("data", (d: string) => {
			buf += d;
			const line = buf.split("\n").find((l) => l.includes('"id":2'));
			if (!line) return;
			s.destroy();
			resolve((JSON.parse(line) as { result: { pid: number } }).result.pid);
		});
		s.on("connect", () => {
			s.write(
				`${JSON.stringify({ id: 1, method: "hello", params: { protocol: 1, registration: { role: "cli" } } })}\n`,
			);
			s.write(`${JSON.stringify({ id: 2, method: "status" })}\n`);
		});
		setTimeout(() => resolve(null), 3000);
	});
}

describe("one daemon per state folder", () => {
	test("six concurrent starts leave exactly one daemon; the rest exit", async () => {
		const { state, env } = sandbox();
		const runs = Array.from({ length: 6 }, () => startDaemon(env));
		// Losers exit once they see the lock; no fixed waits: on a loaded
		// machine six node starts take as long as they take.
		await until(() => runs.filter((r) => alive(r.child)).length <= 1, 40_000);
		const left = runs.filter((r) => alive(r.child));
		expect(left).toHaveLength(1);
		const winner = left[0]!.child.pid!;
		expect(await answers(state, winner)).toBe(true);
		for (const r of runs.filter((r) => r.child.pid !== winner))
			expect(await r.exited).toBe(0);
		expect(await new DaemonLock(join(state, "bus.sock")).holder()).toBe(winner);
		left[0]!.child.kill("SIGTERM");
		expect(await left[0]!.exited).toBe(0);
	}, 90_000);

	test("a daemon whose lock and socket another daemon took exits", async () => {
		const { state, env } = sandbox();
		const a = startDaemon(env);
		expect(await answers(state, a.child.pid!)).toBe(true);
		// Someone removes A's files and a second daemon starts and binds.
		unlinkSync(join(state, "bus.sock.lock"));
		unlinkSync(join(state, "bus.sock"));
		const b = startDaemon(env);
		await until(
			async () =>
				((await new DaemonLock(join(state, "bus.sock")).holder()) ?? 0) ===
				b.child.pid,
			30_000,
		);
		// A notices within its check interval (2 s, longer when the machine is
		// slow) and exits; B keeps serving.
		expect(
			await Promise.race([
				a.exited,
				new Promise((r) => setTimeout(() => r("still running"), 30_000)),
			]),
		).toBe(0);
		expect(alive(b.child)).toBe(true);
		expect(await answers(state, b.child.pid!)).toBe(true);
		b.child.kill("SIGTERM");
		await b.exited;
	}, 90_000);

	test("a lock left by a dead process is taken; a live holder's is not", async () => {
		const { state } = sandbox();
		const path = join(state, "bus.sock");
		writeFileSync(`${path}.lock`, "999999\n");
		const lock = new DaemonLock(path);
		expect(await lock.acquire()).toBe(true);
		expect(await lock.holder()).toBe(process.pid);
		// Held by another live process (the test runner's parent): refused.
		const other = new DaemonLock(path);
		writeFileSync(
			`${path}.lock`,
			`${process.ppid}\n${(await processStart(process.ppid)) ?? ""}\n`,
		);
		expect(await other.acquire()).toBe(false);
		// A lock from before start times were kept (pid only): refused too.
		writeFileSync(`${path}.lock`, `${process.ppid}\n`);
		expect(await other.acquire()).toBe(false);
		await lock.release();
	});

	test("a stale lock replaced by another starter while ps ran is not removed", async () => {
		const { state } = sandbox();
		const path = join(state, "bus.sock");
		writeFileSync(`${path}.lock`, "999999\n");
		const winner = `${process.ppid}\n${(await processStart(process.ppid)) ?? ""}\n`;
		const lock = new DaemonLock(path);
		const self = lock as unknown as {
			live: (h: { pid: number; start: string | null }) => Promise<boolean>;
		};
		const realLive = self.live.bind(lock);
		self.live = async (held) => {
			// While this starter's `ps` runs, another removes the stale lock and takes it.
			if (held.pid === 999999) writeFileSync(`${path}.lock`, winner);
			return realLive(held);
		};
		expect(await lock.acquire()).toBe(false);
		expect(readFileSync(`${path}.lock`, "utf8")).toBe(winner);
	});

	test("a live holder's start time reads the same under any TZ or locale", async () => {
		const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
		try {
			process.env.TZ = "America/Denver";
			process.env.LC_ALL = "fr_FR.UTF-8";
			const a = await processStart(process.ppid);
			process.env.TZ = "UTC";
			process.env.LC_ALL = "C";
			expect(await processStart(process.ppid)).toBe(a);
			expect(a).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} /);
		} finally {
			for (const [k, v] of Object.entries(saved))
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
		}
	});

	test("a stale lock whose pid now names another process is taken (pid reuse after a reboot)", async () => {
		const { state } = sandbox();
		const path = join(state, "bus.sock");
		// A live pid, but not the process that took the lock: it started at another time.
		writeFileSync(
			`${path}.lock`,
			`${process.ppid}\nThu Jan  1 00:00:00 1970\n`,
		);
		const lock = new DaemonLock(path);
		expect(await lock.acquire()).toBe(true);
		expect(readFileSync(`${path}.lock`, "utf8").split("\n")[1]).toBe(
			(await processStart(process.pid)) ?? "",
		);
		await lock.release();
	});
});
