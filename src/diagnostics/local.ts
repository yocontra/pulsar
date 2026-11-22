/**
 * This machine's Diagnostics (`GET /diagnostics`, and a peer's `diag.read`):
 * the daemon runs its own CLI as `pulsar doctor --json` in a child process,
 * so the app shows exactly the checks the terminal does, and doctor's file
 * and command checks never block the daemon's event loop. The daemon adds
 * what only it knows (uptime, event loop, live agents) and redacts the
 * report before it leaves.
 */
import { homedir } from "node:os";
import { exec } from "../exec.ts";
import type { LocalDiagnostics } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import { VERSION } from "../version.ts";
import { cleanChecks, cleanFacts, redact, redactReport } from "./checks.ts";

/** Doctor asks Tailscale, launchd/systemd, lsof and the other devices. */
const DOCTOR_TIMEOUT_MS = 30_000;
/** A report this fresh is shown again instead of running doctor again. */
export const FRESH_MS = 15_000;
/**
 * Even when asked for a fresh run (`refresh=1`, a peer's `fresh`), a report
 * or failure this new is shown again: repeated presses never spawn doctor
 * back to back.
 */
export const MIN_FRESH_MS = 3000;

export interface LocalDiagnosticsDeps {
	/** Runs `pulsar doctor --json`: its stdout (doctor exits 1 on a problem). */
	doctor?: () => Promise<{ stdout: string; error: string | null }>;
	/** What the daemon knows about itself. */
	daemon: () => {
		agents: number;
		eventLoop: { p99: number; max: number; stalls: number } | null;
	};
	home?: string;
	now?: () => number;
	uptimeS?: () => number;
}

/** The CLI this daemon runs from, as a child: same node, same file. */
async function runOwnDoctor() {
	const cli = process.argv[1];
	if (!cli) return { stdout: "", error: "the daemon's CLI is unknown" };
	const r = await exec(process.execPath, [cli, "doctor", "--json"], {
		lane: "user",
		timeoutMs: DOCTOR_TIMEOUT_MS,
		maxBuffer: 2 * 1024 * 1024,
	});
	return {
		stdout: r.stdout,
		error: r.timedOut ? "doctor took too long" : r.error,
	};
}

/** The doctor's JSON line (the last line that is an object). */
export function parseDoctorOutput(stdout: string): unknown {
	const lines = stdout.split("\n").reverse();
	for (const line of lines) {
		const t = line.trim();
		if (!t.startsWith("{")) continue;
		try {
			return JSON.parse(t);
		} catch {}
	}
	return null;
}

export class LocalDiagnosticsRunner {
	private readonly deps: LocalDiagnosticsDeps;
	/** The last run's outcome, a report or a failure, and when it ended. */
	private last:
		| { at: number; report: LocalDiagnostics }
		| { at: number; error: Error }
		| null = null;
	private running: Promise<LocalDiagnostics> | null = null;

	constructor(deps: LocalDiagnosticsDeps) {
		this.deps = deps;
	}

	/**
	 * The report: the last outcome (report or failure) while it is newer
	 * than FRESH_MS, or MIN_FRESH_MS when `fresh`; else run doctor now. One
	 * run at a time.
	 */
	read(fresh = false): Promise<LocalDiagnostics> {
		if (this.running) return this.running;
		const last = this.last;
		if (last && this.now() - last.at < (fresh ? MIN_FRESH_MS : FRESH_MS))
			return "report" in last
				? Promise.resolve(last.report)
				: Promise.reject(last.error);
		this.running = this.run().then(
			(report) => {
				this.last = { at: this.now(), report };
				this.running = null;
				return report;
			},
			(e: Error) => {
				// A failing doctor is throttled like a working one.
				this.last = { at: this.now(), error: e };
				this.running = null;
				throw e;
			},
		);
		return this.running;
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private async run(): Promise<LocalDiagnostics> {
		const out = await (this.deps.doctor ?? runOwnDoctor)();
		const raw = parseDoctorOutput(out.stdout) as Record<string, unknown> | null;
		const home = this.deps.home ?? homedir();
		if (!raw || !Array.isArray(raw.checks))
			// The child's stderr names files and may repeat a secret: redacted too.
			throw new RpcError(
				"unreachable",
				redact(
					`doctor did not answer${out.error ? `: ${out.error}` : ""}`,
					home,
				),
			);
		const d = this.deps.daemon();
		const report: LocalDiagnostics = {
			// The running daemon's version (doctor's child may be a newer install).
			version: VERSION,
			platform: process.platform,
			uptimeS: Math.round(this.deps.uptimeS?.() ?? process.uptime()),
			agents: d.agents,
			eventLoop: d.eventLoop,
			checks: cleanChecks(raw.checks),
			facts: cleanFacts(raw.facts),
			checkedAt: this.deps.now?.() ?? Date.now(),
		};
		return redactReport(report, home);
	}
}
