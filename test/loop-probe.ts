/**
 * Event-loop checks that hold on a loaded machine.
 *
 * Wall-clock gaps between timer ticks also count the time the OS took the CPU
 * away (the daemon's LagMonitor calls that "starved"), so on a machine at load
 * 150 a test asserting "no tick gap over 50 ms" fails with no JS at fault. CPU
 * time of the main JS thread counts only what ran on it: our code, and GC
 * pauses it caused. File reads on the I/O threads do not count.
 */

const threadCpuMs = (since?: NodeJS.CpuUsage) => {
	const u = process.threadCpuUsage(since);
	return (u.user + u.system) / 1000;
};

/**
 * Runs `fn` with a 5 ms timer ticking, and returns the most main-thread CPU
 * spent between two ticks: the longest the code kept the loop from running
 * anything else. `wallMs` is the longest gap by the clock, for messages only.
 */
export async function longestLoopBlock(
	fn: () => Promise<void>,
): Promise<{ cpuMs: number; wallMs: number }> {
	let cpuMs = 0;
	let wallMs = 0;
	let lastCpu = process.threadCpuUsage();
	let lastWall = performance.now();
	const mark = () => {
		cpuMs = Math.max(cpuMs, threadCpuMs(lastCpu));
		wallMs = Math.max(wallMs, performance.now() - lastWall);
		lastCpu = process.threadCpuUsage();
		lastWall = performance.now();
	};
	const probe = setInterval(mark, 5);
	try {
		await fn();
		mark();
	} finally {
		clearInterval(probe);
	}
	return { cpuMs, wallMs };
}

/**
 * Runs JS on this thread for `ms` of CPU time, however long the OS makes
 * that take: a synchronous job of known cost, on any machine.
 */
export function burnCpu(ms: number) {
	const start = process.threadCpuUsage();
	while (threadCpuMs(start) < ms) {}
}

/** Main-thread CPU ms `fn` takes (wall time also counts a loaded OS). */
export function cpuMsOf(fn: () => unknown) {
	const start = process.threadCpuUsage();
	fn();
	return threadCpuMs(start);
}

/** Waits until `cond` holds, polling every few ms; throws after `timeoutMs`. */
export async function until(
	cond: () => boolean,
	timeoutMs = 10_000,
	what = "condition",
) {
	const end = performance.now() + timeoutMs;
	while (!cond()) {
		if (performance.now() > end)
			throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}
