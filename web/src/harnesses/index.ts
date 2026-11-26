import { HARNESSES } from "../../../src/harnesses/catalog.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { gemini } from "./gemini.ts";
import { omp } from "./omp.ts";
import { opencode } from "./opencode.ts";
import { pi } from "./pi.ts";
import type { HarnessUi } from "./types.ts";
import { vscode } from "./vscode.ts";

export type {
	HarnessIcon,
	HarnessUi,
	ToolCard,
	ToolCardMap,
	ToolHeadProps,
} from "./types.ts";

/**
 * The app's harness adapters, one module per harness (like the daemon's
 * DRIVERS in src/harnesses/index.ts). Look one up with `harnessUi`.
 */
const custom: readonly HarnessUi[] = [
	claude,
	codex,
	omp,
	pi,
	opencode,
	cursor,
	gemini,
	vscode,
];

export const HARNESS_UI: readonly HarnessUi[] = HARNESSES.map((h) => ({
	name: h.label,
	id: h.id,
	icon: { symbol: h.id },
	...custom.find((ui) => ui.id === h.id),
}));

const byId = new Map(HARNESS_UI.map((h) => [h.id, h]));

/** The adapter for a harness id; an empty one for harnesses with none. */
export function harnessUi(id: string | null | undefined): HarnessUi {
	return (id && byId.get(id)) || { id: id ?? "unknown" };
}
