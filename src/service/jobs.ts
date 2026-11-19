import { monitorEventLoopDelay } from "node:perf_hooks";
import { daemonLog } from "../log.ts";
import { type GcStats, LagProbe, type StallCause } from "./lag-probe.ts";

/**
 * The daemon's background jobs (scans, git/PR/model refreshes, the sweep).
 * Each runs on a self-rescheduling timer: never two runs of one job at once
 * (a tick that comes while the previous run is busy is skipped), and a job
 * that ran long waits longer before the next run, so a loaded machine gets
 * fewer scans, not a pile of overlapping ones. Request handlers never await
 * a job: they read the registry as it is.
 */

export interface JobOptions {
	/** Run once at start instead of after the first interval. */
	runNow?: boolean;
	/** Longest wait between runs when backing off. */
	maxIntervalMs?: number;
}

interface JobState {
	name: string;
	running: boolean;
	runs: number;
	lastMs: number;
	maxMs: number;
	nextMs: number;
}

/** A run this long blocked the loop synchronously, before its first await. */
const SYNC_WARN_MS = 200;
/** A job's next wait: at least its interval, or this many times its last run. */
const BACKOFF_FACTOR = 4;

export class Jobs {
	private timers = new Set<ReturnType<typeof setTimeout>>();
	private states = new Map<string, JobState>();
	private stopped = false;

	private readonly warn: (line: string) => void;

	constructor(warn: (line: string) => void = daemonLog) {
		this.warn = warn;
	}

	every(
		name: string,
		intervalMs: number,
		fn: () => unknown,
		opts: JobOptions = {},
	) {
		const state: JobState = {
			name,
			running: false,
			runs: 0,
			lastMs: 0,
			maxMs: 0,
			nextMs: intervalMs,
		};
		this.states.set(name, state);
		const maxMs = opts.maxIntervalMs ?? Math.max(intervalMs * 15, 60_000);
		const schedule = (delay: number) => {
			if (this.stopped) return;
			const t = setTimeout(() => {
				this.timers.delete(t);
				void tick();
			}, delay);
			t.unref?.();
			this.timers.add(t);
		};
		const tick = async () => {
			if (this.stopped || state.running) return;
			state.running = true;
			const start = performance.now();
			const cpu = process.cpuUsage();
			try {
				const result = fn();
				const syncMs = performance.now() - start;
				if (syncMs > SYNC_WARN_MS) {
					// Wall time without CPU is the OS (a loaded machine, a blocking
					// call), not this job's JS: say which, as the stall lines do.
					const used = process.cpuUsage(cpu);
					const cpuMs = Math.round((used.user + used.system) / 1000);
					const why =
						cpuMs < syncMs * 0.3
							? `starved: ${cpuMs} ms of CPU`
							: `${cpuMs} ms of CPU`;
					this.warn(
						`event loop: job ${name} blocked it ${Math.round(syncMs)} ms before its first await (${why})`,
					);
				}
				await result;
			} catch (e) {
				if (!this.stopped)
					this.warn(`job ${name} failed: ${(e as Error).message}`);
			} finally {
				const ms = performance.now() - start;
				state.running = false;
				state.runs++;
				state.lastMs = Math.round(ms);
				state.maxMs = Math.max(state.maxMs, state.lastMs);
				state.nextMs = Math.min(
					maxMs,
					Math.max(intervalMs, Math.round(ms * BACKOFF_FACTOR)),
				);
				schedule(state.nextMs);
			}
		};
		if (opts.runNow) void tick();
		else schedule(intervalMs);
	}

	/** Jobs running right now (the suspects when the loop stalls). */
	running(): string[] {
		return [...this.states.values()]
			.filter((s) => s.running)
			.map((s) => s.name);
	}

	stats() {
		return [...this.states.values()].map(
			({ name, running, runs, lastMs, maxMs, nextMs }) => ({
				name,
				running,
				runs,
				lastMs,
				maxMs,
				nextMs,
			}),
		);
	}

