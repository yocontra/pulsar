/**
 * The processes that run per agent or per prompt load only what they need:
 * one MCP server runs per agent session, the extension runs inside pi/omp,
 * and the hook starts on every permission prompt. This walks their static
 * imports (dynamic `import()` and `import type` load nothing up front) and
 * fails when something heavy creeps back in.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

/** Static value imports of a module: `import x from`, `export … from`, side effects. */
function staticImports(file: string): string[] {
	const text = readFileSync(file, "utf8");
	const out: string[] = [];
	const re =
		/^\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm;
	for (const m of text.matchAll(re)) {
		if (m[1]) continue;
		// `import { type A, type B } from` is erased too.
		const clause = /^\s*(?:import|export)\s+\{([^}]*)\}/.exec(m[0])?.[1];
		if (
			clause
				?.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
				.every((s) => s.startsWith("type "))
		)
			continue;
		out.push(m[2] as string);
	}
	return out;
}

/** Every module (and package or builtin) loaded at start from `entry`. */
function graph(entry: string): Set<string> {
	const seen = new Set<string>();
	const walk = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		if (!file.startsWith("/")) return;
		for (const spec of staticImports(file))
			walk(spec.startsWith(".") ? resolve(dirname(file), spec) : spec);
	};
	walk(join(SRC, entry));
	return seen;
}

const rel = (s: string) => (s.startsWith(SRC) ? s.slice(SRC.length + 1) : s);

const FORBIDDEN = [
	/^zod/,
	/^@modelcontextprotocol\//,
	/^hono/,
	/^node:crypto$/,
	/^node:sqlite$/,
	/^setup\//,
	/^transcripts\//,
	/^service\//,
	/^federation\//,
	/^http\//,
	/-transcript\.ts$/,
	/codex-rpc\.ts$/,
	/claude-approvals\.ts$/,
	/^harnesses\/index\.ts$/,
	/^harnesses\/(claude|codex|opencode|pi|omp|cursor|antigravity|vscode)\.ts$/,
	/^store\.ts$/,
];

describe("startup import graphs", () => {
	for (const entry of ["cli.ts", "mcp.ts", "extension.ts", "hook.ts"])
		test(`${entry} loads nothing heavy`, () => {
			const loaded = [...graph(entry)].map(rel);
			const bad = loaded.filter((m) => FORBIDDEN.some((re) => re.test(m)));
			expect(bad).toEqual([]);
		});

	test("the hook stays tiny", () => {
		const loaded = [...graph("hook.ts")]
			.map(rel)
			.filter((m) => m.endsWith(".ts"));
		expect(loaded.sort()).toEqual([
			"hook.ts",
			"lazy.ts",
			"paths.ts",
			"rpc.ts",
			"types.ts",
		]);
	});
});
