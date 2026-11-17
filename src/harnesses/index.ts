import { processTable } from "../processes.ts";
import type { Agent } from "../types.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { gemini } from "./gemini.ts";
import { omp } from "./omp.ts";
import { opencode } from "./opencode.ts";
import { pi } from "./pi.ts";
import type { HarnessDriver } from "./types.ts";
import { vscode } from "./vscode.ts";

export type { HarnessDriver } from "./types.ts";

/**
 * Every harness pulsar knows. Adding a harness: write src/harnesses/<id>.ts
 * and list it here. Order is the order setup and doctor show them in, and
 * lookups take the first match: a new extension host goes before pi, whose
 * `isHost` accepts any process that is not omp.
 */
export const DRIVERS: HarnessDriver[] = [
	claude,
	codex,
	opencode,
	pi,
	omp,
	cursor,
	gemini,
	vscode,
];

/** Harness ids with no driver: a plain terminal, and no harness found. */
export const PSEUDO_HARNESSES = ["cli", "unknown"] as const;

/** Every valid harness id: the drivers, then the pseudo-harnesses. */
export function harnessIds(): string[] {
	return [...DRIVERS.map((d) => d.id), ...PSEUDO_HARNESSES];
}

export function driverFor(id: string): HarnessDriver | null {
	return DRIVERS.find((d) => d.id === id) ?? null;
}

/** The driver whose process a command line is, if any. */
export function driverForProcess(args: string): HarnessDriver | null {
	return DRIVERS.find((d) => d.matchProcess(args)) ?? null;
}

/** Walks up from `pid` to the first process that is a known harness. */
export function findHarnessAncestor(
	pid: number,
	table = processTable(),
): { harness: string; pid: number } | null {
	let current = table.get(pid);
	for (let depth = 0; current && depth < 16; depth++) {
		const parent = table.get(current.ppid);
		if (!parent || parent.pid <= 1) return null;
		const driver = driverForProcess(parent.args);
		if (driver) return { harness: driver.id, pid: parent.pid };
		current = parent;
	}
	return null;
}

/** The push path that reaches an agent from outside its session, if any. */
export function pushFor(agent: Agent): HarnessDriver["push"] | null {
	return DRIVERS.find((d) => d.push?.canPush(agent))?.push ?? null;
}

/** The harness hosting pulsar's extension, from the host process's argv. */
export function extensionHostFor(argv: string): HarnessDriver | null {
	return DRIVERS.find((d) => d.extension?.isHost(argv)) ?? null;
}

/** Drivers `pulsar setup` and `doctor` can configure, in registry order. */
export const CLIENTS = DRIVERS.flatMap((d) =>
	d.setup ? [{ id: d.id, label: d.label, ...d.setup }] : [],
);
