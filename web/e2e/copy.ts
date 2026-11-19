import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

/**
 * Copy mistakes a person would notice, in what a screen shows (salvaged
 * from pool-ui-polish). Shared by the phone, desktop and conversation tests:
 * `await expectCleanCopy(page, "home", "#app")`.
 */
export const COPY_MISTAKES: [RegExp, string][] = [
	[
		/(?<![\d,.])1 (machines|agents|projects|passkeys|browsers|matches|replies|non-repliers|offline machines|need you|steps|lines|files)\b/,
		"singular count with a plural noun",
	],
	[/\.\.\./, "three dots instead of …"],
	[
		/\b(needs-you|inbox-only|input-available|output-available)\b/,
		"raw enum value",
	],
	[/\b(wakes|inbox|held|refuses|queued) \d/, "label-then-number wake count"],
	[/\b(claude|codex|opencode|pi|omp):[0-9a-f]{6,}/, "raw agent id"],
	[/\bm_[a-z0-9]{10,}/, "raw message id"],
	[/\b(undefined|NaN|null)\b|\[object Object\]/, "leaked JS value"],
	[/\boffline \(\d+\)/, "raw error detail"],
	[
		/\b(your|the|a) user\b|\bas the user\b/i,
		"the human running the agents is the operator, not the user",
	],
];

/**
 * The rendered text of every element matching `root` (spaces between
 * elements, as a person reads it). Point it at app copy, not at text agents
 * wrote: agent output may legitimately hold "..." or "null".
 */
export async function screenText(page: Page, root = "body") {
	const parts = await page.locator(root).evaluateAll((els) =>
		els.map(
			// biome-ignore lint/performance/useDomNodeTextContent: the rendered text is what a person reads.
			(el) => (el as HTMLElement).innerText,
		),
	);
	return parts.join("\n");
}

export async function expectCleanCopy(
	page: Page,
	where: string,
	root = "body",
) {
	const text = await screenText(page, root);
	for (const [re, what] of COPY_MISTAKES) {
		const m = text.match(re);
		expect.soft(m?.[0] ?? null, `${where}: ${what}`).toBeNull();
	}
}
