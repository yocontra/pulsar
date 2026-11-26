import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { exec } from "../exec.ts";
import type { CommandEntry } from "../http/wire.ts";
import {
	projectDirs,
	readJson,
	skillFile,
	skillFilesIn,
} from "../service/catalog-files.ts";

type Skill = CommandEntry & { path: string };
type Scope = "user" | "project";
type Rule = { path?: string; include_only?: string[]; exclude?: string[] };

function allowed(skill: Skill, rule: Rule) {
	const folder = basename(dirname(skill.path));
	return (
		(!Array.isArray(rule.include_only) ||
			rule.include_only.includes(folder) ||
			rule.include_only.includes(skill.name)) &&
		!(
			Array.isArray(rule.exclude) &&
			(rule.exclude.includes(folder) || rule.exclude.includes(skill.name))
		)
	);
}

async function manifestSkills(
	path: string,
	base: string,
	home: string,
	source: Scope,
	cache: Map<string, Skill[]>,
	exclude: Set<string>,
): Promise<Skill[]> {
	const cached = cache.get(path);
	if (cached) return cached;
	if (cache.size >= 64) return [];
	const manifest = (await readJson(path)) as {
		entries?: Rule[];
		inherits?: Rule[];
		exclude?: string[];
	} | null;
	if (!manifest) return [];
	// An in-progress manifest resolves to no entries if it inherits itself.
	cache.set(path, []);
	if (Array.isArray(manifest.exclude))
		for (const name of manifest.exclude)
			if (typeof name === "string") exclude.add(name);
	const out: Skill[] = [];
	for (const key of ["entries", "inherits"] as const) {
		const rules = manifest[key];
		if (!Array.isArray(rules)) continue;
		for (const rule of rules.slice(0, 128)) {
			if (typeof rule?.path !== "string" || !rule.path) continue;
			const target = resolve(
				base,
				rule.path.startsWith("~/") ? join(home, rule.path.slice(2)) : rule.path,
			);
			if (key === "inherits") {
				const dir = dirname(target);
				const parent = [".agents", "_agents", ".agent", "_agent"].includes(
					basename(dir),
				)
					? dirname(dir)
					: dir;
				out.push(
					...(
						await manifestSkills(target, parent, home, source, cache, exclude)
					).filter((s) => allowed(s, rule)),
				);
			} else {
				const file =
					basename(target) === "SKILL.md" ? target : join(target, "SKILL.md");
				const found = await skillFile(file, source);
				const skills = found ? [found] : await skillFilesIn(target, source);
				out.push(...skills.filter((s) => allowed(s, rule)));
			}
		}
	}
	cache.set(path, out);
	return out;
}

/** Read the CLI's plugin inventory so disabled bundles stay out of the menu. */
async function pluginSkills(
	cwd: string | null,
	home: string,
): Promise<Skill[]> {
	const r = await exec("agy", ["plugin", "list", "--json"], {
		cwd: cwd ?? home,
		env: { ...process.env, HOME: home },
		timeoutMs: 3000,
		maxBuffer: 512 * 1024,
	});
	if (!r.ok) return [];
	let plugins: Array<{
		name?: string;
		path?: string;
		enabled?: boolean;
		skills?: string[];
	}>;
	try {
		plugins = JSON.parse(r.stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(plugins)) return [];
	const out: Skill[] = [];
	for (const p of plugins.slice(0, 128)) {
		if (
			!p?.enabled ||
			typeof p.name !== "string" ||
			typeof p.path !== "string" ||
			!isAbsolute(p.path) ||
			!Array.isArray(p.skills)
		)
			continue;
		for (const skill of await skillFilesIn(join(p.path, "skills"), "plugin", {
			plugin: p.name,
		})) {
			if (
				p.skills.includes(skill.name) ||
				p.skills.includes(basename(dirname(skill.path)))
			)
				out.push({ ...skill, name: `${p.name}:${skill.name}` });
		}
	}
	return out;
}

/** The first location wins for duplicate names, as in Antigravity's CLI skill picker. */
export async function antigravityCommands(
	cwd: string | null,
	home = homedir(),
): Promise<Skill[]> {
	const gemini = join(home, ".gemini");
	const direct = [
		...(await skillFilesIn(join(gemini, "antigravity-cli", "skills"), "user")),
		...(await skillFilesIn(join(gemini, "skills"), "user")),
	];
	const exclude = new Set<string>();
	const cache = new Map<string, Skill[]>();
	const scoped: Skill[] = [];
	const dirs = cwd ? await projectDirs(cwd, home) : [];
	const last = dirs.at(-1);
	const inRepo =
		last &&
		(await stat(join(last, ".git")).then(
			() => true,
			() => false,
		));
	for (const folder of inRepo ? dirs : dirs.slice(0, 1)) {
		for (const prefix of [".agents", "_agents", ".agent", "_agent"]) {
			const base = join(folder, prefix);
			scoped.push(
				...(await skillFilesIn(join(base, "skills"), "project")),
				...(await manifestSkills(
					join(base, "skills.json"),
					folder,
					home,
					"project",
					cache,
					exclude,
				)),
			);
		}
	}
	const config = join(gemini, "config");
	scoped.push(
		...(await skillFilesIn(join(config, "skills"), "user")),
		...(await manifestSkills(
			join(config, "skills.json"),
			config,
			home,
			"user",
			cache,
			exclude,
		)),
		...(await pluginSkills(cwd, home)),
		...(await skillFilesIn(
			join(gemini, "antigravity-cli", "builtin", "skills"),
			"builtin",
		)),
	);
	const commands = new Map<string, Skill>();
	for (const entry of [
		...direct,
		...scoped.filter(
			(s) => !exclude.has(s.name) && !exclude.has(basename(dirname(s.path))),
		),
	]) {
		if (
			/^[a-zA-Z0-9][\w.:-]{0,127}$/.test(entry.name) &&
			!commands.has(entry.name)
		)
			commands.set(entry.name, entry);
	}
	return [...commands.values()];
}

export function antigravitySkillPrompt(path: string, args: string): string {
	return `Read the installed Antigravity skill at ${JSON.stringify(path)} and follow its instructions.${args ? `\n\nUser request: ${args}` : ""}`;
}
