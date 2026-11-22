/**
 * Brings one transcript event into view: loads older pages into the
 * transcript cache until it holds the event, asks the session view to show
 * it (`pulsar:show-event`, session/SessionView.tsx), then waits for its
 * element and scrolls to it. Matching words are marked with the CSS Custom
 * Highlight API, so React's DOM is never touched.
 */
import { keys } from "../../data/keys.ts";
import type { TranscriptData } from "../../data/patch.ts";
import { fetchEarlierTranscript } from "../../data/queries.ts";
import { queryClient } from "../../data/runtime.ts";

/** Older pages loaded at most to find one event (about 200 events each). */
const MAX_PAGES = 60;

function held(agentId: string): TranscriptData | undefined {
	return queryClient.getQueryData<TranscriptData>(keys.transcript(agentId));
}

/** Resolves when `check` holds after a cache change, or false after `ms`. */
function whenCache(check: () => boolean, ms: number): Promise<boolean> {
	if (check()) return Promise.resolve(true);
	return new Promise((resolve) => {
		const off = queryClient.getQueryCache().subscribe(() => {
			if (!check()) return;
			off();
			clearTimeout(t);
			resolve(true);
		});
		const t = setTimeout(() => {
			off();
			resolve(check());
		}, ms);
	});
}

/** Resolves with the element `find` returns once it is in `root`, or null after `ms`. */
function whenElement(
	root: Element,
	find: () => HTMLElement | null,
	ms: number,
): Promise<HTMLElement | null> {
	const now = find();
	if (now) return Promise.resolve(now);
	return new Promise((resolve) => {
		const obs = new MutationObserver(() => {
			const el = find();
			if (!el) return;
			obs.disconnect();
			clearTimeout(t);
			resolve(el);
		});
		obs.observe(root, { childList: true, subtree: true });
		const t = setTimeout(() => {
			obs.disconnect();
			resolve(find());
		}, ms);
	});
}

/** The element showing an event: its own block, else the message holding it. */
export function eventElement(
	root: Element,
	eventId: string,
): HTMLElement | null {
	const id = CSS.escape(eventId);
	// Most specific first: one selector list would return the turn before its block.
	for (const sel of [
		`[data-ev-id="${id}"]`,
		`[data-msg-id="${id}"]`,
		`[data-ev-ids~="${id}"]`,
	]) {
		const el = root.querySelector<HTMLElement>(sel);
		if (el) return el;
	}
	return null;
}

/**
 * Shows `eventId` of `agentId` in `root` (the session's section) and returns
 * its element, or null when the transcript does not hold it (any more).
 */
export async function reveal(
	root: Element,
	agentId: string,
	eventId: string,
	signal: AbortSignal,
): Promise<HTMLElement | null> {
	const has = () =>
		held(agentId)?.events.some((e) => e.id === eventId) ?? false;
	if (!(await whenCache(() => held(agentId) !== undefined, 10_000)))
		return null;
	for (let i = 0; !has() && i < MAX_PAGES; i++) {
		if (signal.aborted || !held(agentId)?.cursor) break;
		await fetchEarlierTranscript(queryClient, agentId);
	}
	if (signal.aborted || !has()) return null;
	dispatchEvent(
		new CustomEvent("pulsar:show-event", { detail: { agentId, eventId } }),
	);
	const el = await whenElement(root, () => eventElement(root, eventId), 3000);
	if (!el || signal.aborted) return null;
	// The conversation stops following its end, so new events don't pull it away.
	el.dispatchEvent(new CustomEvent("pulsar:stop-follow", { bubbles: true }));
	el.scrollIntoView({ block: "center" });
	pin(el, signal);
	return el;
}

/** The element that scrolls `el` (the conversation's scroll area). */
function scrollParent(el: HTMLElement): HTMLElement | null {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const y = getComputedStyle(p).overflowY;
		if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight)
			return p;
	}
	return null;
}

/** True when `el` is fully inside the scroller's visible box (or as much of it as fits). */
function inView(el: HTMLElement, scroller: HTMLElement): boolean {
	const r = el.getBoundingClientRect();
	const s = scroller.getBoundingClientRect();
	if (r.height >= s.height) return r.top < s.bottom && r.bottom > s.top;
	return r.top >= s.top && r.bottom <= s.bottom;
}

/** Keys that scroll a page: pressing one hands the scroll back to the operator. */
const SCROLL_KEYS = new Set([
	"ArrowUp",
	"ArrowDown",
	"PageUp",
	"PageDown",
	"Home",
	"End",
	" ",
]);

