import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The MCP server, the daemon (on demand and as a service), the extension and
 * the hook never block their event loop on a child process or the disk: no
 * sync child-process or fs call anywhere they can reach. This walks every
 * module they import (statically or with `import()`) and fails on any such
 * call, unless the line (or the one above it) says `sync-ok: <why>`, which
 * is only for code that runs from CLI commands (setup, doctor, `pulsar
 * mesh`). Modules that only those commands run are listed below with why.
 */

const SRC = join(import.meta.dir, "..", "src");

const ENTRIES = [
	"mcp.ts", // pulsar mcp
	"run-daemon.ts", // pulsar daemon [--service]
	"daemon.ts",
	"extension.ts", // pi / omp extension
	"hook.ts", // pulsar hook claude-permission
];

/** Runtime-reachable modules that hold CLI-only code, and why that is safe. */
const CLI_ONLY: Record<string, string> = {
	"setup/files.ts":
		"drivers' `setup` sections (detect, configured, plan): run by `pulsar setup` and doctor only",
	"setup/actions.ts": "setup plans and undo records: `pulsar setup` only",
	"setup/shim.ts":
		"the `pulsar` command shim: setup and `--uninstall` only (via setup/actions.ts)",
	"setup/service.ts":
		"install, remove and status run from `pulsar setup` and doctor; the daemon calls only serviceInstalledAsync and startService, which are async",
};

const SYNC_API =
	/\b(execFileSync|spawnSync|execSync|readFileSync|writeFileSync|appendFileSync|existsSync|statSync|lstatSync|fstatSync|readdirSync|mkdirSync|mkdtempSync|openSync|readSync|writeSync|closeSync|unlinkSync|renameSync|chmodSync|chownSync|rmSync|rmdirSync|realpathSync|accessSync|copyFileSync|readlinkSync|symlinkSync|truncateSync|ftruncateSync|fsyncSync|utimesSync|opendirSync|cpSync)\s*\(/;

const IMPORT =
	/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function imports(file: string): string[] {
	const text = readFileSync(file, "utf8");
	const out: string[] = [];
	for (const m of text.matchAll(IMPORT)) {
		const spec = m[1] ?? m[2];
		if (!spec?.startsWith(".")) continue;
		const path = resolve(dirname(file), spec);
		if (existsSync(path)) out.push(path);
	}
	return out;
}

/** Every module the entries reach, as paths relative to src/. */
function runtimeModules(): string[] {
	const seen = new Set<string>();
	const stack = ENTRIES.map((e) => join(SRC, e));
	while (stack.length) {
		const file = stack.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		stack.push(...imports(file));
	}
	return [...seen].map((f) => relative(SRC, f)).sort();
}

/** Sync calls in a source text that carry no `sync-ok:` reason. */
export function unmarkedSyncCalls(text: string): string[] {
	const lines = text.split("\n");
	const found: string[] = [];
	lines.forEach((line, i) => {
		const code = line.replace(/\/\/.*$/, "");
		if (/^\s*(\*|\/\*)/.test(line) || !SYNC_API.test(code)) return;
		if (/sync-ok:/.test(line) || /sync-ok:/.test(lines[i - 1] ?? "")) return;
		found.push(`${i + 1}: ${line.trim()}`);
	});
	return found;
}

describe("no sync I/O on the runtime paths", () => {
	test("the scanner finds an unmarked call and accepts a marked one", () => {
		expect(
			unmarkedSyncCalls('const a = readFileSync(p, "utf8");'),
		).toHaveLength(1);
		expect(
			unmarkedSyncCalls(
				'// sync-ok: CLI only\nconst a = readFileSync(p, "utf8");',
			),
		).toHaveLength(0);
		expect(unmarkedSyncCalls("// readFileSync(p) in a comment")).toHaveLength(
			0,
		);
		expect(unmarkedSyncCalls("new DatabaseSync(path)")).toHaveLength(0);
	});

	test("the MCP server, daemon, extension and hook modules make no sync calls", () => {
		const modules = runtimeModules();
		// The walk really covers them (a broken import pattern would pass vacuously).
		for (const m of [
			"mcp.ts",
			"service/registry.ts",
			"transcripts/tailer.ts",
			"transport/http.ts",
			"harnesses/claude.ts",
			// The interaction polls (every 1.5-2 s): rollouts and process tables.
			"service/server-interactions.ts",
			"harnesses/codex-interactions.ts",
			"harnesses/codex-status.ts",
			"harnesses/opencode-interactions.ts",
			"processes.ts",
		])
			expect(modules).toContain(m);
		const offenders: string[] = [];
		for (const m of modules) {
			if (CLI_ONLY[m]) continue;
			const calls = unmarkedSyncCalls(readFileSync(join(SRC, m), "utf8"));
			for (const c of calls) offenders.push(`src/${m}:${c}`);
		}
		expect(offenders).toEqual([]);
	});

	test("every CLI-only exception is still reachable (no stale entries)", () => {
		const modules = new Set(runtimeModules());
		for (const m of Object.keys(CLI_ONLY)) expect(modules.has(m)).toBe(true);
	});
});
