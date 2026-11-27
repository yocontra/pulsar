import { cpSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { editJson, getPath, readJsonc, tryCli } from "./files.ts";
import { removeShim } from "./shim.ts";

/** What setup knows when it plans: where the stable copy lives and which node runs it. */
export interface SetupContext {
	node: string;
	installDir: string;
	cli: string;
	skillSource: string;
	mcp: boolean;
	skillsDir: string | null;
}

/** A recorded change, enough to undo it later. */
export type Undo =
	| { type: "json"; file: string; path: string[] }
	| {
			type: "cli";
			cmd: string;
			args: string[];
			profile?: Record<string, string | null>;
	  }
	| { type: "dir"; path: string }
	/** Hook entries under `hooks.<event>` whose command contains `marker`. */
	| {
			type: "hook";
			file: string;
			event: string;
			marker: string;
			group?: string;
	  }
	/** The `pulsar` command on PATH; removed only if setup wrote it. */
	| { type: "shim"; path: string };

const profileKeys = {
	claude: ["CLAUDE_CONFIG_DIR"],
	codex: ["CODEX_HOME"],
	omp: ["OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"],
	pi: ["PI_CODING_AGENT_DIR"],
} as const;

/** Restore the CLI profile that setup changed even when uninstall runs in a different shell. */
export function cliUndo(cmd: keyof typeof profileKeys, args: string[]): Undo {
	return {
		type: "cli",
		cmd,
		args,
		profile: Object.fromEntries(
			profileKeys[cmd].map((key) => [key, process.env[key] ?? null]),
		),
	};
}

export interface Action {
	client: string;
	describe: string;
	apply: () => void;
	undo: Undo;
}

const home = homedir();

/** The stdio command that runs pulsar's MCP server from the stable copy. */
export const mcpCommand = (ctx: SetupContext) => ({
	command: ctx.node,
	args: [ctx.cli, "mcp"],
});

/** Sets one key in a JSON/JSONC config file. */
export function jsonAction(
	client: string,
	file: string,
	path: string[],
	value: unknown,
): Action {
	return {
		client,
		describe: `set ${path.join(".")} in ${file.replace(home, "~")}`,
		apply: () => editJson(file, path, value),
		undo: { type: "json", file, path },
	};
}

function skillAction(client: string, dest: string, ctx: SetupContext): Action {
	return {
		client,
		describe: `install skill to ${dest.replace(home, "~")}`,
		apply: () => {
			rmSync(dest, { recursive: true, force: true });
			cpSync(ctx.skillSource, dest, { recursive: true });
		},
		undo: { type: "dir", path: dest },
	};
}

/** Installs the skill into a harness's skills folder, unless `--skills-dir` picked a shared one. */
export function skillFor(
	client: string,
	defaultDir: string,
	ctx: SetupContext,
): Action[] {
	if (ctx.skillsDir) return [];
	return [skillAction(client, join(defaultDir, "pulsar"), ctx)];
}

type HookGroup = { matcher?: string; hooks?: { command?: string }[] };

/** The hook groups under `hooks.<event>`, without those whose command has `marker`. */
function otherHooks(file: string, event: string, marker: string): HookGroup[] {
	const list = getPath(readJsonc(file), ["hooks", event]);
	return (Array.isArray(list) ? (list as HookGroup[]) : []).filter(
		(g) => !g?.hooks?.some((h) => h?.command?.includes(marker)),
	);
}

/**
 * Adds one command hook to a Claude-style settings file (`hooks.<event>`),
 * replacing an older copy of the same hook and keeping every other hook.
 * Idempotent.
 */
export function addHook(
	file: string,
	event: string,
	marker: string,
	group: HookGroup & Record<string, unknown>,
) {
	editJson(file, ["hooks", event], [...otherHooks(file, event, marker), group]);
}

/** Removes the hook `addHook` added; drops `hooks.<event>` when nothing else is left. */
export function removeHook(file: string, event: string, marker: string) {
	const rest = otherHooks(file, event, marker);
	const list = getPath(readJsonc(file), ["hooks", event]);
	if (!Array.isArray(list) || list.length === rest.length) return;
	editJson(file, ["hooks", event], rest.length ? rest : undefined);
}

/** Edits one flat handler array in a named hooks.json group. */
export function updateNamedHook(
	file: string,
	group: string,
	event: string,
	marker: string,
	hook?: { type: "command"; command: string; timeout: number },
) {
	const settings = readJsonc(file, true);
	const record = (value: unknown) =>
		value !== null && typeof value === "object" && !Array.isArray(value);
	if (settings !== undefined && !record(settings))
		throw new Error(`Expected an object in ${file}`);
	const entry = getPath(settings, [group]);
	if (entry !== undefined && !record(entry))
		throw new Error(`Expected an object for ${group} in ${file}`);
	const path = [group, event];
	const existing = getPath(settings, path);
	if (existing !== undefined && !Array.isArray(existing))
		throw new Error(`Expected a handler list for ${group}.${event} in ${file}`);
	const handlers: unknown[] = existing ?? [];
	const installed: number[] = [];
	for (const [index, handler] of handlers.entries()) {
		const command = getPath(handler, ["command"]);
		if (typeof command === "string" && command.trimEnd().endsWith(marker))
			installed.push(index);
	}
	if (hook) {
		const primary = installed.shift();
		if (primary === undefined) {
			if (existing) editJson(file, [...path, -1], hook);
			else editJson(file, path, [hook]);
		} else if (JSON.stringify(handlers[primary]) !== JSON.stringify(hook)) {
			editJson(file, [...path, primary], hook);
		}
	}
	for (const index of installed.reverse())
		editJson(file, [...path, index], undefined);
}

export function undoAction(undo: Undo) {
	switch (undo.type) {
		case "json":
			editJson(undo.file, undo.path, undefined);
			return;
		case "cli": {
			const env = { ...process.env };
			// Older setup records used default locations and stored no profile.
			const defaults = profileKeys[undo.cmd as keyof typeof profileKeys] ?? [];
			for (const key of defaults) delete env[key];
			for (const [key, value] of Object.entries(undo.profile ?? {})) {
				if (value === null) delete env[key];
				else env[key] = value;
			}
			tryCli(undo.cmd, undo.args, env);
			return;
		}
		case "dir":
			rmSync(undo.path, { recursive: true, force: true });
			return;
		case "hook":
			if (undo.group)
				updateNamedHook(undo.file, undo.group, undo.event, undo.marker);
			else removeHook(undo.file, undo.event, undo.marker);
			return;
		case "shim":
			removeShim(undo.path);
			return;
	}
}
