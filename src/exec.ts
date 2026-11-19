import { execFile, spawn } from "node:child_process";

/**
 * Child processes for the daemon. The daemon must never block its event loop
 * on a child: on a busy machine `ps`, `git` or `lsof` can take seconds, and a
 * synchronous call stalls every socket and HTTPS request for that long. These
 * run asynchronously, with a timeout, and at most a few at a time: background
 * work (scans, refreshes) and user-triggered work (push, interrupt,
 * set_identity) wait in separate lanes, so a user action never queues behind
 * slow scan children.
 */

export type Lane = "background" | "user";

export interface ExecResult {
	ok: boolean;
	stdout: string;
	/** Exit code; null when the process was killed or never started. */
	code: number | null;
	/** Killed by the timeout (the machine is slow), as opposed to failing. */
	timedOut: boolean;
	/** Killed because its output passed `maxBuffer` (stdout holds what came first). */
	overflow?: boolean;
	error: string | null;
	/** Everything it wrote to stderr (`error` keeps only the first 300 characters). */
	stderr?: string;
}

export interface ExecOptions {
	timeoutMs?: number;
	maxBuffer?: number;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	lane?: Lane;
	/**
	 * How a timeout kills it; SIGKILL by default. SIGTERM lets a child clean
	 * up (git removes its lock files); SIGKILL follows a few seconds later.
	 */
	killSignal?: NodeJS.Signals;
	/**
	 * Run it in its own process group and signal the whole group on timeout,
	 * so what it started (git's hooks, ssh) stops too and its output closes.
	 */
	group?: boolean;
}

/** Runs at most `max` tasks at once; the rest wait in order. */
export class Limiter {
	private active = 0;
	private queue: Array<() => void> = [];

	readonly max: number;

	constructor(max: number) {
		this.max = max;
	}

	get running() {
		return this.active;
	}

	get waiting() {
		return this.queue.length;
	}

	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.active >= this.max)
			await new Promise<void>((r) => this.queue.push(r));
		this.active++;
		// Starting a process blocks the loop briefly (fork/exec; 100 ms and more
		// on a loaded Mac). One start per turn of the loop, so requests are
		// served between the starts of a burst.
		await new Promise<void>((r) => setImmediate(r));
		try {
			return await task();
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}

const LANES: Record<Lane, Limiter> = {
	background: new Limiter(4),
	user: new Limiter(4),
};

/** Children running and queued, per lane (for `pulsar status`). */
export function execStats() {
	return Object.fromEntries(
		Object.entries(LANES).map(([lane, l]) => [
			lane,
			{ running: l.running, waiting: l.waiting },
		]),
	) as Record<Lane, { running: number; waiting: number }>;
}

/** Runs a command; never throws. 4 s timeout and 8 MB of output by default. */
export function exec(
	cmd: string,
	args: string[],
	opts: ExecOptions = {},
): Promise<ExecResult> {
	const lane = LANES[opts.lane ?? "background"];
	return lane.run(() =>
		opts.group
			? runGroup(cmd, args, opts)
			: new Promise<ExecResult>((resolve) => {
					const timeoutMs = opts.timeoutMs ?? 4000;
					const signal = opts.killSignal ?? "SIGKILL";
					const child = execFile(
						cmd,
						args,
						{
							encoding: "utf8",
							timeout: timeoutMs,
							maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
							killSignal: signal,
							...(opts.env ? { env: opts.env } : {}),
							...(opts.cwd ? { cwd: opts.cwd } : {}),
						},
						(err, stdout, stderr) => {
							clearTimeout(hard);
							if (!err)
								return resolve({
									ok: true,
									stdout,
									code: 0,
									timedOut: false,
									error: null,
									stderr: stderr ?? "",
								});
							const e = err as NodeJS.ErrnoException & {
								killed?: boolean;
								signal?: string | null;
							};
							const code = typeof e.code === "number" ? e.code : null;
							const overflow =
								(e.code as unknown) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
							resolve({
								ok: false,
								stdout: stdout ?? "",
								code,
								timedOut: !!e.killed && code === null && !overflow,
								...(overflow ? { overflow } : {}),
								error: String(stderr || e.message)
									.trim()
									.slice(0, 300),
								stderr: stderr ?? "",
							});
						},
					);
					// A gentler kill signal is followed by SIGKILL.
					const hard =
						signal !== "SIGKILL"
							? setTimeout(
									() => child.kill("SIGKILL"),
									timeoutMs + KILL_GRACE_MS,
								)
							: undefined;
					hard?.unref();
				}),
	);
}

/**
 * `exec` in its own process group (`group: true`): a timeout or an output
 * overflow signals the whole group, so what the command started stops too
 * and its output closes. No stdin.
 */
function runGroup(
	cmd: string,
	args: string[],
	opts: ExecOptions,
): Promise<ExecResult> {
	const timeoutMs = opts.timeoutMs ?? 4000;
	const max = opts.maxBuffer ?? 8 * 1024 * 1024;
	const signal = opts.killSignal ?? "SIGKILL";
	return new Promise<ExecResult>((resolve) => {
		const child = spawn(cmd, args, {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			...(opts.env ? { env: opts.env } : {}),
			...(opts.cwd ? { cwd: opts.cwd } : {}),
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let overflow = false;
		let spawnError: Error | null = null;
		const kill = (sig: NodeJS.Signals) => {
			try {
				if (child.pid) process.kill(-child.pid, sig);
			} catch {
				// Already gone.
			}
		};
		const stop = (sig: NodeJS.Signals) => {
			kill(sig);
			if (sig !== "SIGKILL")
				hard ??= setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
		};
		let hard: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			stop(signal);
		}, timeoutMs);
		// Decoded per stream, so a character split across chunks stays whole.
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		const take = (which: "out" | "err") => (chunk: string) => {
			if (which === "out") stdout += chunk;
			else stderr += chunk;
			if (!overflow && stdout.length + stderr.length > max) {
				overflow = true;
				stop("SIGKILL");
			}
		};
		child.stdout?.on("data", take("out"));
		child.stderr?.on("data", take("err"));
		child.on("error", (e) => {
			spawnError = e;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(hard);
			if (code === 0 && !timedOut && !overflow)
				return resolve({
					ok: true,
					stdout,
					code: 0,
					timedOut: false,
					error: null,
					stderr,
				});
			const err = spawnError as Error | null;
			resolve({
				ok: false,
				stdout,
				code: overflow || spawnError ? null : code,
				timedOut: timedOut && !overflow,
				...(overflow ? { overflow } : {}),
				error: String(stderr || err?.message || `exit ${code}`)
					.trim()
					.slice(0, 300),
				stderr,
			});
		});
	});
}

/** After a timeout with a gentler signal, how long until SIGKILL. */
const KILL_GRACE_MS = 5000;

/** stdout of a command, trimmed; null on any failure. */
export async function execText(
	cmd: string,
	args: string[],
	opts: ExecOptions = {},
): Promise<string | null> {
	const r = await exec(cmd, args, opts);
	return r.ok ? r.stdout.trim() || null : null;
}
