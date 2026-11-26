import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { exec } from "../exec.ts";
import { antigravityCommands } from "../harnesses/antigravity-commands.ts";
import { builtinsFor } from "../harnesses/builtins.ts";
import type { ApiResult } from "../harnesses/opencode-api.ts";
import type { CommandEntry, CommandSource } from "../http/wire.ts";
import { which } from "../setup/files.ts";
import type { Agent } from "../types.ts";
import {
	entries,
	frontmatter,
	MAX_ENTRIES,
	oneLine,
	projectDirs,
	readJson,
	readText,
	skillFilesIn,
} from "./catalog-files.ts";

export { frontmatter } from "./catalog-files.ts";

/**
 * The composer's `/` menu for one agent: its harness's built-in commands
 * (src/harnesses/builtins.ts), custom commands and prompts, and skills,
 * read where each harness reads them (read-only; nothing here writes):
 *
 * - Claude Code: `~/.claude/commands`, `<project>/.claude/commands`,
 *   `~/.claude/skills`, `<project>/.claude/skills`, and the skills and
 *   commands of enabled plugins (`plugin:name`).
 * - Codex: `~/.codex/prompts` (`prompts:name`), skills in `~/.codex/skills`,
 *   `~/.agents/skills` and `<project>/.agents/skills` (run as `$name`).
 * - OpenCode: its service's `GET /api/command` and `GET /api/skill`.
 * - pi, omp: what the pulsar extension reports (`pi.getCommands()`).
 *
 * Lists are cached per harness and folder for CACHE_MS.
 */

const CACHE_MS = 30_000;
const VERSION_MS = 10 * 60_000;

export interface CatalogPorts {
	home: () => string;
	opencode: (
		method: "GET" | "POST",
		path: string,
		body?: unknown,
	) => Promise<ApiResult>;
	/** The pulsar extension's `pi.getCommands()` answer; null without one. */
	extension: (agent: Agent) => Promise<Record<string, unknown> | null>;
	/** The installed CLI's version. */
	version: (harness: string) => Promise<string | null>;
	now: () => number;
}

const realPorts = (): Omit<CatalogPorts, "opencode" | "extension"> => {
	const versions = new Map<string, { at: number; v: Promise<string | null> }>();
	return {
		home: homedir,
		now: Date.now,
		version(harness) {
			const hit = versions.get(harness);
			if (hit && Date.now() - hit.at < VERSION_MS) return hit.v;
			const bin = which(harness === "antigravity" ? "agy" : harness);
			const v = bin
				? exec(bin, ["--version"], {
						timeoutMs: 4000,
						lane: "background",
					}).then((r) =>
						r.ok
							? (/\d+\.\d+(?:\.\d+)?/.exec(r.stdout || r.stderr || "")?.[0] ??
								null)
							: null,
					)
				: Promise.resolve(null);
			versions.set(harness, { at: Date.now(), v });
			return v;
		},
	};
};

export interface Listed {
	commands: CommandEntry[];
	stale: boolean;
}

export async function skillsIn(
	...args: Parameters<typeof skillFilesIn>
): Promise<CommandEntry[]> {
	return (await skillFilesIn(...args)).map(({ path: _, ...entry }) => entry);
}

/** Every `*.md` under `dir` (one level of subfolders too), as commands. */
export async function commandsIn(
	dir: string,
	source: CommandSource,
	opts: { prefix?: string; plugin?: string } = {},
): Promise<CommandEntry[]> {
	const out: CommandEntry[] = [];
	const add = async (file: string) => {
		const text = await readText(file);
		if (text === null) return;
		const fm = frontmatter(text);
		const body = text.replace(/^---[\s\S]*?\n---\s*/, "");
		out.push({
			name: `${opts.prefix ?? ""}${basename(file, ".md")}`,
			description: oneLine(
				fm.description || body.split("\n").find((l) => l.trim()),
			),
			source,
			...(fm["argument-hint"] ? { args: oneLine(fm["argument-hint"]) } : {}),
			...(opts.plugin ? { plugin: opts.plugin } : {}),
		});
	};
	for (const name of await entries(dir)) {
		const path = join(dir, name);
		if (name.endsWith(".md")) await add(path);
		else
			for (const sub of await entries(path))
				if (sub.endsWith(".md")) await add(join(path, sub));
	}
	return out;
}

