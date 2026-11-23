import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { daemonRuntimeFlags } from "../lazy.ts";
import { installRoot, stateDir } from "../paths.ts";

/**
 * The always-on daemon as a user service: a launchd agent on macOS, a
 * systemd user unit on Linux. Both run `<node> <install>/current/dist/cli.js
 * daemon --service`, restart it when it fails and start it at login.
 *
 * Setup records the install in `<state>/service.json`. Only that record
 * makes pulsar treat the service as its own, so a test with another
 * `PULSAR_HOME` never stops or defers to the user's real service.
 */

export const LAUNCHD_LABEL = "io.github.yocontra.pulsar";
const SYSTEMD_UNIT = "pulsar.service";

export interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	/** The command is not installed. */
	missing?: boolean;
}

/** Runs a command without a shell. Never throws. */
export type CommandRunner = (
	cmd: string,
	args: string[],
	timeoutMs?: number,
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (cmd, args, timeoutMs = 10_000) =>
	new Promise((resolve) => {
		try {
			execFile(
				cmd,
				args,
				{ timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
				(err, stdout, stderr) =>
					resolve({
						ok: !err,
						stdout: String(stdout ?? ""),
						stderr: String(stderr || (err ? err.message : "")),
						missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT",
					}),
			).on("error", () => {});
		} catch (e) {
			resolve({ ok: false, stdout: "", stderr: (e as Error).message });
		}
	});

export type ServiceKind = "launchd" | "systemd";

/** Everything the service code reads from the machine, so tests can fake all of it. */
export interface ServiceEnv {
	platform: NodeJS.Platform;
	home: string;
	uid: number;
	/** The node binary the service runs. */
	node: string;
	/** `<install root>/current`. */
	installDir: string;
	stateDir: string;
	/** `$XDG_CONFIG_HOME`, where systemd user units live (default `~/.config`). */
	configHome?: string;
	/** Environment the service keeps (PATH, PULSAR_*, XDG_*). */
	env: Record<string, string>;
	run: CommandRunner;
	/** Waits between launchd retries; tests pass a no-op. */
	wait?: (ms: number) => Promise<void>;
}

/** The service settings for this process (real HOME, uid, node and env). */
export function serviceEnv(run: CommandRunner = runCommand): ServiceEnv {
	return {
		platform: process.platform,
		home: homedir(),
		uid: process.getuid?.() ?? 0,
		node: process.execPath,
		installDir: join(installRoot(), "current"),
		stateDir: stateDir(),
		...(process.env.XDG_CONFIG_HOME
			? { configHome: process.env.XDG_CONFIG_HOME }
			: {}),
		env: serviceVariables(process.env, process.execPath),
		run,
	};
}

/**
 * PATH for the service (node's folder, the usual Tailscale CLI places, the
 * system folders) plus the pulsar and XDG variables setup ran with, so the
 * service uses the same state and install folders.
 */
export function serviceVariables(
	env: NodeJS.ProcessEnv,
	node: string,
): Record<string, string> {
	const path = [
		dirname(node),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/Applications/Tailscale.app/Contents/MacOS",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	];
	const out: Record<string, string> = {
		PATH: [...new Set(path)].join(":"),
	};
	for (const key of [
		"PULSAR_HOME",
		"PULSAR_INSTALL_ROOT",
		"PULSAR_HTTP_PORT",
		// A private CA root for Node versions without tls.setDefaultCACertificates.
		"NODE_EXTRA_CA_CERTS",
		"XDG_STATE_HOME",
		"XDG_DATA_HOME",
	]) {
		const v = env[key];
		if (v) out[key] = v;
	}
	return out;
}

function serviceKind(platform: NodeJS.Platform): ServiceKind | null {
	if (platform === "darwin") return "launchd";
	if (platform === "linux") return "systemd";
	return null;
}

function serviceFile(env: ServiceEnv, kind: ServiceKind): string {
	if (kind === "launchd")
		return join(env.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
	const config = env.configHome ?? join(env.home, ".config");
	return join(config, "systemd", "user", SYSTEMD_UNIT);
}

/** The CLI the service runs: always the `current` link, so upgrades only restart it. */
export function serviceCli(env: ServiceEnv): string {
	return join(env.installDir, "dist", "cli.js");
}

function serviceArgs(env: ServiceEnv): string[] {
	return [
		env.node,
		...daemonRuntimeFlags(env.node),
		serviceCli(env),
		"daemon",
		"--service",
	];
}

function xml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function launchdPlist(env: ServiceEnv): string {
	const args = serviceArgs(env)
		.map((a) => `\t\t<string>${xml(a)}</string>`)
		.join("\n");
	const vars = Object.entries(env.env)
		.map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`)
		.join("\n");
	const log = xml(join(env.stateDir, "service.log"));
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${args}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>${log}</string>
	<key>StandardErrorPath</key>
	<string>${log}</string>
	<key>EnvironmentVariables</key>
	<dict>
${vars}
	</dict>
</dict>
</plist>
`;
}

/** systemd quoting: every word in double quotes, `"`, `\` and `%` escaped. */
function sdQuote(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

export function systemdUnit(env: ServiceEnv): string {
	const vars = Object.entries(env.env)
		.map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
		.join("\n");
	return `[Unit]
Description=pulsar daemon (agent mesh)
After=network-online.target

[Service]
Type=simple
ExecStart=${serviceArgs(env).map(sdQuote).join(" ")}
Restart=on-failure
RestartSec=10
${vars}

[Install]
WantedBy=default.target
`;
}

interface ServiceRecord {
	kind: ServiceKind;
	file: string;
}

function recordPath(dir: string) {
	return join(dir, "service.json");
}

/** The service setup installed for this state folder, or null. */
export function readServiceRecord(
	dir: string = stateDir(),
): ServiceRecord | null {
	try {
		const r = JSON.parse(
			readFileSync(recordPath(dir), "utf8"),
		) as ServiceRecord;
		return r.kind === "launchd" || r.kind === "systemd" ? r : null;
	} catch {
		return null;
	}
}

/** True when setup installed the service for this state folder (one `existsSync`). */
export function serviceInstalled(dir: string = stateDir()): boolean {
	return existsSync(recordPath(dir));
}

/** `serviceInstalled` without blocking (the daemon's start). */
export function serviceInstalledAsync(
	dir: string = stateDir(),
): Promise<boolean> {
	return access(recordPath(dir)).then(
		() => true,
		() => false,
	);
}

/** `readServiceRecord` without blocking (the daemon's start). */
async function readServiceRecordAsync(
	dir: string,
): Promise<ServiceRecord | null> {
	try {
		const r = JSON.parse(
			await readFile(recordPath(dir), "utf8"),
		) as ServiceRecord;
		return r.kind === "launchd" || r.kind === "systemd" ? r : null;
	} catch {
		return null;
	}
}

let installedNow = false;

/** True once `installService` (re)started the service in this process. */
export function serviceInstalledThisRun(): boolean {
	return installedNow;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function launchdTarget(env: ServiceEnv) {
	return `gui/${env.uid}/${LAUNCHD_LABEL}`;
}

export interface InstallResult {
	kind: ServiceKind;
	file: string;
	/** "installed" (new), "updated" (file changed) or "restarted" (same file). */
	change: "installed" | "updated" | "restarted";
}

/**
 * Whether this machine has a service manager pulsar can use: launchd on
 * macOS; on Linux a systemd user session (`systemctl --user` answers).
 * Containers and minimal Linux installs often have neither.
 */
export async function serviceManagerAvailable(
	env: ServiceEnv,
): Promise<boolean> {
	const kind = serviceKind(env.platform);
	if (kind === "launchd") return true;
	if (kind !== "systemd") return false;
	return (await env.run("systemctl", ["--user", "show-environment"])).ok;
}

/**
 * Writes the service file and (re)starts the service. Idempotent: running it
 * again with nothing changed restarts the service, which is how an upgrade
 * moves the service to the new `current`. Throws with the command's error.
 */
export async function installService(env: ServiceEnv): Promise<InstallResult> {
	const kind = serviceKind(env.platform);
	if (!kind)
		throw new Error(`no background service support on ${env.platform}`);
	const file = serviceFile(env, kind);
	const content = kind === "launchd" ? launchdPlist(env) : systemdUnit(env);
	const existed = existsSync(file);
	const changed = !existed || readFileSync(file, "utf8") !== content;
	if (changed) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content, { mode: 0o644 });
	}
	mkdirSync(env.stateDir, { recursive: true, mode: 0o700 });
	writeFileSync(
		recordPath(env.stateDir),
		`${JSON.stringify({ kind, file } satisfies ServiceRecord, null, "\t")}\n`,
	);
	const change = !existed ? "installed" : changed ? "updated" : "restarted";
	if (kind === "launchd") await loadLaunchd(env, file, changed);
	else await loadSystemd(env);
	installedNow = true;
	return { kind, file, change };
}

async function must(
	env: ServiceEnv,
	cmd: string,
	args: string[],
): Promise<void> {
	const r = await env.run(cmd, args);
	if (!r.ok)
		throw new Error(
			`${cmd} ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`,
		);
}

async function loadLaunchd(env: ServiceEnv, file: string, changed: boolean) {
	const target = launchdTarget(env);
	const loaded = (await env.run("launchctl", ["print", target])).ok;
	if (loaded && !changed) {
		await must(env, "launchctl", ["kickstart", "-k", target]);
		return;
	}
	if (loaded) await env.run("launchctl", ["bootout", target]);
	// bootstrap fails with "Input/output error" while the old instance drains.
	const wait = env.wait ?? sleep;
	let last: CommandResult | null = null;
	for (let i = 0; i < 10; i++) {
		last = await env.run("launchctl", ["bootstrap", `gui/${env.uid}`, file]);
		if (last.ok) return;
		await wait(500);
	}
	throw new Error(
		`launchctl bootstrap failed: ${(last?.stderr || last?.stdout || "").trim().split("\n")[0]}`,
	);
}

async function loadSystemd(env: ServiceEnv) {
	await must(env, "systemctl", ["--user", "daemon-reload"]);
	await must(env, "systemctl", ["--user", "enable", SYSTEMD_UNIT]);
	// restart also starts a stopped unit.
	await must(env, "systemctl", ["--user", "restart", SYSTEMD_UNIT]);
}

/** Restarts the installed service (an upgrade). False when none is installed here. */
export async function restartService(env: ServiceEnv): Promise<boolean> {
	const rec = readServiceRecord(env.stateDir);
	if (!rec) return false;
	if (rec.kind === "launchd")
		await must(env, "launchctl", ["kickstart", "-k", launchdTarget(env)]);
	else await must(env, "systemctl", ["--user", "restart", SYSTEMD_UNIT]);
	return true;
}

/**
 * Starts the service if it is not running (what a client does instead of
 * spawning a daemon). `why` is the service manager's error when it refused.
 */
export async function startService(
	env: ServiceEnv,
): Promise<{ ok: boolean; why: string }> {
	const rec = await readServiceRecordAsync(env.stateDir);
	if (!rec) return { ok: false, why: "no service installed" };
	const r =
		rec.kind === "launchd"
			? await env.run("launchctl", ["kickstart", launchdTarget(env)])
			: await env.run("systemctl", ["--user", "start", SYSTEMD_UNIT]);
	const why = (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 200);
	return { ok: r.ok, why: r.ok ? "" : why || "failed" };
}

/** Stops and removes the service this state folder recorded. Returns the removed file, or null. */
export async function removeService(env: ServiceEnv): Promise<string | null> {
	const rec = readServiceRecord(env.stateDir);
	if (!rec) return null;
	if (rec.kind === "launchd")
		await env.run("launchctl", ["bootout", launchdTarget(env)]);
	else await env.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
	rmSync(rec.file, { force: true });
	if (rec.kind === "systemd")
		await env.run("systemctl", ["--user", "daemon-reload"]);
	rmSync(recordPath(env.stateDir), { force: true });
	return rec.file;
}

export interface ServiceStatus {
	kind: ServiceKind;
	file: string;
	fileExists: boolean;
	loaded: boolean;
	running: boolean;
	pid: number | null;
	/** ProgramArguments / ExecStart as written in the file. */
	args: string[];
}

/** What the service file says and what launchd/systemd report. Null when setup installed none here. */
export async function serviceStatus(
	env: ServiceEnv,
): Promise<ServiceStatus | null> {
	const rec = readServiceRecord(env.stateDir);
	if (!rec) return null;
	const fileExists = existsSync(rec.file);
	const text = fileExists ? readFileSync(rec.file, "utf8") : "";
	if (rec.kind === "launchd") {
		const r = await env.run("launchctl", ["print", launchdTarget(env)]);
		const state = /^\s*state = (\S+)/m.exec(r.stdout)?.[1];
		const pid = Number(/^\s*pid = (\d+)/m.exec(r.stdout)?.[1]);
		return {
			kind: rec.kind,
			file: rec.file,
			fileExists,
			loaded: r.ok,
			running: r.ok && state === "running",
			pid: Number.isInteger(pid) && pid > 0 ? pid : null,
			args: plistArgs(text),
		};
	}
	const r = await env.run("systemctl", [
		"--user",
		"show",
		SYSTEMD_UNIT,
		"-p",
		"LoadState",
		"-p",
		"ActiveState",
		"-p",
		"MainPID",
	]);
	const prop = (k: string) =>
		new RegExp(`^${k}=(.*)$`, "m").exec(r.stdout)?.[1];
	const pid = Number(prop("MainPID"));
	return {
		kind: rec.kind,
		file: rec.file,
		fileExists,
		loaded: r.ok && prop("LoadState") === "loaded",
		running: r.ok && prop("ActiveState") === "active",
		pid: pid > 0 ? pid : null,
		args: unitArgs(text),
	};
}

/** The `<string>`s of a plist's ProgramArguments array. */
export function plistArgs(plist: string): string[] {
	const arr = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
		plist,
	)?.[1];
	if (!arr) return [];
	return [...arr.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
		m[1]!
			.replace(/&quot;/g, '"')
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&"),
	);
}

/** The words of a unit's ExecStart line (double-quoted words, as `systemdUnit` writes them). */
export function unitArgs(unit: string): string[] {
	const line = /^ExecStart=(.*)$/m.exec(unit)?.[1];
	if (!line) return [];
	return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) =>
		m[1] !== undefined
			? m[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%")
			: m[2]!,
	);
}
