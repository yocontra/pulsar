import type { Page } from "@playwright/test";
import { agentId, expect, test } from "./fixtures.ts";

/**
 * The phone conversation never scrolls sideways (iPhone mini and narrower):
 * wide content (code, tables, diagrams, math, diffs) scrolls or fits in its own box
 * and text, links and paths wrap. A tool card's head shrinks its verb and
 * facts instead of pushing its chevron out of the card.
 */

const WIDTHS = [375, 320];

/**
 * Long unbroken text in every place Markdown puts it, plus wide blocks;
 * `tag` sets one run's lines apart (they stay in the worker's mock).
 */
const wide = (tag: string) =>
	[
		"https://example.com/a/really/long/url/that/keeps/going/without/any/break/points/at/all?with=query&params=thatarealsolong#and-a-fragment",
		"",
		`/Users/someone/Projects/pulsar/web/src/features/git/components/really-long-component-name/AnotherVeryLongFileNameWithoutBreaks.tsx and ${tag}_Supercalifragilisticexpialidocious_Supercalifragilisticexpialidocious_Supercalifragilisticexpialidocious`,
		"",
		"Inline: `const reallyLongIdentifierName = someObject.withAVeryLongPropertyChain.andAnotherOne.andYetAnotherVeryLongOne()`",
		"",
		"[https://github.com/someone/some-repository-with-a-long-name/pull/123456789/files#diff-abcdef0123456789abcdef](https://github.com/someone/some-repository-with-a-long-name/pull/123456789/files#diff-abcdef0123456789abcdef)",
		"",
		"| column one | column two | column three | column four | column five | column six |",
		"| --- | --- | --- | --- | --- | --- |",
		"| some-long-cell-value-without-spaces | another-long-cell-value | 1234567890 | x | y | https://example.com/long/url/in/a/table/cell |",
		"",
		"```sh",
		"bun x some-very-long-command --with-a-flag=value --and-another-flag=another-value --and-one-more-flag-that-keeps-going=true",
		"```",
		"",
		"- https://example.com/list/item/url/that/is/really/long/and/does/not/break/anywhere/at/all",
		"  1. `a.really.long.inline.code.span.that.keeps.going.and.going.forever.and.ever`",
		"",
		"> /var/folders/xy/abcdefghijklmnopqrstuvwxyz0123456789/T/some-temp-file-name.log",
	].join("\n");

/**
 * Diagrams and display math as the newest turn of an idle agent: on screen
 * with no scrolling (web/e2e/diagrams.ios.e2e.ts does the same), wider
 * than a phone column on their own. `tag` sets one run's reply apart.
 */
const diagrams = (tag: string) =>
	[
		`Diagrams ${tag}:`,
		"",
		"```mermaid",
		"flowchart LR",
		"  A[a fairly long first step] --> B[a fairly long second step] --> C[a fairly long third step] --> D[a fairly long fourth step]",
		"```",
		"",
		"```mermaid",
		"pie title refresh time",
		'  "network" : 70',
		'  "lock wait" : 30',
		"```",
		"",
		"$$\\sum_{k=0}^{r} 2^k \\cdot 50\\,\\text{ms} + \\sum_{k=0}^{r} 3^k \\cdot 70\\,\\text{ms} + \\sum_{k=0}^{r} 5^k \\cdot 90\\,\\text{ms} + \\sum_{k=0}^{r} 7^k \\cdot 110\\,\\text{ms}$$",
	].join("\n");

/**
 * Scrolls the conversation top to bottom (or measures where it is, with
 * `scroll` false), measuring at each step: the page
 * and the conversation's scroller have no sideways overflow, and nothing
 * outside a box that clips or scrolls it reaches past the column's content
 * edge (into the gutter, which scrollWidth alone misses).
 */
