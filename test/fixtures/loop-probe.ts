/**
 * Measures a daemon's responsiveness from outside its process: every 50 ms a
 * socket `status` and an HTTP `GET /api/v1/hello`, each timed from when it was
 * due (so a stalled daemon counts its whole stall). Prints JSON latencies
 * and this process's own event-loop delay as a control.
 * Usage: bun loop-probe.ts <http port> <duration ms>   (PULSAR_HOME names the daemon)
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DaemonClient } from "../../src/client.ts";
import { PROTOCOL_VERSION } from "../../src/types.ts";

const [port, duration] = process.argv.slice(2).map(Number);
const client = await new DaemonClient().connect(false);
// No call timeouts: a stalled daemon must show up as a long sample.
const helloStart = performance.now();
await client.call(
	"hello",
	{ protocol: PROTOCOL_VERSION, registration: { role: "cli" } },
	0,
);
const helloMs = performance.now() - helloStart;
// This process's own loop delay: what the OS alone costs a nearly idle process.
const control = monitorEventLoopDelay({ resolution: 10 });
control.enable();
const socketMs: number[] = [];
const httpMs: number[] = [];
const start = performance.now();
let due = start;
while (performance.now() - start < (duration ?? 5000)) {
	const t = Math.min(due, performance.now());
	await client.call("status", {}, 0);
	socketMs.push(performance.now() - t);
	const h = performance.now();
	await (await fetch(`http://127.0.0.1:${port}/api/v1/hello`)).arrayBuffer();
	httpMs.push(performance.now() - h);
	due += 50;
	const wait = due - performance.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	else due = performance.now();
}
client.close();
control.disable();
const controlP99 = control.percentile(99) / 1e6;
console.log(JSON.stringify({ helloMs, socketMs, httpMs, controlP99 }));
