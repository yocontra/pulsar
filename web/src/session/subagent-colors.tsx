import { createContext, lazy, Suspense, useContext } from "react";
import type { TranscriptEvent } from "../api/types.ts";
import { AgentMark } from "../ds/index.ts";
import {
	type AgentColor,
	type ColorRow,
	isAgentColor,
	nameKey,
	resolveColor,
} from "../lib/agent-color.ts";
import { peerFrom } from "./messages.ts";

/**
 * Subagent colors in a parent's conversation (lib/agent-color.ts): the
 * colors its teammate messages carried, and the parent whose subagent list
 * to read (set only when it has subagents, so a transcript without any, or
 * a test with no query client, never asks for the list). The list reader
 * (ListedDot.tsx) loads lazily: this renderer must not load the data layer.
 */
export interface SubagentColorScope {
	agentId: string | null;
	senders: ReadonlyMap<string, AgentColor>;
}

const EMPTY: ReadonlyMap<string, AgentColor> = new Map();

export const SubagentColors = createContext<SubagentColorScope>({
	agentId: null,
	senders: EMPTY,
});

/** The color each teammate message's sender carried, by `nameKey`. */
export function sendersOf(
	events: readonly TranscriptEvent[],
): ReadonlyMap<string, AgentColor> {
	let out: Map<string, AgentColor> | null = null;
	for (const ev of events) {
		const c = ev.notice?.color;
		if (!isAgentColor(c) || !ev.from) continue;
		out ??= new Map();
		out.set(nameKey(peerFrom(ev.from)), c);
	}
	return out ?? EMPTY;
}

/** What to mark: a subagent's name, the call that started it. */
export interface DotProps {
	name?: string | null;
	callId?: string | null;
	/**
	 * Mark only a name that is one of this parent's subagents or a teammate
	 * that wrote to it (a message's `to` may be anyone: `*`, a lead).
	 */
	knownOnly?: boolean;
	className?: string;
}

const ListedDot = lazy(() =>
	import("./ListedDot.tsx").then((m) => ({ default: m.ListedDot })),
);

/** The dot next to a subagent's name in its parent's conversation. */
export function SubagentDot(p: DotProps) {
	const scope = useContext(SubagentColors);
	const bare = (
		<AgentMark color={pickColor(p, scope)} className={p.className} />
	);
	return scope.agentId ? (
		<Suspense fallback={bare}>
			<ListedDot {...p} scope={scope} agentId={scope.agentId} />
		</Suspense>
	) : (
		bare
	);
}

export function pickColor(
	p: DotProps,
	scope: SubagentColorScope,
	rows?: ReadonlyArray<ColorRow>,
): AgentColor | null {
	if (p.knownOnly) {
		const key = p.name ? nameKey(p.name) : "";
		const listed =
			(p.callId && rows?.some((r) => r.callId === p.callId)) ||
			(key && rows?.some((r) => nameKey(r.name) === key));
		if (!listed && !(key && scope.senders.has(key))) return null;
	}
	return resolveColor(
		{ ...(rows ? { rows } : {}), senders: scope.senders },
		{ name: p.name ?? null, callId: p.callId ?? null },
	);
}
