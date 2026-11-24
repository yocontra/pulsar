import { agentId, expect, ready, test } from "./fixtures.ts";
import { realtime } from "./live.shared.ts";

/**
 * The showcase transcript on the phone, in WebKit: every Mermaid diagram
 * (sequence, flowchart, pie, mindmap) renders as it scrolls into view while
 * new turns stream in, at the column's width, with no console error at all
 * (no ResizeObserver loop, no stray refused style; e2e/fixtures.ts).
 */

const KINDS = ["sequence", "flowchart-v2", "pie", "mindmap"];

test.afterEach(async ({ request }) => {
	await realtime(request, { action: "restore" });
});

test("every showcase diagram renders as it scrolls into view, with no console error (phone)", async ({
	page,
	request,
}) => {
	await ready(page);
	// Each fixed studio session starts with the showcase in its newest
	// page. Earlier tests can stream it out of an existing agent's window.
	await realtime(request, {
		action: "add-agent",
		machine: "studio",
		name: "diagram-showcase",
		harness: "claude",
	});
	const id = await agentId(request, "name=diagram-showcase");
	await page.evaluate((id) => {
		location.hash = `#/a/${encodeURIComponent(id)}`;
	}, id);
	const blocks = page.locator('[data-streamdown="mermaid-block"]');
	await expect(blocks).toHaveCount(KINDS.length);
	// Newest (bottom) first, as the operator scrolls up through the reply.
	for (let i = KINDS.length - 1; i >= 0; i--) {
		const block = blocks.nth(i);
		const svg = block.locator(`svg[aria-roledescription="${KINDS[i]}"]`);
		await block.scrollIntoViewIfNeeded();
		await expect(svg).toBeVisible({ timeout: 15_000 });
		// The pan/zoom frame fits it once its width is known: wait for that.
		const fit = () =>
			svg.evaluate((el) => {
				const frame = el.closest('[data-streamdown="mermaid"]')!;
				const pad = Number.parseFloat(getComputedStyle(frame).paddingLeft) || 0;
				return {
					natural: Number(el.getAttribute("width")),
					shown: el.getBoundingClientRect().width,
					column: frame.getBoundingClientRect().width - 2 * pad,
				};
			});
		// Each is wider than a phone's column: it fills it.
		const f = await fit();
		expect(f.natural, KINDS[i]).toBeGreaterThan(f.column);
		await expect
			.poll(
				async () => {
					const { shown, column } = await fit();
					return Math.abs(shown - column) < 2;
				},
				{ message: KINDS[i] },
			)
			.toBe(true);
	}
});
