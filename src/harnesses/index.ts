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

export {
	extensionHostFor,
	findHarnessAncestor,
	harnessIds,
	PSEUDO_HARNESSES,
} from "./ident.ts";
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

export function driverFor(id: string): HarnessDriver | null {
	return DRIVERS.find((d) => d.id === id) ?? null;
}

/** The driver whose process a command line is, if any. */
export function driverForProcess(args: string): HarnessDriver | null {
	return DRIVERS.find((d) => d.matchProcess(args)) ?? null;
}

/** The push path that reaches an agent from outside its session, if any. */
export function pushFor(agent: Agent): HarnessDriver["push"] | null {
	return DRIVERS.find((d) => d.push?.canPush(agent))?.push ?? null;
}

/** Drivers `pulsar setup` and `doctor` can configure, in registry order. */
export const CLIENTS = DRIVERS.flatMap((d) =>
	d.setup ? [{ id: d.id, label: d.label, ...d.setup }] : [],
);
