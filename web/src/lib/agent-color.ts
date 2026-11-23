/**
 * One color per subagent, the same everywhere its name shows: the sidebar
 * and phone lists, its page header, its card in the parent's conversation,
 * a message sent to it, a message from it. No React here.
 *
 * The color is one of the eight Claude Code gives teammates. A subagent
 * the harness colored (a Claude teammate) keeps that color; any other one
 * gets a color hashed from its name. The name is the key because the chat
 * often knows only the name (a teammate message, `SendMessage` `to`). The
 * values are `--ds-agent-*` tokens (styles/tokens.css), at least 3:1
 * against every surface in light and dark; `[data-agent-color]` sets them.
 */
import type { NoticeColor } from "../api/types.ts";

export type AgentColor = NoticeColor;

/** The palette, in hash order. Same names as the daemon's `NOTICE_COLORS`. */
export const AGENT_COLORS = [
	"red",
	"blue",
	"green",
	"yellow",
	"purple",
	"orange",
	"pink",
	"cyan",
] as const satisfies readonly AgentColor[];

export function isAgentColor(v: unknown): v is AgentColor {
	return AGENT_COLORS.includes(v as AgentColor);
}

/** The hash key for a name: case and spacing don't make another agent. */
export function nameKey(name: string): string {
	return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** FNV-1a over UTF-16 code units: stable across runs, devices and builds. */
function fnv(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** A color from the name alone. */
export function hashedColor(name: string): AgentColor {
	return AGENT_COLORS[fnv(nameKey(name)) % AGENT_COLORS.length]!;
}

/**
 * A subagent's color: the harness's when it gave one, else hashed from the
 * name. Null without a name or a color (nothing to mark).
 */
export function agentColor(o: {
	color?: string | null;
	name?: string | null;
}): AgentColor | null {
	if (isAgentColor(o.color)) return o.color;
	const n = o.name?.trim();
	return n ? hashedColor(n) : null;
}

/** A subagent list row, as far as its color goes. */
export interface ColorRow {
	name: string;
	color?: string | null;
	callId?: string | null;
	state?: string;
	startedAt?: number;
}

/**
 * The row a name means: a name spawned again has several, and Claude may
 * color each spawn differently. The live one, else the newest.
 */
function rowNamed(
	rows: ReadonlyArray<ColorRow> | undefined,
	key: string,
): ColorRow | undefined {
	let best: ColorRow | undefined;
	const rank = (r: ColorRow) => (r.state && r.state !== "done" ? 1 : 0);
	for (const r of rows ?? []) {
		if (nameKey(r.name) !== key) continue;
		if (
			!best ||
			rank(r) > rank(best) ||
			(rank(r) === rank(best) && (r.startedAt ?? 0) > (best.startedAt ?? 0))
		)
			best = r;
	}
	return best;
}

/** What a parent knows about its subagents' colors. */
export interface ColorSources {
	/** Its subagent list (name, the harness's color, the call that started it). */
	rows?: ReadonlyArray<ColorRow>;
	/** Colors teammate messages in its transcript carried, by `nameKey`. */
	senders?: ReadonlyMap<string, AgentColor>;
}

/**
 * The color of a subagent its parent's conversation names: the row its
 * call started (`callId`) or the row with that name; the harness's color
 * from the row or from a teammate message; else hashed from the name.
 */
export function resolveColor(
	src: ColorSources,
	q: { name?: string | null; callId?: string | null },
): AgentColor | null {
	const byCall = q.callId
		? src.rows?.find((r) => r.callId === q.callId)
		: undefined;
	const key = q.name ? nameKey(q.name) : "";
	const row = byCall ?? (key ? rowNamed(src.rows, key) : undefined);
	const name = row?.name ?? q.name;
	if (!name?.trim()) return null;
	return agentColor({
		color: row?.color ?? src.senders?.get(nameKey(name)),
		name,
	});
}
