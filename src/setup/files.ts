import { execFileSync } from "node:child_process";
import {
	accessSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { ModificationOptions } from "jsonc-parser/lib/esm/main.js";

export type JsoncParser = typeof import("jsonc-parser/lib/esm/main.js");
let jsonc: JsoncParser | null = null;

/**
 * Hands this module the JSONC parser (see `loadJsonc` in jsonc.ts). Harness
 * drivers import this module, so it never imports the parser itself: the MCP
 * server, daemon and extension load the drivers but never edit configs.
 */
/**
 * Absolute path of a command on PATH (this process's, or `path`), or null
 * (setup's harness detection).
 */
export function which(
	cmd: string,
	path = process.env.PATH ?? "",
): string | null {
	for (const dir of path.split(delimiter)) {
		const full = join(dir, cmd);
		if (!dir) continue;
		try {
			accessSync(full, constants.X_OK);
			if (statSync(full).isFile()) return full;
		} catch {
			// Try the next PATH entry.
		}
	}
	return null;
}

/** True when a path exists (setup's harness detection). */
export function exists(path: string): boolean {
	return existsSync(path);
}

/** A folder's entries; [] when it is missing (setup). */
export function listDir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

export function useJsonc(parser: JsoncParser) {
	jsonc = parser;
}

function parser(): JsoncParser {
	if (!jsonc) throw new Error("setup: loadJsonc() must run first");
	return jsonc;
}

const FORMAT: ModificationOptions = {
	formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
};
const backedUp = new Set<string>();

/** Copies a file to `<file>.bak-pulsar-<timestamp>` once per run, before the first change. */
function backup(file: string): string | null {
	if (!existsSync(file) || backedUp.has(file)) return null;
	const stamp = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\..+/, "");
	const dest = `${file}.bak-pulsar-${stamp}`;
	copyFileSync(file, dest);
	backedUp.add(file);
	return dest;
}

export function readJsonc(file: string): unknown {
	if (!existsSync(file)) return undefined;
	return parser().parse(readFileSync(file, "utf8"), [], {
		allowTrailingComma: true,
	});
}

/** Reads a nested value, e.g. getPath(obj, ["mcpServers", "pulsar"]). */
export function getPath(value: unknown, path: string[]): unknown {
	let current = value;
	for (const key of path) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

/** Sets (or with `undefined`, removes) one key in a JSON/JSONC file, keeping comments and layout. */
export function editJson(file: string, path: string[], value: unknown) {
	const { applyEdits, modify, parse } = parser();
	const text = existsSync(file) ? readFileSync(file, "utf8") : "{}\n";
	if (
		value === undefined &&
		getPath(parse(text, [], { allowTrailingComma: true }), path) === undefined
	)
		return;
	backup(file);
	let next = applyEdits(text, modify(text, path, value, FORMAT));
	if (value === undefined) {
		// Removing our key can leave an empty parent we created ({"mcpServers": {}}); drop it too.
		for (let depth = path.length - 1; depth > 0; depth--) {
			const parentPath = path.slice(0, depth);
			const parent = getPath(
				parse(next, [], { allowTrailingComma: true }),
				parentPath,
			);
			if (
				!parent ||
				typeof parent !== "object" ||
				Object.keys(parent).length > 0
			)
				break;
			next = applyEdits(next, modify(next, parentPath, undefined, FORMAT));
		}
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, next);
}

/** Runs a harness CLI. Throws with its stderr on failure. */
export function runCli(cmd: string, args: string[]): string {
	return execFileSync(cmd, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
	});
}

export function tryCli(cmd: string, args: string[]): boolean {
	try {
		runCli(cmd, args);
		return true;
	} catch {
		return false;
	}
}

/** Sets `key = value` (value is raw TOML) inside one [section] of a TOML file. */
export function setTomlKey(
	file: string,
	section: string,
	key: string,
	value: string,
) {
	if (!existsSync(file)) return;
	const lines = readFileSync(file, "utf8").split("\n");
	const header = lines.findIndex((l) => l.trim() === `[${section}]`);
	if (header === -1) return;
	let end = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l));
	if (end === -1) end = lines.length;
	const keyPattern = new RegExp(
		`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`,
	);
	const existing = lines.findIndex(
		(l, i) => i > header && i < end && keyPattern.test(l),
	);
	const line = `${key} = ${value}`;
	if (existing !== -1) {
		if (lines[existing] === line) return;
		lines[existing] = line;
	} else lines.splice(header + 1, 0, line);
	backup(file);
	writeFileSync(file, lines.join("\n"));
}
