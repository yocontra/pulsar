/**
 * Live checks for the native presence prompt (docs/presence.md). Modes
 * marked PROMPT show a real Touch ID / Windows Hello / polkit dialog: run
 * them only when the person at the machine expects it. Nothing here touches
 * the real daemon, its socket or the real HOME: daemons run with a temp HOME
 * and PULSAR_HOME, scanners and the app off. Build first (`bun run build`).
 *
 *   bun scripts/presence-live.ts direct          PROMPT
 *     The provider from this process: one prompt; prints the outcome and time.
 *
 *   bun scripts/presence-live.ts kill            PROMPT (4 s)
 *     Starts a prompt and kills its child after 4 s: the dialog must close.
 *
 *   bun scripts/presence-live.ts daemon          PROMPT
 *     A throwaway daemon in this process shows the prompt for
 *     `pulsar mesh owner live@example.com`, run as a child with no terminal.
 *
 *   bun scripts/presence-live.ts launchd         PROMPT
 *     The real design: a throwaway daemon run by launchd as a LaunchAgent
 *     job in your GUI session (label io.github.yocontra.pulsar.livecheck,
 *     temp HOME), and `pulsar mesh owner live@example.com` from a shell with
 *     no terminal. The daemon shows the prompt. The job is removed after.
 *
 *   bun scripts/presence-live.ts launchd-dry     no prompt
 *     The same plumbing with the prompt off in the job: shows the refusal.
 *
 *   bun scripts/presence-live.ts launchd-probe   no prompt
 *     Whether LocalAuthentication can evaluate the policy from a launchd job.
 */
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { MAC_SCRIPT, nativeProvider } from "../src/presence/native.ts";

const mode = process.argv[2] ?? "direct";
const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "dist", "cli.js");
const LABEL = "io.github.yocontra.pulsar.livecheck";
const OWNER = "live@example.com";

if (process.env.PULSAR_NATIVE_PRESENCE === "off")
	throw new Error(
		"PULSAR_NATIVE_PRESENCE=off is set; unset it for the live check",
	);
if (!existsSync(CLI)) throw new Error("run `bun run build` first");

