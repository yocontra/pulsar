import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CommandEntry, CommandSource } from "../http/wire.ts";

export const MAX_ENTRIES = 500;
const MAX_FILE = 64 * 1024;

/** A SKILL.md or command file's front matter: flat `key: value` pairs. */
export function frontmatter(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!text.startsWith("---")) return out;
	const end = text.indexOf("\n---", 3);
	if (end < 0) return out;
	const lines = text.slice(text.indexOf("\n") + 1, end).split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
		if (!m) continue;
		let value = m[2]!.trim();
		if (
			value === "" ||
			value === ">" ||
			value === "|" ||
			/^[>|][-+]?$/.test(value)
		) {
			// A block value: the indented lines under the key.
			const block: string[] = [];
			while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!))
				block.push(lines[++i]!.trim());
			value = block.join(value.startsWith("|") ? "\n" : " ");
		}
		if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
		out[m[1]!.toLowerCase()] = value;
	}
	return out;
}

/** The first sentence-ish line of a description, for one menu row. */
export function oneLine(s: string | undefined): string {
	const t = (s ?? "").replace(/\s+/g, " ").trim();
	return t.length > 200 ? `${t.slice(0, 197)}…` : t;
}

export async function readText(path: string): Promise<string | null> {
	try {
		const s = await stat(path);
		if (!s.isFile()) return null;
		const file = await open(path, "r");
		try {
			const buf = Buffer.alloc(Math.min(s.size, MAX_FILE));
			const { bytesRead } = await file.read(buf, 0, buf.length, 0);
			return buf.toString("utf8", 0, bytesRead);
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}

export async function entries(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).slice(0, MAX_ENTRIES);
	} catch {
		return [];
	}
}

/** Every `<dir>/<name>/SKILL.md`, as menu entries. */
export async function skillFilesIn(
	dir: string,
	source: CommandSource,
	opts: { prefix?: string; plugin?: string } = {},
): Promise<Array<CommandEntry & { path: string }>> {
	const out: Array<CommandEntry & { path: string }> = [];
	for (const name of await entries(dir)) {
		const path = join(dir, name, "SKILL.md");
		const skill = await skillFile(path, source, opts);
		if (skill) out.push(skill);
	}
	return out;
}

export async function skillFile(
	path: string,
	source: CommandSource,
	opts: { prefix?: string; plugin?: string } = {},
): Promise<(CommandEntry & { path: string }) | null> {
	const text = await readText(path);
	if (text === null) return null;
	const fm = frontmatter(text);
	// A skill the person never invokes by name stays out of the menu.
	if (fm["user-invocable"] === "false") return null;
	const own =
		fm.name && /^[\w:.-]{1,128}$/.test(fm.name)
			? fm.name
			: basename(dirname(path));
	return {
		path,
		name: `${opts.prefix ?? ""}${own}`,
		description: oneLine(fm.description),
		source,
		skill: true,
		...(fm["argument-hint"] ? { args: oneLine(fm["argument-hint"]) } : {}),
		...(opts.plugin ? { plugin: opts.plugin } : {}),
	};
}

/** The folders from `cwd` up to its repo root (or home), nearest first. */
export async function projectDirs(
	cwd: string,
	home: string,
): Promise<string[]> {
	const out: string[] = [];
	let dir = cwd;
	for (let i = 0; i < 12; i++) {
		if (dir === home) break;
		out.push(dir);
		try {
			await stat(join(dir, ".git"));
			break;
		} catch {}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return out;
}

export async function readJson(path: string): Promise<unknown> {
	const text = await readText(path);
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
