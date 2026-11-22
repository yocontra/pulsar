import type { AgentRow, ReceiptState, Rollup, Wake } from "../api/types.ts";

const nf = new Intl.NumberFormat();
export const num = (n: number) => nf.format(n);

const pr = new Intl.PluralRules("en");
/** The noun for a count: "machine" for 1, "machines" otherwise. */
export function noun(n: number, one: string, many = `${one}s`) {
	return pr.select(n) === "one" ? one : many;
}
/** "1 machine", "2,841 agents", "0 agents". Every count shown to people goes through this. */
export function plural(n: number, one: string, many = `${one}s`) {
	return `${num(n)} ${noun(n, one, many)}`;
}
/** "1 needs you", "3 need you". */
export const needYou = (n: number) =>
	`${num(n)} ${n === 1 ? "needs" : "need"} you`;

/**
 * A server- or agent-produced phrase shown on its own (a receipt detail, a
 * machine's reason, an error): first letter capitalized, the rest as written.
 */
export const sentence = (s: string) =>
	s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

/** Compact count for badges: 7, 99, "99+". */
export const badgeCount = (n: number, max = 99) =>
	n > max ? `${max}+` : num(n);

/**
 * Relative time for metadata: "now", "12s ago", "4 min ago", "3 h ago",
 * "yesterday", "Mon", "Mar 4". Ticks from the caller's clock (pass `now`).
 */
export function ago(ts: number, now = Date.now()) {
	const s = Math.max(0, Math.round((now - ts) / 1000));
	if (s < 5) return "now";
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} h ago`;
	const d = new Date(ts);
	const today = new Date(now);
	const days = Math.round(
		(new Date(today.toDateString()).getTime() -
			new Date(d.toDateString()).getTime()) /
			86_400_000,
	);
	if (days === 1) return "yesterday";
	if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
	return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** A duration for people: "0.4 s", "3.1 s", "48 s", "4 min", "1 h 20 min". */
export function duration(ms: number) {
	if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	const rest = m % 60;
	return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** A short state duration for rows: "40s", "12m", "3h", "2d". */
export const since = (ts: number, now = Date.now()) => age(ts, now);

/**
 * How long a state has held, for a status label: null under a minute (the
 * label is the bare state, never "Idle 0s"), then "1m", "3h", "2d".
 */
export function heldFor(ts: number | null | undefined, now = Date.now()) {
	return ts && now - ts >= 60_000 ? age(ts, now) : null;
}

/** A state with how long it has held: "Idle", "Idle 2m", "Done 3h". */
export function stateLabel(
	word: string,
	ts: number | null | undefined,
	now = Date.now(),
) {
	const held = heldFor(ts, now);
	return held ? `${word} ${held}` : word;
}

/** "12s", "4m", "3h", "2d". */
export function age(ts: number, now = Date.now()) {
	const s = Math.max(0, Math.round((now - ts) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

/** "04:12" timer. */
export function timer(since: number, now = Date.now()) {
	const s = Math.max(0, Math.floor((now - since) / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = String(s % 60).padStart(2, "0");
	return h
		? `${h}:${String(m).padStart(2, "0")}:${ss}`
		: `${String(m).padStart(2, "0")}:${ss}`;
}

export function clock(ts: number) {
	return new Date(ts).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** "fable-5.2" from "claude-fable-5-2"; "gpt-5.5" stays. */
export function shortModel(model: string | null) {
	if (!model) return "";
	const m = model.replace(/^claude-/, "");
	return m.replace(/-(\d+)-(\d+)$/, "-$1.$2");
}

export type Worst = "needs-you" | "busy" | "idle" | "offline" | "empty";
export function worst(r: Rollup): Worst {
	if (r.agents === 0) return "empty";
	if (r.needsYou) return "needs-you";
	if (r.busy) return "busy";
	if (r.idle) return "idle";
	return "offline";
}

export const WAKE_LABEL: Record<Wake, string> = {
	wakes: "Wakes",
	"inbox-only": "Inbox",
	held: "Held",
	refuses: "Refuses",
	queued: "Queued",
};

/** A wake mark adjusted for priority: "Don't wake" never wakes anyone. */
export function wakeFor(a: Pick<AgentRow, "wake">, priority: string): Wake {
	return a.wake === "wakes" && priority === "fyi" ? "inbox-only" : a.wake;
}

export const RECEIPT_WORDS: Record<ReceiptState, string> = {
	queued: "Waiting",
	sent: "Handed over",
	delivered: "In its conversation",
	read: "Read",
	replied: "Replied",
	held: "Held",
	refused: "Refused",
	failed: "Failed",
	acked: "Working on it",
	done: "Done",
	nacked: "Declined",
	expired: "Expired",
	dead: "Gave up",
	withdrawn: "Withdrawn",
};

/** The value of an agent's `key:value` tag (`pr`, `worktree`), or null. */
export function tagValue(tags: string[], key: string): string | null {
	const t = tags.find((t) => t.startsWith(`${key}:`));
	return t ? t.slice(key.length + 1) : null;
}

const NO_ROLLUP: Rollup = {
	agents: 0,
	needsYou: 0,
	busy: 0,
	idle: 0,
	offline: 0,
	lastActive: null,
};

/** A node's rollup; agent nodes have none. */
export function rollupOf(n: { rollup: Rollup | null }): Rollup {
	return n.rollup ?? NO_ROLLUP;
}

/** Agents by how a message would reach them. */
export function wakeTotals(rows: { wake: Wake }[]): Record<Wake, number> {
	const t: Record<Wake, number> = {
		wakes: 0,
		"inbox-only": 0,
		held: 0,
		refuses: 0,
		queued: 0,
	};
	for (const r of rows) t[r.wake]++;
	return t;
}

/** Status as a label for people: "Working", "Idle", "Needs you", "Offline". */
export const STATUS_LABEL: Record<AgentRow["state"], string> = {
	"needs-you": "Needs you",
	busy: "Working",
	idle: "Idle",
	offline: "Offline",
};
