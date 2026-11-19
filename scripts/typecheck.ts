/**
 * Type-checks the four TypeScript projects at once (one tsc each) instead of
 * one after another. Prints each failing project's errors; exits 1 if any.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TSC = join(ROOT, "node_modules/.bin/tsc");
const PROJECTS = [
	"tsconfig.json",
	"test/tsconfig.json",
	"web/tsconfig.json",
	"web/tsconfig.node.json",
];

const results = await Promise.all(
	PROJECTS.map(
		(p) =>
			new Promise<{ project: string; ok: boolean; output: string }>(
				(resolve) => {
					const child = spawn(TSC, ["--noEmit", "-p", p], {
						cwd: ROOT,
						stdio: ["ignore", "pipe", "pipe"],
					});
					let output = "";
					child.stdout.on("data", (c) => (output += c));
					child.stderr.on("data", (c) => (output += c));
					child.on("close", (code) =>
						resolve({ project: p, ok: code === 0, output }),
					);
				},
			),
	),
);

let failed = false;
for (const r of results) {
	if (r.ok) continue;
	failed = true;
	console.log(`tsc -p ${r.project}:\n${r.output.trimEnd()}\n`);
}
process.exit(failed ? 1 : 0);
