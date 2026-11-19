/**
 * Prints the memory cost of pulsar's processes, from the built dist/:
 *
 *   bun run build && node scripts/mem-report.ts [--runtime node|bun|both]
 *
 * PULSAR_MEM_DIST=/path/to/dist measures another build (e.g. an older one).
 *
 * footprint is macOS's phys_footprint (RSS on Linux); heap is after a full
 * GC. Runs everything in a throwaway HOME; never touches a real daemon.
 */
import { parseArgs } from "node:util";
import {
	footprint,
	mb,
	measureExtension,
	measureHook,
	type Runtime,
	Sandbox,
	startDaemon,
	startMcp,
	type Usage,
} from "../test/mem-harness.ts";

const { values } = parseArgs({
	options: { runtime: { type: "string", default: "both" } },
});
const runtimes: Runtime[] =
	values.runtime === "both" ? ["node", "bun"] : [values.runtime as Runtime];

const row = (name: string, u: Usage, extra = "") =>
	console.log(
		`  ${name.padEnd(22)} footprint ${mb(u.footprint).padStart(9)}   heap ${mb(u.heapUsed).padStart(8)} / ${mb(u.heapTotal).padStart(8)}   external ${mb(u.external).padStart(7)}${extra}`,
	);

for (const runtime of runtimes) {
	console.log(`${runtime}:`);
	const box = new Sandbox();
	try {
		const daemon = await startDaemon(box, runtime);
		// The probe itself costs a few MB: the headline footprint is unprobed.
		const plain = await startMcp(box, runtime, {
			probe: false,
			session: "plain",
		});
		const mcp = await startMcp(box, runtime);
		await new Promise((r) => setTimeout(r, 1000));
		console.log(
			`  ${"mcp (fresh, no probe)".padEnd(22)} footprint ${mb(footprint(plain.child.pid as number)).padStart(9)}   start ${plain.startMs.toFixed(0)} ms`,
		);
		row(
			"mcp (fresh)",
			await box.usage(mcp.child),
			`   start ${mcp.startMs.toFixed(0)} ms`,
		);
		const ext = await measureExtension(box, runtime);
		row("extension host (bare)", ext.bare);
		row("extension host (+ext)", ext.loaded);
		console.log(
			`  ${"extension delta".padEnd(22)} footprint ${mb(ext.loaded.footprint - ext.bare.footprint).padStart(9)}   heap ${mb(ext.loaded.heapUsed - ext.bare.heapUsed).padStart(8)}`,
		);
		row("daemon", await box.usage(daemon));
		// An idle MCP server compacts 30 s after its last activity.
		await new Promise((r) => setTimeout(r, 40_000));
		console.log(
			`  ${"mcp (idle 40 s)".padEnd(22)} footprint ${mb(footprint(plain.child.pid as number)).padStart(9)}`,
		);
	} finally {
		await box.close();
	}
	const hook = await measureHook(runtime);
	console.log(
		`  ${"hook (no probe)".padEnd(22)} footprint ${mb(hook.plain).padStart(9)}`,
	);
	row("hook (blocked)", hook.usage, `   exit ${hook.exitMs.toFixed(0)} ms`);
}
