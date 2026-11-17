import { cpSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { editJson, tryCli } from "./files.ts";

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
	| { type: "cli"; cmd: string; args: string[] }
	| { type: "dir"; path: string };

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

export function undoAction(undo: Undo) {
	switch (undo.type) {
		case "json":
			editJson(undo.file, undo.path, undefined);
			return;
		case "cli":
			tryCli(undo.cmd, undo.args);
			return;
		case "dir":
			rmSync(undo.path, { recursive: true, force: true });
			return;
	}
}
