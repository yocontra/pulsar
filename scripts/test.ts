/**
 * Runs the bun test files in parallel: one `bun test <file>` process per
 * file, PULSAR_TEST_JOBS at a time (default: every core on CI, half of them
 * locally). `bun test` alone runs the files one after another in one process.
 *
 * Each file gets its own process, so files share no module state, env or
 * timers (under `bun test` they share one process); tests make
 * their own temp PULSAR_HOME and ports (test/helpers.ts).
 * Slow files start first, by the times of the last run (gitignored cache).
 * A failing file prints its whole output; the exit code is 1 if any failed.
 *
 *   bun scripts/test.ts                 # every test file
 *   bun scripts/test.ts test/http       # files whose path contains a filter
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CACHE = join(ROOT, ".cache/test-times.json");

const filters = process.argv.slice(2);
const files = [...new Bun.Glob("**/*.test.{ts,tsx}").scanSync({ cwd: ROOT })]
	.filter((f) => !/(^|\/)(node_modules|dist)\//.test(f))
	.filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
	.sort();
if (files.length === 0) {
	console.error(`no test files match ${filters.join(" ")}`);
	process.exit(1);
}

const cores = availableParallelism();
const jobs = Math.min(
	files.length,
	Math.max(
		1,
		Number(process.env.PULSAR_TEST_JOBS) ||
			(process.env.CI ? cores : Math.ceil(cores / 2)),
	),
);

let times: Record<string, number> = {};
try {
	times = JSON.parse(readFileSync(CACHE, "utf8"));
} catch {}
// Unknown files first (they may be slow), then the slowest known ones.
const weight = (f: string) => times[f] ?? 1e9 + statSync(join(ROOT, f)).size;
const queue = [...files].sort((a, b) => weight(b) - weight(a));

interface Result {
	file: string;
	ok: boolean;
	ms: number;
	pass: number;
	fail: number;
	skip: number;
	output: string;
}

function run(file: string): Promise<Result> {
	const start = performance.now();
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["test", `./${file}`], {
			cwd: ROOT,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		child.stdout.on("data", (c: Buffer) => chunks.push(c));
		child.stderr.on("data", (c: Buffer) => chunks.push(c));
		child.on("close", (code, signal) => {
			const output = Buffer.concat(chunks).toString("utf8");
			const count = (word: string) =>
				Number(output.match(new RegExp(`^\\s*(\\d+) ${word}$`, "m"))?.[1] ?? 0);
			resolve({
				file,
				ok: code === 0 && signal === null,
				ms: performance.now() - start,
				pass: count("pass"),
				fail: count("fail"),
				skip: count("skip"),
				output: signal ? `${output}\n(killed by ${signal})` : output,
			});
		});
	});
}

const started = performance.now();
const results: Result[] = [];
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

async function lane() {
	for (let file = queue.shift(); file; file = queue.shift()) {
		const r = await run(file);
		results.push(r);
		if (r.ok) console.log(`✓ ${file} ${r.pass} pass (${secs(r.ms)})`);
		else console.log(`✗ ${file} (${secs(r.ms)})\n${r.output.trimEnd()}\n`);
	}
}
await Promise.all(Array.from({ length: jobs }, lane));

if (filters.length === 0) {
	mkdirSync(dirname(CACHE), { recursive: true });
	writeFileSync(
		CACHE,
		JSON.stringify(
			Object.fromEntries(results.map((r) => [r.file, Math.round(r.ms)])),
		),
	);
}

const failed = results.filter((r) => !r.ok);
const sum = (k: "pass" | "fail" | "skip") =>
	results.reduce((n, r) => n + r[k], 0);
console.log(
	`\n${sum("pass")} pass, ${sum("skip")} skip, ${sum("fail")} fail across ${results.length} files, ${jobs} at a time (${secs(performance.now() - started)})`,
);
if (failed.length > 0) {
	console.log(`failed: ${failed.map((r) => r.file).join(", ")}`);
	process.exit(1);
}