/**
 * Holds the current match on screen until the operator scrolls: the
 * conversation can still follow its end (use-stick-to-bottom), or images
 * and diagrams above the match can change height after the jump. On every
 * resize of the conversation and every scroll the operator didn't make, a
 * match out of the scroll area is brought back (and following stops again).
 * Wheel, touch, a scroll key or a press in the scroll area ends it, as does
 * `signal` (the match changed, or the find bar closed).
 */
function pin(el: HTMLElement, signal: AbortSignal) {
	const scroller = scrollParent(el);
	if (!scroller) return;
	let frame = 0;
	const check = () => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => {
			if (signal.aborted || !el.isConnected) return stop();
			if (inView(el, scroller)) return;
			el.dispatchEvent(
				new CustomEvent("pulsar:stop-follow", { bubbles: true }),
			);
			el.scrollIntoView({ block: "center" });
		});
	};
	const ro = new ResizeObserver(check);
	ro.observe(scroller);
	for (const child of scroller.children) ro.observe(child);
	ro.observe(el);
	const key = (e: KeyboardEvent) => {
		const t = e.target as HTMLElement | null;
		// Typing in the find bar (or any field) is not scrolling.
		if (t?.closest("input, textarea, [contenteditable]")) return;
		if (SCROLL_KEYS.has(e.key)) stop();
	};
	const stop = () => {
		cancelAnimationFrame(frame);
		ro.disconnect();
		scroller.removeEventListener("scroll", check);
		scroller.removeEventListener("wheel", stop);
		scroller.removeEventListener("touchstart", stop);
		scroller.removeEventListener("pointerdown", stop);
		removeEventListener("keydown", key, true);
		signal.removeEventListener("abort", stop);
	};
	scroller.addEventListener("scroll", check, { passive: true });
	scroller.addEventListener("wheel", stop, { passive: true });
	scroller.addEventListener("touchstart", stop, { passive: true });
	scroller.addEventListener("pointerdown", stop);
	addEventListener("keydown", key, true);
	signal.addEventListener("abort", stop);
	check();
}

// --------------------------------------------------------------- highlight

const ALL = "pulsar-find";
const CURRENT = "pulsar-find-current";

function escapeRe(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ranges of the query's words in `root`'s text. */
function wordRanges(
	root: Node,
	terms: string[],
	prefix: boolean,
	skip: Element | null,
): Range[] {
	if (terms.length === 0) return [];
	const last = terms.length - 1;
	const re = new RegExp(
		terms
			.map(
				(t, i) =>
					`(?<![\\p{L}\\p{N}])${escapeRe(t)}${prefix && i === last ? "[\\p{L}\\p{N}]*" : "(?![\\p{L}\\p{N}])"}`,
			)
			.join("|"),
		"giu",
	);
	const out: Range[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (skip?.contains(n)) continue;
		const text = n.nodeValue ?? "";
		for (const m of text.matchAll(re)) {
			const r = document.createRange();
			r.setStart(n, m.index);
			r.setEnd(n, m.index + m[0].length);
			out.push(r);
			if (out.length > 2000) return out;
		}
	}
	return out;
}

interface HighlightRegistry {
	set(name: string, h: unknown): void;
	delete(name: string): void;
}
const registry = (): HighlightRegistry | null =>
	(globalThis.CSS as unknown as { highlights?: HighlightRegistry })
		.highlights ?? null;
const HighlightCtor = (): (new (...r: Range[]) => unknown) | null =>
	(globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown })
		.Highlight ?? null;

/** Marks the words in `root`, and those in `current` more strongly. */
export function highlight(
	root: Element,
	current: Element | null,
	words: { terms: string[]; prefix: boolean },
	skip: Element | null,
) {
	// The block holding the current match (visible where highlights aren't painted).
	for (const el of root.querySelectorAll("[data-find-current]"))
		if (el !== current) el.removeAttribute("data-find-current");
	current?.setAttribute("data-find-current", "");
	const reg = registry();
	const H = HighlightCtor();
	if (!reg || !H) return;
	const all = wordRanges(root, words.terms, words.prefix, skip);
	reg.set(ALL, new H(...all));
	reg.set(
		CURRENT,
		new H(
			...(current ? all.filter((r) => current.contains(r.startContainer)) : []),
		),
	);
}

export function clearHighlight() {
	for (const el of document.querySelectorAll("[data-find-current]"))
		el.removeAttribute("data-find-current");
	const reg = registry();
	reg?.delete(ALL);
	reg?.delete(CURRENT);
}