async function sidewaysOverflow(page: Page, scroll = true) {
	return page.evaluate(async (scroll) => {
		const found = new Set<string>();
		const sc = document.querySelector<HTMLElement>(
			".ds-scroller > div:first-child",
		);
		if (!sc) return ["no scroller"];
		const measure = () => {
			const doc = document.scrollingElement;
			if (doc && doc.scrollWidth > doc.clientWidth)
				found.add(`page ${doc.scrollWidth} > ${doc.clientWidth}`);
			if (sc.scrollWidth > sc.clientWidth)
				found.add(`scroller ${sc.scrollWidth} > ${sc.clientWidth}`);
			const col = sc.querySelector<HTMLElement>(".ds-column");
			if (!col) return;
			const edge =
				col.getBoundingClientRect().right -
				Number.parseFloat(getComputedStyle(col).paddingRight);
			for (const el of col.querySelectorAll("*")) {
				const r = el.getBoundingClientRect();
				if (!r.width || r.right <= edge + 0.5) continue;
				let clipped = false;
				for (let p = el.parentElement; p && p !== col; p = p.parentElement)
					if (
						getComputedStyle(p).overflowX !== "visible" &&
						p.getBoundingClientRect().right <= edge + 0.5
					) {
						clipped = true;
						break;
					}
				if (clipped) continue;
				const cls =
					el.getAttribute("class")?.trim().split(/\s+/).slice(0, 3) ?? [];
				found.add(
					`${el.tagName.toLowerCase()}${cls.map((c) => `.${c}`).join("")} ends at ${Math.round(r.right)} > ${Math.round(edge)}`,
				);
			}
		};
		if (!scroll) measure();
		else
			for (let y = 0; ; y += sc.clientHeight / 2) {
				sc.scrollTop = y;
				await new Promise((r) => requestAnimationFrame(() => r(null)));
				measure();
				if (y >= sc.scrollHeight - sc.clientHeight) break;
			}
		return [...found].slice(0, 20);
	}, scroll);
}

/** Opens every closed tool card and reasoning row, then waits for the bodies. */
async function openAll(page: Page) {
	const conv = page.locator(".ds-conv").first();
	for (let pass = 0; pass < 3; pass++) {
		const closed = conv.locator(
			'.ds-tool[data-state="closed"] > .ds-tool-head, .ds-reason[data-state="closed"] > .ds-reason-head',
		);
		const n = await closed.count();
		if (!n) break;
		for (let i = n - 1; i >= 0; i--) {
			const head = closed.nth(i);
			await head.scrollIntoViewIfNeeded();
			await head.click();
		}
	}
	await expect(conv.getByText("Loading…")).toHaveCount(0, { timeout: 15_000 });
}

for (const width of WIDTHS) {
	test.describe(`at ${width} px`, () => {
		test.use({ viewport: { width, height: 812 } });

		test("the chat-blocks gallery, every card open, stays in its column", async ({
			page,
			request,
		}) => {
			test.setTimeout(120_000);
			const id = await agentId(request, "fixture=blocks");
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			const conv = page.locator(".ds-conv").first();
			await expect(
				conv.locator('[data-tool="FrobnicateWidget"]'),
			).toBeAttached();
			await openAll(page);
			expect(await sidewaysOverflow(page)).toEqual([]);
		});

		test("diagrams and display math, the newest turn, stay in their column", async ({
			page,
			request,
		}) => {
			// Not the showcase: scrolling its diagrams into view trips a
			// WebKit ResizeObserver error (open). An agent no other spec reads.
			const id = await agentId(request, "status=idle machine=edge-18");
			const tag = `wide${width}x${Date.now().toString(36)}`;
			const res = await request.post("/api/v1/__mock/realtime", {
				headers: { "X-Pulsar": "1" },
				data: { action: "transcript", id, text: diagrams(tag) },
			});
			expect(res.ok()).toBe(true);
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			const turn = page.locator(".ds-turn--assistant", {
				hasText: `Diagrams ${tag}:`,
			});
			for (const kind of ["flowchart-v2", "pie"])
				await expect(
					turn.locator(`svg[aria-roledescription="${kind}"]`),
				).toBeVisible({ timeout: 15_000 });
			await expect(turn.locator(".katex").first()).toBeVisible();
			expect(await sidewaysOverflow(page, false)).toEqual([]);
		});

		test("long links, paths and words wrap in replies and in bubbles", async ({
			page,
			request,
		}) => {
			// An agent no other spec reads: these lines stay in this worker's mock.
			const id = await agentId(request, "name=claude@tundra");
			const tag = `wide${width}x${Date.now().toString(36)}`;
			for (const extra of [
				{},
				{ role: "user" },
				{
					role: "peer",
					from: "codex@a-really-long-machine-name-without-breaks · m_0123456789abcdef",
				},
			]) {
				const res = await request.post("/api/v1/__mock/realtime", {
					headers: { "X-Pulsar": "1" },
					data: { action: "transcript", id, text: wide(tag), ...extra },
				});
				expect(res.ok()).toBe(true);
			}
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			const conv = page.locator(".ds-conv").first();
			await expect(
				conv.getByText(`${tag}_Supercalifragilisticexpialidocious`),
			).toHaveCount(3);
			// The composer, with a long unbroken draft.
			await page
				.getByPlaceholder("Message")
				.fill(
					"https://example.com/a/long/draft/url/without/breaks/Supercalifragilisticexpialidocious",
				);
			expect(await sidewaysOverflow(page)).toEqual([]);
		});
	});
}
