/**
 * What a stall was made of, so the log says why the event loop stopped
 * instead of guessing: the JS that ran (a rolling CPU profile), the garbage
 * collector, and whether the process had the CPU at all.
 *
 * - CPU profile: a stall starts V8's sampling profiler for the next
 *   `WATCH_MS`. Stalls rarely come alone: the next one inside that window
 *   cuts the profile, and the samples of its window give the top self-time
 *   frames (`(garbage collector)` and `(program)` show up as such). Not
 *   always on: stopping a long profile serializes it on the main thread,
 *   a stall of its own.
 * - GC: a PerformanceObserver on `gc` entries; pauses overlapping the stall.
 * - CPU: process.cpuUsage over the stall. Far less CPU than wall time means
 *   the process was not running: the OS starved it (load far past the
 *   cores) or it waited in a blocking call, not JS work.
 *
 * Node only (the daemon's runtime). The CPU profile only with
 * PULSAR_LAG_PROFILE=1; GC and CPU-vs-wall always.
 */

interface ProfileNode {
	id: number;
	children?: number[];
	callFrame: {
		functionName: string;
		url: string;
		lineNumber: number;
	};
}

interface Profile {
	nodes: ProfileNode[];
	endTime: number;
	samples?: number[];
	timeDeltas?: number[];
}

type Post = (method: string, params?: object) => Promise<unknown>;

/** Sampling interval of the rolling profile (µs). */
const SAMPLE_US = 5000;
/** How long the profiler watches after a stall, waiting for the next one. */
const WATCH_MS = 10_000;
/** A GC pause this long is logged on its own. */
const LONG_GC_MS = 50;

export interface StallCause {
	/** CPU time the process got during the stall, in ms. */
	cpuMs: number;
	/** GC pause time inside the stall, in ms. */
	gcMs: number;
	/** Top self-time frames in the stall's window: "name (file:line) N ms". */
	top: string[];
	/** busy: JS (or GC) ran; starved: the process barely had the CPU. */
	kind: "busy" | "gc" | "starved";
}

export interface GcStats {
	count: number;
	totalMs: number;
	maxMs: number;
	/** Pauses of LONG_GC_MS and more. */
	long: number;
}

export class LagProbe {
	private post: Post | null = null;
	private watchEnd: ReturnType<typeof setTimeout> | null = null;
	private gcObserver: { disconnect(): void } | null = null;
	private gcs: Array<{ start: number; ms: number }> = [];
	private gc: GcStats = { count: 0, totalMs: 0, maxMs: 0, long: 0 };
	private cpu = process.cpuUsage();
	private cpuAt = performance.now();
	private readonly warn: (line: string) => void;
	private profiling = false;

	constructor(warn: (line: string) => void) {
		this.warn = warn;
	}

	async start() {
		if (process.versions.bun) return;
		this.watchGc();
		// The CPU profile is opt-in: starting and stopping V8's profiler blocks
		// the loop itself (hundreds of ms on a loaded machine).
		if (process.env.PULSAR_LAG_PROFILE !== "1") return;
		try {
			const { Session } = await import("node:inspector/promises");
			const session = new Session();
			session.connect();
			this.post = (m, p) =>
				session.post(m as never, p as never) as Promise<unknown>;
			await this.post("Profiler.enable");
			await this.post("Profiler.setSamplingInterval", { interval: SAMPLE_US });
		} catch (e) {
			this.post = null;
			this.warn(`lag profile unavailable: ${(e as Error).message}`);
		}
	}

	private watchGc() {
		try {
			const { PerformanceObserver } = process.getBuiltinModule(
				"node:perf_hooks",
			) as typeof import("node:perf_hooks");
			const obs = new PerformanceObserver((list) => {
				for (const e of list.getEntries()) {
					const ms = e.duration;
					this.gc.count++;
					this.gc.totalMs += ms;
					this.gc.maxMs = Math.max(this.gc.maxMs, ms);
					this.gcs.push({ start: e.startTime, ms });
					if (this.gcs.length > 200) this.gcs.shift();
					if (ms >= LONG_GC_MS) {
						this.gc.long++;
						this.warn(`gc: ${Math.round(ms)} ms pause`);
					}
				}
			});
			obs.observe({ entryTypes: ["gc"] });
			this.gcObserver = obs;
		} catch {}
	}

