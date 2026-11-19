import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	type ChildProcess,
	execFileSync,
	spawn,
	spawnSync,
} from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtCli } from "./helpers.ts";

/**
 * The on-demand daemon and the always-on service never run side by side.
 * Runs the built CLI with a temp state folder, a fake HOME and stub
 * `launchctl`/`systemctl` scripts first on PATH, so nothing reaches the real
 * service manager.
 */
const root = join(import.meta.dir, "..");
const cli = join(root, "dist", "cli.js");
const node = execFileSync("node", ["-p", "process.execPath"], {
	encoding: "utf8",
}).trim();
const uid = process.getuid?.() ?? 0;
const children: ChildProcess[] = [];

beforeAll(() => {
	// Never test an old build (a checkout that moved since the last build).
	builtCli();
});

afterEach(() => {
	for (const c of children.splice(0)) c.kill("SIGKILL");
});

function sandbox(stubExit = 0) {
	const dir = mkdtempSync(join(tmpdir(), "pulsar-handoff-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const log = join(dir, "stub.log");
	for (const name of ["launchctl", "systemctl"]) {
		writeFileSync(
			join(bin, name),
			`#!/bin/sh\necho "${name} $*" >> "${log}"\nexit ${stubExit}\n`,
		);
		chmodSync(join(bin, name), 0o755);
	}
	const home = join(dir, "home");
	const state = join(dir, "state");
	mkdirSync(home);
	mkdirSync(state, { mode: 0o700 });
	const env = {
		PATH: `${bin}:/usr/bin:/bin`,
		HOME: home,
		PULSAR_HOME: state,
		PULSAR_INSTALL_ROOT: join(dir, "install"),
		PULSAR_NO_MESH: "1",
		PULSAR_NO_SCAN: "1",
	};
	const stubLog = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
	return { dir, home, state, env, stubLog };
}

function cliRun(env: Record<string, string>, args: string[]) {
	const r = spawnSync(node, [cli, ...args], {
		encoding: "utf8",
		env,
		timeout: 20_000,
	});
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

async function until<T>(fn: () => T | null, ms = 10_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 100));
	}
}

function daemonPid(env: Record<string, string>): number | null {
	const r = cliRun(env, ["status"]);
	try {
		return (JSON.parse(r.out) as { pid: number }).pid;
	} catch {
		return null;
	}
}

function writeRecord(s: ReturnType<typeof sandbox>) {
	const kind = process.platform === "darwin" ? "launchd" : "systemd";
	const file =
		kind === "launchd"
			? join(
					s.home,
					"Library",
					"LaunchAgents",
					"io.github.yocontra.pulsar.plist",
				)
			: join(s.home, ".config", "systemd", "user", "pulsar.service");
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, "stub");
	writeFileSync(join(s.state, "service.json"), JSON.stringify({ kind, file }));
	return file;
}

describe("service hand-off", () => {
	test("the service takes the socket from an on-demand daemon; stop is refused", async () => {
		const s = sandbox();
		const ondemand = spawn(node, [cli, "daemon"], {
			env: s.env,
			stdio: "ignore",
		});
		children.push(ondemand);
		const first = await until(() => daemonPid(s.env));
		expect(first).toBe(ondemand.pid!);

		const service = spawn(node, [cli, "daemon", "--service"], {
			env: s.env,
			stdio: "ignore",
		});
		children.push(service);
		await until(() => (daemonPid(s.env) === service.pid ? true : null));
		await until(() => (ondemand.exitCode !== null ? true : null));
		expect(ondemand.exitCode).toBe(0);

		const stop = cliRun(s.env, ["stop"]);
		expect(stop.code).toBe(1);
		expect(stop.out).toContain("runs as a service");
		expect(daemonPid(s.env)).toBe(service.pid!);
	}, 30_000);

	test("an on-demand start defers to the installed service", () => {
		const s = sandbox();
		writeRecord(s);
		const r = cliRun(s.env, ["daemon"]);
		expect(r.code).toBe(0);
		expect(s.stubLog()).toContain(
			process.platform === "darwin"
				? `launchctl kickstart gui/${uid}/io.github.yocontra.pulsar`
				: "systemctl --user start pulsar.service",
		);
		expect(existsSync(join(s.state, "bus.sock"))).toBe(false);
	});

	test("without a service record nothing defers (other PULSAR_HOME, tests)", async () => {
		const s = sandbox();
		const d = spawn(node, [cli, "daemon"], { env: s.env, stdio: "ignore" });
		children.push(d);
		expect(await until(() => daemonPid(s.env))).toBe(d.pid!);
		expect(s.stubLog()).toBe("");
	}, 20_000);

	test("mesh off removes the recorded service and turns the app off; agent configs stay", () => {
		const s = sandbox();
		const file = writeRecord(s);
		writeFileSync(join(s.state, "settings.json"), '{ "remote": true }\n');
		const r = cliRun(s.env, ["mesh", "off"]);
		expect(r.code).toBe(0);
		expect(existsSync(file)).toBe(false);
		expect(existsSync(join(s.state, "service.json"))).toBe(false);
		expect(s.stubLog()).toContain(
			process.platform === "darwin"
				? `launchctl bootout gui/${uid}/io.github.yocontra.pulsar`
				: "systemctl --user disable --now pulsar.service",
		);
		expect(
			JSON.parse(readFileSync(join(s.state, "settings.json"), "utf8")).remote,
		).toBe(false);
	});

	test("setup --uninstall removes the service before the install folder", () => {
		const s = sandbox();
		const file = writeRecord(s);
		const r = cliRun(s.env, ["setup", "--uninstall", "--yes"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("stop and remove the background service");
		expect(existsSync(file)).toBe(false);
		expect(s.stubLog()).toContain(
			process.platform === "darwin"
				? "launchctl bootout"
				: "systemctl --user disable",
		);
	});
});
