import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../paths.ts";
import type { Undo } from "./actions.ts";

/** What `pulsar setup` and `pulsar mesh on` changed, so `--uninstall` can take it back. */
export interface SetupState {
	version: string;
	installDir: string;
	undo: Array<{ client: string; undo: Undo }>;
}

export function stateFile() {
	return join(stateDir(), "setup.json");
}

export function loadState(): SetupState | null {
	try {
		return JSON.parse(readFileSync(stateFile(), "utf8")) as SetupState;
	} catch {
		return null;
	}
}

export function saveState(state: SetupState) {
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
}