/** Runs the built CLI with no terminal (as an agent runs it); returns its output. */
function cliNoTty(home: string, env: NodeJS.ProcessEnv = {}) {
	return new Promise<{ code: number | null; out: string }>((resolve) => {
		const child = spawn(process.execPath, [CLI, "mesh", "owner", OWNER], {
			env: { ...process.env, PULSAR_HOME: home, PULSAR_NO_SCAN: "1", ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (b) => {
			out += b;
		});
		child.stderr.on("data", (b) => {
			out += b;
		});
		child.on("close", (code) => resolve({ code, out }));
	});
}

/** The real node binary (not a version-manager shim, which needs the real HOME). */
function nodeBinary(): string {
	return execFileSync("node", ["-p", "process.execPath"], {
		encoding: "utf8",
	}).trim();
}

const uid = process.getuid?.() ?? 0;

function plist(
	args: string[],
	env: Record<string, string>,
	out: string,
): string {
	const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map((a) => `<string>${esc(a)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
		.map(([k, v]) => `<key>${k}</key><string>${esc(v)}</string>`)
		.join("")}</dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${esc(out)}</string>
<key>StandardErrorPath</key><string>${esc(out)}</string>
</dict></plist>`;
}

function launchctl(...args: string[]) {
	try {
		execFileSync("launchctl", args, { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const loaded = () => launchctl("print", `gui/${uid}/${LABEL}`);

/** Boots the job out and waits until launchd has really let it go (bootout returns early). */
async function bootout() {
	launchctl("bootout", `gui/${uid}/${LABEL}`);
	await until(() => !loaded(), 10_000);
}

/** Bootstraps a LaunchAgent job in the GUI session; returns a cleanup. */
async function launchJob(
	dir: string,
	args: string[],
	env: Record<string, string>,
) {
	const file = join(dir, `${LABEL}.plist`);
	const out = join(dir, "job.log");
	writeFileSync(file, plist(args, env, out));
	await bootout(); // a leftover from an earlier run
	// Right after a bootout, bootstrap can still fail for a moment: retry.
	let ok = false;
	for (let i = 0; i < 10 && !ok; i++) {
		ok = launchctl("bootstrap", `gui/${uid}`, file);
		if (!ok) await new Promise((r) => setTimeout(r, 500));
	}
	if (!ok)
		throw new Error(
			`launchctl bootstrap gui/${uid} failed 10 times (not in your GUI session?)`,
		);
	return {
		log: () => (existsSync(out) ? readFileSync(out, "utf8") : ""),
		stop: bootout,
	};
}

/**
 * Prints and exits once stdout has drained: process.exit with stdout on a
 * pipe drops what is still buffered (a live run lost its output that way).
 */
async function finish(code = 0): Promise<never> {
	await new Promise<void>((r) => process.stdout.write("", () => r()));
	await new Promise<void>((r) => process.stderr.write("", () => r()));
	process.exit(code);
}

/** One result line, written synchronously, so it is never lost. */
function say(line: string) {
	writeSync(1, `${line}\n`);
}

async function until(check: () => boolean, ms: number) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

if (mode === "direct" || mode === "kill") {
	const provider = nativeProvider();
	if (!provider)
		throw new Error(`no native presence prompt on ${process.platform}`);
	say(`${provider.method}: available = ${await provider.available()}`);
	const ac = new AbortController();
	if (mode === "kill") setTimeout(() => ac.abort(), 4000);
	const t0 = Date.now();
	const outcome = await provider.verify(
		"confirm a Pulsar change: live check (asked by scripts/presence-live.ts)",
		{ signal: ac.signal, timeoutMs: 60_000 },
	);
	say(`outcome: ${outcome} after ${Date.now() - t0} ms`);
	await finish();
}

if (mode === "daemon") {
	const home = mkdtempSync(join(tmpdir(), "pulsar-live-presence-"));
	process.env.PULSAR_HOME = home;
	const d = new Daemon({
		socket: join(home, "bus.sock"),
		db: join(home, "pulsar.db"),
		scan: false,
		machine: "live-check",
		remote: { mode: "off" },
	});
	if (!(await d.start())) throw new Error("throwaway daemon did not start");
	try {
		const r = await cliNoTty(home);
		say(`pulsar mesh owner exited ${r.code}:\n${r.out.trim()}`);
		say(`pool owner now: ${d.service.poolMembers.owner ?? "(none)"}`);
	} finally {
		await d.stop();
		rmSync(home, { recursive: true, force: true });
	}
	await finish();
}

if (process.platform !== "darwin") throw new Error(`${mode} is for macOS`);
const dir = mkdtempSync(join(tmpdir(), "pulsar-live-launchd-"));
try {
	if (mode === "launchd-probe") {
		const job = await launchJob(
			dir,
			[
				"/usr/bin/osascript",
				"-l",
				"JavaScript",
				"-e",
				MAC_SCRIPT,
				"",
				"0",
				"probe",
			],
			{ HOME: dir },
		);
		await until(() => job.log().includes("probe"), 10_000);
		await job.stop();
		say(
			`LocalAuthentication from a launchd job: ${job.log().trim() || "(no output)"}`,
		);
	} else if (mode === "launchd" || mode === "launchd-dry") {
		const home = join(dir, "home");
		const state = join(dir, "state");
		mkdirSync(home);
		mkdirSync(state, { mode: 0o700 });
		const job = await launchJob(dir, [nodeBinary(), CLI, "daemon"], {
			HOME: home,
			PULSAR_HOME: state,
			PULSAR_NO_SCAN: "1",
			PULSAR_NO_MESH: "1",
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
			...(mode === "launchd-dry" ? { PULSAR_NATIVE_PRESENCE: "off" } : {}),
		});
		try {
			if (!(await until(() => existsSync(join(state, "bus.sock")), 15_000)))
				throw new Error(`the launchd daemon did not start:\n${job.log()}`);
			say(
				`launchd daemon up (gui/${uid}/${LABEL}); running pulsar mesh owner ${OWNER} with no terminal…`,
			);
			const r = await cliNoTty(state, { HOME: home });
			say(`pulsar mesh owner exited ${r.code}:\n${r.out.trim()}`);
		} finally {
			await job.stop();
		}
	} else
		throw new Error(
			"usage: presence-live.ts direct|kill|daemon|launchd|launchd-dry|launchd-probe",
		);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
await finish();