	stop() {
		this.stopped = true;
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
	}
}

/** Sampling interval of the event-loop delay histogram. */
const RESOLUTION_MS = 20;

export interface LagStats {
	/** Event-loop delay percentiles since the daemon started, in ms. */
	p50: number;
	p99: number;
	max: number;
	/** Stalls over the warning threshold, and the latest one. */
	stalls: number;
	/** Stalls by cause: JS ran, GC ran, or the process barely had the CPU. */
	causes: { busy: number; gc: number; starved: number };
	lastStall: {
		at: string;
		ms: number;
		culprit: string;
		cause?: StallCause;
	} | null;
	/** Garbage collection since start (Node). */
	gc?: GcStats;
}

/**
 * Watches event-loop lag. A stall over `warnMs` is logged with its suspects:
 * the jobs running at the time. `pulsar status` and doctor show the numbers.
 */
export class LagMonitor {
	private readonly histogram = monitorEventLoopDelay({
		resolution: RESOLUTION_MS,
	});
	private timer: ReturnType<typeof setInterval> | null = null;
	private stalls = 0;
	private causes = { busy: 0, gc: 0, starved: 0 };
	private lastStall: LagStats["lastStall"] = null;
	private lastWarnAt = 0;
	private readonly probe: LagProbe;

	private readonly suspects: () => string[];
	private readonly warnMs: number;
	private readonly warn: (line: string) => void;

	constructor(
		suspects: () => string[],
		warnMs = 200,
		warn: (line: string) => void = daemonLog,
	) {
		this.suspects = suspects;
		this.warnMs = warnMs;
		this.warn = warn;
		this.probe = new LagProbe(warn);
	}

	start() {
		this.histogram.enable();
		void this.probe.start();
		const everyMs = 100;
		let expected = performance.now() + everyMs;
		this.timer = setInterval(() => {
			const now = performance.now();
			const lag = now - expected;
			expected = now + everyMs;
			if (lag > this.warnMs) this.stall(lag);
			else this.probe.tick();
		}, everyMs);
		this.timer.unref?.();
	}

	private stall(ms: number) {
		this.stalls++;
		const running = this.suspects();
		const culprit = running.length ? running.join(", ") : "no background job";
		const stall: NonNullable<LagStats["lastStall"]> = {
			at: new Date().toISOString(),
			ms: Math.round(ms),
			culprit,
		};
		this.lastStall = stall;
		void this.probe.explain(ms).then((cause) => {
			this.probe.tick();
			stall.cause = cause;
			this.causes[cause.kind]++;
			// At most one line every 10 s: a stuck machine must not flood the log.
			if (Date.now() - this.lastWarnAt < 10_000) return;
			this.lastWarnAt = Date.now();
			const why =
				cause.kind === "starved"
					? `starved: ${cause.cpuMs} ms of CPU`
					: `${cause.kind}: ${cause.cpuMs} ms of CPU, ${cause.gcMs} ms GC`;
			const top = cause.top.length ? `; top: ${cause.top.join(", ")}` : "";
			this.warn(
				`event loop: blocked ${Math.round(ms)} ms (running: ${culprit}; ${why}${top})`,
			);
		});
	}

	stats(): LagStats {
		// Node counts the sampling interval in each delay; Bun reports only the excess.
		const base = process.versions.bun ? 0 : RESOLUTION_MS;
		const ms = (ns: number) =>
			Math.max(0, Math.round((ns / 1e6 - base) * 10) / 10);
		const h = this.histogram;
		return {
			p50: h.count ? ms(h.percentile(50)) : 0,
			p99: h.count ? ms(h.percentile(99)) : 0,
			max: h.count ? ms(h.max) : 0,
			stalls: this.stalls,
			causes: { ...this.causes },
			lastStall: this.lastStall,
			gc: this.probe.gcStats(),
		};
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.histogram.disable();
		this.probe.stop();
	}
}