/** Claude Code's enabled plugins and where each is installed. */
async function claudePlugins(
	home: string,
	cwd: string | null,
): Promise<Array<{ name: string; path: string }>> {
	const settings = (await readJson(join(home, ".claude", "settings.json"))) as {
		enabledPlugins?: Record<string, unknown>;
	} | null;
	const enabled = Object.entries(settings?.enabledPlugins ?? {})
		.filter(([, on]) => on === true)
		.map(([k]) => k);
	const installed = (await readJson(
		join(home, ".claude", "plugins", "installed_plugins.json"),
	)) as {
		plugins?: Record<
			string,
			Array<{ scope?: string; projectPath?: string; installPath?: string }>
		>;
	} | null;
	const out: Array<{ name: string; path: string }> = [];
	for (const key of enabled) {
		const installs = installed?.plugins?.[key] ?? [];
		const pick =
			installs.find(
				(i) =>
					i.scope === "project" &&
					cwd &&
					i.projectPath &&
					(cwd === i.projectPath || cwd.startsWith(i.projectPath + sep)),
			) ??
			installs.find((i) => i.scope === "user") ??
			installs[0];
		if (pick?.installPath)
			out.push({ name: key.split("@")[0]!, path: pick.installPath });
	}
	return out;
}

/** Later entries with a name already listed are dropped (built-ins win). */
function unique(list: CommandEntry[]): CommandEntry[] {
	const seen = new Set<string>();
	return list.filter((c) => {
		if (seen.has(c.name)) return false;
		seen.add(c.name);
		return true;
	});
}

export class Catalogs {
	private readonly ports: CatalogPorts;
	private cache = new Map<string, { at: number; listed: Promise<Listed> }>();
	private kinds: {
		at: number;
		v: Promise<{ commands: string[]; skills: Map<string, string> }>;
	} | null = null;

	constructor(
		ports: Partial<CatalogPorts> & Pick<CatalogPorts, "opencode" | "extension">,
	) {
		this.ports = { ...realPorts(), ...ports };
	}

	async antigravitySkills(agent: Agent) {
		const entries = await antigravityCommands(agent.cwd, this.ports.home());
		const reserved = new Set(
			builtinsFor("antigravity", null)?.commands.map((c) => c.name),
		);
		const names = new Set(entries.map((c) => c.name));
		return entries.map((entry) => {
			if (!reserved.has(entry.name)) return entry;
			let name = `skill:${entry.name}`;
			while (names.has(name)) name = `skill:${name}`;
			names.add(name);
			return { ...entry, name };
		});
	}

	list(agent: Agent): Promise<Listed> {
		// pi/omp answer for their own session; the others by folder.
		const key = `${agent.harness}\0${agent.harness === "pi" || agent.harness === "omp" ? agent.id : (agent.cwd ?? "")}`;
		const hit = this.cache.get(key);
		if (hit && this.ports.now() - hit.at < CACHE_MS) return hit.listed;
		if (this.cache.size > 200) this.cache.clear();
		const listed = this.build(agent).catch(() => ({
			commands: [],
			stale: false,
		}));
		this.cache.set(key, { at: this.ports.now(), listed });
		return listed;
	}

	private async build(agent: Agent): Promise<Listed> {
		const version = await this.ports.version(agent.harness).catch(() => null);
		const builtins = builtinsFor(agent.harness, version);
		const own: CommandEntry[] = (builtins?.commands ?? []).map((b) => ({
			name: b.name,
			description: b.description,
			source: "builtin",
			...(b.args ? { args: b.args } : {}),
			...(b.terminalOnly ? { terminalOnly: true } : {}),
			...(b.dialog ? { dialog: true } : {}),
		}));
		const home = this.ports.home();
		const extra = await this.custom(agent, home);
		return {
			commands: unique([...own, ...extra]),
			stale: builtins?.stale ?? false,
		};
	}

