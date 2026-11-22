/** Plan usage limits in the app: wording and levels (no browser APIs; unit tested). */
import type {
	LimitSettings,
	LimitState,
	LimitWarning,
} from "../../api/types.ts";

export const DEFAULT_SETTINGS: LimitSettings = {
	enabled: true,
	thresholds: [80, 95],
};

/** "Mon 7:00 PM", or the time alone today. */
export function resetText(at: number | null, now = Date.now()): string | null {
	if (at === null) return null;
	const d = new Date(at);
	const time = d.toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
	if (new Date(now).toDateString() === d.toDateString())
		return `Resets ${time}`;
	const day = d.toLocaleDateString([], {
		weekday: "short",
		...(at - now > 6 * 86_400_000 ? { month: "short", day: "numeric" } : {}),
	});
	return `Resets ${day} ${time}`;
}

/** How far along a limit is: below the first threshold, past one, or reached. */
export type Level = "ok" | "near" | "high" | "reached";

export function levelOf(l: LimitState, thresholds: number[]): Level {
	if (l.reached) return "reached";
	const used = l.usedPercent ?? 0;
	const t = thresholds.length ? thresholds : DEFAULT_SETTINGS.thresholds;
	if (used >= t[t.length - 1]!) return "high";
	if (used >= t[0]!) return "near";
	return "ok";
}

/** "88% used" or "Limit reached". */
export function usedText(l: LimitState): string {
	return l.reached
		? "Limit reached"
		: `${Math.round(l.usedPercent ?? 0)}% used`;
}

/** The fullest limit at or past a threshold, for the session header. */
export function worst(
	limits: LimitState[],
	thresholds: number[],
): LimitState | null {
	let top: LimitState | null = null;
	for (const l of limits) {
		if (levelOf(l, thresholds) === "ok") continue;
		const v = l.reached ? 101 : (l.usedPercent ?? 0);
		const tv = top ? (top.reached ? 101 : (top.usedPercent ?? 0)) : -1;
		if (v > tv) top = l;
	}
	return top;
}

/** "80, 95" → [80, 95]; null when it is not 1 to 3 whole percents. */
export function parseThresholds(text: string): number[] | null {
	const parts = text
		.split(/[\s,%]+/)
		.filter(Boolean)
		.map(Number);
	if (parts.length < 1 || parts.length > 3) return null;
	if (parts.some((n) => !Number.isInteger(n) || n < 1 || n > 99)) return null;
	return [...new Set(parts)].sort((a, b) => a - b);
}

/** The lowercase window name inside a sentence ("weekly", "5-hour"). */
const inline = (label: string) =>
	label === "Usage" ? "usage" : label.charAt(0).toLowerCase() + label.slice(1);

/** "Codex is at 88% of its weekly limit" / "Claude Code hit its weekly limit". */
export function warningText(w: LimitWarning, who: string): string {
	if (w.reached) return `${who} hit its ${inline(w.label)} limit`;
	return `${who} is at ${Math.round(w.usedPercent ?? w.level)}% of its ${inline(w.label)} limit`;
}
