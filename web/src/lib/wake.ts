import type { Wake } from "../api/types.ts";
import { num } from "./format.ts";

/** A row's wake mark, as a short tag. */
export const WAKE_TAG: Record<Wake, string> = {
	wakes: "Wakes",
	"inbox-only": "Inbox only",
	held: "Held",
	refuses: "Refuses",
	queued: "Queued",
};

/** Why a message won't wake one agent, as a sentence fragment. */
export const WAKE_WHY: Record<Wake, string> = {
	wakes: "it wakes",
	"inbox-only": "it reads its inbox at its next turn",
	held: "it's holding its messages",
	refuses: "it refuses messages",
	queued: "its machine is offline",
};

const WAKE_ORDER: Wake[] = ["wakes", "inbox-only", "held", "refuses", "queued"];
const WAKE_COUNT: Record<Wake, (n: number) => string> = {
	wakes: (n) => `${num(n)} ${n === 1 ? "wakes" : "wake"} now`,
	"inbox-only": (n) => `${num(n)} inbox only`,
	held: (n) => `${num(n)} held`,
	refuses: (n) => `${num(n)} ${n === 1 ? "refuses" : "refuse"}`,
	queued: (n) => `${num(n)} queued`,
};

/** "40 wake now · 2 inbox only"; zero counts are left out. */
export function wakeSummary(counts: Partial<Record<string, number>>): string {
	return WAKE_ORDER.filter((k) => counts[k])
		.map((k) => WAKE_COUNT[k](counts[k]!))
		.join(" · ");
}