	private async custom(agent: Agent, home: string): Promise<CommandEntry[]> {
		if (agent.harness === "antigravity")
			return (await this.antigravitySkills(agent)).map(
				({ path: _, ...entry }) => entry,
			);
		const projects = agent.cwd ? await projectDirs(agent.cwd, home) : [];
		switch (agent.harness) {
			case "claude": {
				const out: CommandEntry[] = [];
				for (const p of projects) {
					out.push(
						...(await commandsIn(join(p, ".claude", "commands"), "project")),
					);
					out.push(
						...(await skillsIn(join(p, ".claude", "skills"), "project")),
					);
				}
				out.push(
					...(await commandsIn(join(home, ".claude", "commands"), "user")),
				);
				out.push(...(await skillsIn(join(home, ".claude", "skills"), "user")));
				for (const plugin of await claudePlugins(home, agent.cwd)) {
					const opts = { prefix: `${plugin.name}:`, plugin: plugin.name };
					out.push(
						...(await commandsIn(
							join(plugin.path, "commands"),
							"plugin",
							opts,
						)),
					);
					out.push(
						...(await skillsIn(join(plugin.path, "skills"), "plugin", opts)),
					);
				}
				return out;
			}
			case "codex": {
				const out = await commandsIn(join(home, ".codex", "prompts"), "user", {
					prefix: "prompts:",
				});
				for (const p of projects)
					out.push(
						...(await skillsIn(join(p, ".agents", "skills"), "project")),
					);
				out.push(...(await skillsIn(join(home, ".codex", "skills"), "user")));
				out.push(...(await skillsIn(join(home, ".agents", "skills"), "user")));
				return out;
			}
			case "opencode":
				return this.opencode(agent);
			case "pi":
			case "omp":
				return this.fromExtension(agent);
			default:
				return [];
		}
	}

	private async opencode(agent: Agent): Promise<CommandEntry[]> {
		const dir = agent.cwd ? `?directory=${encodeURIComponent(agent.cwd)}` : "";
		const [cmds, skills] = await Promise.all([
			this.ports.opencode("GET", `/api/command${dir}`),
			this.ports.opencode("GET", `/api/skill${dir}`),
		]);
		const sourceOf = (path: unknown): CommandSource =>
			typeof path === "string" &&
			agent.cwd &&
			!relative(agent.cwd, path).startsWith("..")
				? "project"
				: "user";
		const out: CommandEntry[] = [];
		for (const c of listOf(cmds))
			if (typeof c.name === "string")
				out.push({
					name: c.name,
					description: oneLine(String(c.description ?? "")),
					source: sourceOf(c.path ?? c.source),
				});
		for (const s of listOf(skills))
			if (typeof s.name === "string")
				out.push({
					name: s.name,
					description: oneLine(String(s.description ?? "")),
					source: sourceOf(s.path),
					skill: true,
				});
		return out;
	}

	/** OpenCode's server command names and skill ids by name (what its API runs). */
	opencodeKinds(): Promise<{
		commands: string[];
		skills: Map<string, string>;
	}> {
		if (this.kinds && this.ports.now() - this.kinds.at < CACHE_MS)
			return this.kinds.v;
		const v = (async () => {
			const [cmds, skills] = await Promise.all([
				this.ports.opencode("GET", "/api/command"),
				this.ports.opencode("GET", "/api/skill"),
			]);
			const commands = listOf(cmds)
				.map((c) => c.name)
				.filter((n): n is string => typeof n === "string");
			const byName = new Map<string, string>();
			for (const s of listOf(skills))
				if (typeof s.name === "string")
					byName.set(s.name, typeof s.id === "string" ? s.id : s.name);
			return { commands, skills: byName };
		})().catch(() => ({ commands: [], skills: new Map<string, string>() }));
		this.kinds = { at: this.ports.now(), v };
		return v;
	}

	private async fromExtension(agent: Agent): Promise<CommandEntry[]> {
		const r = await this.ports.extension(agent);
		const list = Array.isArray(r?.commands) ? (r.commands as unknown[]) : [];
		const out: CommandEntry[] = [];
		for (const raw of list.slice(0, MAX_ENTRIES)) {
			const c = raw as {
				name?: unknown;
				description?: unknown;
				source?: unknown;
				path?: unknown;
			};
			if (typeof c.name !== "string" || !/^[\w:.-]{1,128}$/.test(c.name))
				continue;
			const path = typeof c.path === "string" ? c.path : null;
			out.push({
				name: c.name,
				description: oneLine(
					typeof c.description === "string" ? c.description : "",
				),
				source:
					path && agent.cwd && !relative(agent.cwd, path).startsWith("..")
						? "project"
						: "user",
				...(c.source === "skill" ? { skill: true } : {}),
			});
		}
		return out;
	}
}

/** The rows of an OpenCode list answer (`{data: [...]}` or a bare array). */
function listOf(r: ApiResult): Array<Record<string, unknown>> {
	if (!r.ok) return [];
	const b = r.body as { data?: unknown } | unknown[] | null;
	const rows = Array.isArray(b)
		? b
		: Array.isArray((b as { data?: unknown })?.data)
			? (b as { data: unknown[] }).data
			: [];
	return rows.filter(
		(x): x is Record<string, unknown> => !!x && typeof x === "object",
	);
}
