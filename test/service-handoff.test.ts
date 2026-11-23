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
import { connect } from "node:net";
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

function socketAnswers(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const c = connect(path);
		c.once("connect", () => {
			c.destroy();
			resolve(true);
		});
		c.once("error", () => resolve(false));
	});
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Clients that start an on-demand daemon the moment the socket stops
 * answering, as busy agents do while the service restarts. Returns the
 * daemons it started and a stop function.
 */
function eagerClients(s: ReturnType<typeof sandbox>) {
	const sock = join(s.state, "bus.sock");
	const started: ChildProcess[] = [];
	let checking = false;
	const timer = setInterval(async () => {
		if (checking) return;
		checking = true;
		try {
			if (await socketAnswers(sock)) return;
			const d = spawn(node, [cli, "daemon"], { env: s.env, stdio: "ignore" });
			children.push(d);
			started.push(d);
		} finally {
			checking = false;
		}
	}, 25);
	return { started, stop: () => clearInterval(timer) };
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

	test("a service restart while clients keep starting on-demand daemons ends with the service serving", async () => {
		// The service manager refuses `kickstart` from the clients (as the
		// operator's log showed), so each client start runs on demand.
		const s = sandbox(1);
		writeRecord(s);
		const first = spawn(node, [cli, "daemon"], { env: s.env, stdio: "ignore" });
		children.push(first);
		expect(await until(() => daemonPid(s.env))).toBe(first.pid!);
		const clients = eagerClients(s);
		try {
			const service = spawn(node, [cli, "daemon", "--service"], {
				env: s.env,
				stdio: "ignore",
			});
			children.push(service);
			await until(
				() => (daemonPid(s.env) === service.pid ? true : null),
				30_000,
			);
			// Past the old 10 s give-up: the service is still the one serving.
			await new Promise((r) => setTimeout(r, 12_000));
			expect(service.exitCode).toBeNull();
			expect(daemonPid(s.env)).toBe(service.pid!);
			const status = JSON.parse(cliRun(s.env, ["status"]).out) as {
				service?: boolean;
			};
			expect(status.service).toBe(true);
			// Every on-demand daemon has exited: one daemon serves.
			expect(alive(first.pid!)).toBe(false);
			for (const d of clients.started) expect(alive(d.pid!)).toBe(false);
		} finally {
			clients.stop();
		}
	}, 60_000);

	for (const service of [true, false]) {
		test(`${service ? "the service" : "an on-demand daemon"} keeps running and retrying while Tailscale is down`, async () => {
			const s = sandbox();
			// A `tailscale` CLI that cannot reach tailscaled, first on PATH.
			writeFileSync(
				join(s.dir, "bin", "tailscale"),
				'#!/bin/sh\necho "failed to connect to local Tailscale service" >&2\nexit 1\n',
			);
			chmodSync(join(s.dir, "bin", "tailscale"), 0o755);
			const env = { ...s.env, PULSAR_REMOTE: "1", PULSAR_HTTP_PORT: "47337" };
			const d = spawn(
				node,
				[cli, "daemon", ...(service ? ["--service"] : [])],
				{ env, stdio: "ignore" },
			);
			children.push(d);
			const status = await until(() => {
				const r = cliRun(env, ["status"]);
				try {
					const st = JSON.parse(r.out) as {
						pid: number;
						service: boolean;
						app: { state: string; tailscale?: boolean; error?: string };
					};
					return st.app.state === "retrying" ? st : null;
				} catch {
					return null;
				}
			});
			expect(status.pid).toBe(d.pid!);
			expect(status.service).toBe(service);
			expect(status.app.tailscale).toBe(true);
			expect(status.app.error).toContain(
				"failed to connect to local Tailscale service",
			);
			const log = readFileSync(join(s.state, "daemon.log"), "utf8");
			expect(log).toContain("(retrying in 5 s)");
			expect(d.exitCode).toBeNull();
		}, 30_000);
	}

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
