import { type ProcessInfo, processTable } from "../processes.ts";
import { claudeIdent } from "./claude-ident.ts";
import { codexIdent } from "./codex-ident.ts";
import { opencodeIdent } from "./opencode-ident.ts";
import {
	cursorIdent,
	geminiIdent,
	ompIdent,
	piIdent,
	vscodeIdent,
} from "./simple-ident.ts";
import type { HarnessIdent } from "./types.ts";

/**
 * Every harness's identity part, in DRIVERS order (lookups take the first
 * match). The MCP server, hook and extension use these instead of DRIVERS:
 * one MCP server runs per agent, and the full drivers bring scanning, push,
 * transcript parsing and setup code it never runs.
 */
export const IDENTS: readonly HarnessIdent[] = [
	claudeIdent,
	codexIdent,
	opencodeIdent,
	piIdent,
	ompIdent,
	cursorIdent,
	geminiIdent,
	vscodeIdent,
];

/** Harness ids with no driver: a plain terminal, and no harness found. */
export const PSEUDO_HARNESSES = ["cli", "unknown"] as const;

/** Every valid harness id: the drivers, then the pseudo-harnesses. */
export function harnessIds(): string[] {
	return [...IDENTS.map((d) => d.id), ...PSEUDO_HARNESSES];
}

export function identFor(id: string): HarnessIdent | null {
	return IDENTS.find((d) => d.id === id) ?? null;
}

/** The harness whose process a command line is, if any. */
export function identForProcess(args: string): HarnessIdent | null {
	return IDENTS.find((d) => d.matchProcess(args)) ?? null;
}

/** The harness hosting pulsar's extension, from the host process's argv. */
export function extensionHostFor(argv: string): HarnessIdent | null {
	return IDENTS.find((d) => d.extension?.isHost(argv)) ?? null;
}

/** Walks up from `pid` to the first process that is a known harness. */
export async function findHarnessAncestor(
	pid: number,
	given?: Map<number, ProcessInfo>,
): Promise<{ harness: string; pid: number } | null> {
	const table = given ?? (await processTable());
	let current = table.get(pid);
	for (let depth = 0; current && depth < 16; depth++) {
		const parent = table.get(current.ppid);
		if (!parent || parent.pid <= 1) return null;
		const found = identForProcess(parent.args);
		if (found) return { harness: found.id, pid: parent.pid };
		current = parent;
	}
	return null;
}
