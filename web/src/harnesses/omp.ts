import { type ComponentType, lazy } from "react";
import type { BodyProps } from "../session/tools/bodies.tsx";
import { lazyBody } from "./lazy.ts";
import type { HarnessUi } from "./types.ts";

type OmpBodies = typeof import("../session/tools/omp.tsx");

/** A body for omp's own result format (web/src/session/tools/omp.tsx). */
const ompBody = (
	name: "OmpReadBody" | "OmpGrepBody" | "OmpGlobBody",
): ComponentType<BodyProps> =>
	lazy(() =>
		import("../session/tools/omp.tsx").then((m: OmpBodies) => ({
			default: m[name],
		})),
	);

/** omp (oh-my-pi). */
export const omp: HarnessUi = {
	id: "omp",
	title(approval) {
		if (approval.tool === "ask") return "omp asks";
		if (approval.kind === "plan") return "Plan review";
		return null;
	},
	name: "omp",
	// Mark: the π of omp.sh's favicon (github.com/can1357/oh-my-pi, MIT),
	// drawn in one color.
	icon: {
		viewBox: "10 12 44 44",
		paths: ["M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z"],
	},
	toolCards: {
		bash: { Body: lazyBody("CommandBody") },
		// `path:10-40` selectors: the file, numbered from line 10.
		read: { Body: ompBody("OmpReadBody") },
		// Grouped matches (`## file`, `*12|text`) as files with their lines.
		grep: { Body: ompBody("OmpGrepBody") },
		// Grouped listings (`## dir/`) as paths.
		glob: { Body: ompBody("OmpGlobBody") },
		// Python/JS cells with their output and images.
		eval: { Body: lazyBody("CodeBody") },
		// Asks in HTML: shown as its plain intent, never as markup.
		ask: { Body: lazyBody("QuestionBody") },
		// A batch of subagent tasks.
		task: { kind: "task", Body: lazyBody("TaskBody") },
		// Phased checklists.
		todo: { Body: lazyBody("TodoBody") },
	},
};
