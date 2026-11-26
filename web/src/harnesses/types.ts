import type { ComponentType, ReactNode } from "react";
import type { ToolKind } from "../../../src/transcripts/describe.ts";
import type { Approval } from "../api/types.ts";
import type { RendererMap } from "../interactions/types.ts";
import type { BodyProps } from "../session/tools/bodies.tsx";

/**
 * The app's side of a harness adapter, mirroring the daemon's
 * `HarnessDriver` (src/harnesses/types.ts): one module per harness in
 * web/src/harnesses/, every member optional. Shared defaults apply where a
 * harness says nothing. (The interactions agent adds `interactions` and
 * `title` to this same interface.)
 */
export interface HarnessUi {
	/** The daemon driver's id (`claude`, `omp`, …). */
	id: string;
	/** Display name ("Claude Code"). */
	name?: string;
	/** The harness's mark, drawn in `currentColor` (see HarnessGlyph). */
	icon?: HarnessIcon;
	/**
	 * Tool cards this harness renders its own way, by exact tool name. The
	 * card uses the entry's `kind` (icon, verb, card class) and `Body` (the
	 * expanded view; may be React.lazy) over the shared defaults.
	 */
	toolCards?: ToolCardMap;
	/**
	 * Renderers for interaction kinds (question, plan, …) that need a
	 * bespoke look in this harness; defaults in web/src/interactions/.
	 */
	interactions?: RendererMap;
	/** The interaction card's title ("Claude asks", "Plan review"). */
	title?(approval: Approval): string | null;
}

/**
 * A mark as SVG path data. Filled marks come from their owners' published
 * logos (nominative use: they identify the harness an agent runs in);
 * `stroke` marks are drawn for harnesses with no usable logo.
 */
export type HarnessIcon =
	| { symbol: string }
	| {
			viewBox: string;
			paths: readonly string[];
			/** Draw the paths as 2 px strokes (round caps) instead of filling them. */
			stroke?: boolean;
			/** Even-odd fill for marks with holes. */
			evenOdd?: boolean;
	  };

export interface ToolCard {
	kind?: ToolKind;
	Body?: ComponentType<BodyProps>;
	/** The head's verb, target and facts, drawn instead of the shared line. */
	Head?: ComponentType<ToolHeadProps>;
	/** The head's icon, instead of the kind's. */
	icon?: ReactNode;
	/** An extra class on the card. */
	className?: string;
}

/** What a bespoke head (`ToolCard.Head`) gets: the call, its result, how long it took. */
export interface ToolHeadProps {
	name: string;
	input: unknown;
	output: string;
	isError: boolean;
	done: boolean;
	/** From the call to its result, when both are known. */
	ms?: number;
	/** Set when the call was denied or stopped: what to show instead of facts. */
	stateFacts?: string[];
}

export type ToolCardMap = Readonly<Record<string, ToolCard>>;