	private async begin() {
		if (!this.post) return;
		await this.post("Profiler.start");
		this.profiling = true;
	}

	private async cut(): Promise<Profile | null> {
		if (!this.post || !this.profiling) return null;
		this.profiling = false;
		const r = (await this.post("Profiler.stop")) as { profile: Profile };
		return r.profile;
	}

	/** Profiles the next WATCH_MS; a later stall in that window reads it. */
	private async watch() {
		if (!this.post) return;
		if (this.watchEnd) clearTimeout(this.watchEnd);
		await this.begin().catch(() => {});
		this.watchEnd = setTimeout(() => {
			this.watchEnd = null;
			void this.cut().catch(() => null);
		}, WATCH_MS);
		this.watchEnd.unref?.();
	}

	/** Called on every lag-monitor tick: the CPU baseline for the next stall. */
	tick() {
		this.cpu = process.cpuUsage();
		this.cpuAt = performance.now();
	}

	/** What the last `ms` of wall time (just ended) were made of. */
	async explain(ms: number): Promise<StallCause> {
		const now = performance.now();
		const used = process.cpuUsage(this.cpu);
		const cpuMs = Math.round((used.user + used.system) / 1000);
		const from = now - ms;
		let gcMs = 0;
		for (const g of this.gcs) if (g.start + g.ms >= from) gcMs += g.ms;
		gcMs = Math.round(gcMs);
		const wall = Math.max(1, now - this.cpuAt);
		const profile = await this.cut().catch(() => null);
		void this.watch();
		const top = profile ? topFrames(profile, ms + 100) : [];
		const kind =
			gcMs >= ms / 2 ? "gc" : cpuMs < wall * 0.3 ? "starved" : "busy";
		return { cpuMs, gcMs, top, kind };
	}

	gcStats(): GcStats {
		return {
			count: this.gc.count,
			totalMs: Math.round(this.gc.totalMs),
			maxMs: Math.round(this.gc.maxMs * 10) / 10,
			long: this.gc.long,
		};
	}

	stop() {
		if (this.watchEnd) clearTimeout(this.watchEnd);
		this.watchEnd = null;
		this.gcObserver?.disconnect();
		this.gcObserver = null;
		void this.cut().catch(() => null);
		this.post = null;
	}
}

/** Self time per frame over the profile's last `windowMs`, top five. */
export function topFrames(profile: Profile, windowMs: number): string[] {
	const samples = profile.samples ?? [];
	const deltas = profile.timeDeltas ?? [];
	if (samples.length === 0) return [];
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const parent = new Map<number, number>();
	for (const n of profile.nodes)
		for (const c of n.children ?? []) parent.set(c, n.id);
	const where = (n: ProfileNode | undefined) => {
		const f = n?.callFrame;
		if (!f?.url) return "";
		return ` (${f.url.replace(/^.*\//, "")}:${f.lineNumber + 1})`;
	};
	/** A frame's label; a native or Node-internal one names our JS function that called it. */
	const label = (id: number): string | null => {
		const n = byId.get(id);
		const f = n?.callFrame;
		if (!f) return null;
		const name = f.functionName || "(anonymous)";
		if (name === "(idle)") return null; // waiting, not blocking
		const own = (u: string) => !!u && !u.startsWith("node:");
		const special = !f.url && name.startsWith("(");
		if (own(f.url) || special) return `${name}${where(n)}`;
		for (let up = parent.get(id); up !== undefined; up = parent.get(up)) {
			const p = byId.get(up);
			if (p && own(p.callFrame.url))
				return `${name} in ${p.callFrame.functionName || "(anonymous)"}${where(p)}`;
		}
		return name;
	};
	// Walk back from the end until the window is covered.
	const self = new Map<number, number>();
	let covered = 0;
	for (let i = samples.length - 1; i >= 0 && covered < windowMs * 1000; i--) {
		const d = deltas[i] ?? 0;
		covered += d;
		self.set(samples[i]!, (self.get(samples[i]!) ?? 0) + d);
	}
	const byFrame = new Map<string, number>();
	for (const [id, us] of self) {
		const name = label(id);
		if (name) byFrame.set(name, (byFrame.get(name) ?? 0) + us);
	}
	return [...byFrame.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.filter(([, us]) => us >= 1000)
		.map(([name, us]) => `${name} ${Math.round(us / 1000)} ms`);
}
