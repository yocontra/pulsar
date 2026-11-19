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
	await keepInView(el, signal);
	return el;
}

/** How long a landed match is held on screen while the view settles. */
const SETTLE_MS = 800;

/**
 * A session that just opened still scrolls itself to its end (and media
 * above may still load): for a moment, bring the match back if the view
 * moves it away. Any input from the operator ends this at once.
 */
function keepInView(el: HTMLElement, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const until = performance.now() + SETTLE_MS;
		let frame = 0;
		const stop = () => {
			cancelAnimationFrame(frame);
			for (const t of INPUT) removeEventListener(t, stop, true);
			resolve();
		};
		const INPUT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
		for (const t of INPUT) addEventListener(t, stop, true);
		const tick = () => {
			if (signal.aborted || !el.isConnected || performance.now() > until)
				return stop();
			const r = el.getBoundingClientRect();
			if (r.bottom < 0 || r.top > innerHeight)
				el.scrollIntoView({ block: "center" });
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
	});
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
