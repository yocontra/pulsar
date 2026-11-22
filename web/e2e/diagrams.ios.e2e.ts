import type { APIRequestContext, Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * Mermaid diagrams on the phone (session/streamdown.tsx) under the
 * production CSP, in WebKit: a reply with a flowchart and a pie renders
 * them at the column's width (fitted once by the pan/zoom frame), with
 * their theme CSS (CSSOM), and leaves no refused style the fixture can't
 * trace to Mermaid's own inert parsing (e2e/fixtures.ts). The reply is the
 * newest turn of an idle agent, so both diagrams are on screen with no
 * scrolling.
 */

const REPLY = [
	"The fixed path:",
	"",
	"```mermaid",
	"flowchart LR",
	"  A[request A] --> L{lock free?}",
	"  B[request B] --> L",
	"  L -- yes --> R[refresh once]",
	"  L -- no --> W[await the same refresh]",
	"  R --> T((token))",
	"  W --> T",
	"```",
	"",
	"```mermaid",
	"pie title refresh time",
	'  "network" : 70',
	'  "lock wait" : 30',
	"```",
].join("\n");

const KINDS = ["flowchart-v2", "pie"];

async function diagramReply(page: Page, request: APIRequestContext) {
	const id = await agentId(request, "status=idle machine=edge-19");
	const res = await request.post("/api/v1/__mock/realtime", {
		headers: { "X-Pulsar": "1" },
		data: { action: "transcript", id, text: REPLY },
	});
	expect(res.ok()).toBe(true);
	await ready(page);
	await page.evaluate((id) => {
		location.hash = `#/a/${encodeURIComponent(id)}`;
	}, id);
	const turn = page.locator(".ds-turn--assistant", {
		hasText: "The fixed path:",
	});
	for (const kind of KINDS)
		await expect(
			turn.locator(`svg[aria-roledescription="${kind}"]`),
		).toBeVisible({ timeout: 15_000 });
	return turn;
}

test("a flowchart and a pie render at the column's width with no stray refused style (phone)", async ({
	page,
	request,
}) => {
	const turn = await diagramReply(page, request);
	for (const kind of KINDS) {
		const fit = await turn
			.locator(`svg[aria-roledescription="${kind}"]`)
			.evaluate((el) => {
				const frame = el.closest('[data-streamdown="mermaid"]')!;
				const pad = Number.parseFloat(getComputedStyle(frame).paddingLeft) || 0;
				return {
					natural: Number(el.getAttribute("width")),
					shown: el.getBoundingClientRect().width,
					column: frame.getBoundingClientRect().width - 2 * pad,
					// Mermaid's theme CSS, through CSSOM: rules scoped to this diagram.
					themed: document.adoptedStyleSheets.some((sheet) =>
						Array.from(sheet.cssRules).some(
							(r) =>
								r instanceof CSSStyleRule &&
								r.selectorText.startsWith(`#${el.id} `),
						),
					),
				};
			});
		expect(fit.themed, kind).toBe(true);
		// Both are wider than a phone's column: each fills it.
		expect(fit.natural, kind).toBeGreaterThan(fit.column);
		expect(Math.abs(fit.shown - fit.column), kind).toBeLessThan(2);
	}
});

test("an inline style from app code still fails, next to Mermaid's (phone)", async ({
	page,
	request,
}) => {
	// The fixture fails this test at teardown: that is the check.
	test.fail();
	await diagramReply(page, request);
	await page.evaluate(() => {
		const el = document.createElement("div");
		el.innerHTML = '<span style="color: red">x</span>';
		document.body.append(el);
	});
	await expect(
		page.locator("body > div > span", { hasText: "x" }),
	).toBeAttached();
});
