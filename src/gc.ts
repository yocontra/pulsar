/**
 * Asking the runtime for a full GC. V8 keeps the heap pages a burst grew
 * long after the objects die; pulsar's long-lived processes (one MCP server
 * per agent, the daemon) hand them back with an occasional full collection.
 */

type Collector = (reduce: boolean, sync: boolean) => void;
let collector: Collector | null | undefined;

/** A full GC function, or null when the runtime offers none. */
function getCollector(): Collector | null {
	if (collector !== undefined) return collector;
	collector = null;
	try {
		const bun = (globalThis as { Bun?: { gc(sync: boolean): void } }).Bun;
		if (bun) collector = (_reduce, sync) => bun.gc(sync);
		else {
			const v8 = process.getBuiltinModule(
				"node:v8",
			) as typeof import("node:v8");
			const vm = process.getBuiltinModule(
				"node:vm",
			) as typeof import("node:vm");
			v8.setFlagsFromString("--expose-gc");
			const gc = vm.runInNewContext("gc") as (o?: unknown) => void;
			v8.setFlagsFromString("--no-expose-gc");
			// last-resort also drops compiled code: right for an idle MCP server,
			// too costly for the daemon's hot paths.
			collector = (reduce, sync) =>
				gc({
					type: "major",
					execution: sync ? "sync" : "async",
					...(reduce ? { flavor: "last-resort" } : {}),
				});
		}
	} catch {}
	return collector;
}

/**
 * Runs a full GC. `reduce`: also give up compiled code (idle processes).
 * `sync: false` only starts it (V8 marks concurrently and finishes in small
 * steps): for the daemon, where a stop-the-world collection on a loaded
 * machine stalls every request for hundreds of ms.
 */
export function fullGc(reduce = false, sync = true) {
	try {
		getCollector()?.(reduce, sync);
	} catch {
		collector = null;
	}
}

/**
 * Returns a function to call on activity: once things go quiet for `quietMs`,
 * one memory-reducing GC runs.
 */
export function idleCompactor(quietMs: number): () => void {
	let timer: NodeJS.Timeout | null = null;
	const run = () => {
		timer = null;
		fullGc(true);
	};
	return () => {
		if (timer) timer.refresh();
		else timer = setTimeout(run, quietMs).unref();
	};
}
