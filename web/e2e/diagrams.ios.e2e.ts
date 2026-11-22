import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * Mermaid diagrams on the phone (session/streamdown.tsx): the showcase's
 * flowchart, pie and mindmap render under the production CSP with no
 * refused style (the fixture fails on any console error). WebKit names the
 * page, not the script, in those reports, so nothing may be refused at all.
 */
test("the showcase diagrams render with no refused style (phone)", async ({
	page,
	request,
}) => {
	await ready(page);
	const id = await agentId(request, "name=apparish-auth");
	await page.evaluate((id) => {
		location.hash = `#/a/${encodeURIComponent(id)}`;
	}, id);
	const blocks = page.locator('[data-streamdown="mermaid-block"]');
	await expect(blocks.last()).toBeAttached();
	// Diagrams render as they scroll into view: newest first, from the bottom.
	for (const kind of ["mindmap", "pie", "flowchart-v2"]) {
		const svg = page.locator(`svg[aria-roledescription="${kind}"]`);
		await expect(async () => {
			const n = await blocks.count();
			for (let i = n - 1; i >= 0 && !(await svg.count()); i--)
				await blocks.nth(i).scrollIntoViewIfNeeded();
			await expect(svg.first()).toBeVisible({ timeout: 2000 });
		}).toPass({ timeout: 20_000 });
		// Mermaid's theme CSS still applies, through CSSOM: rules scoped to
		// this diagram's id.
		expect(
			await svg
				.first()
				.evaluate((el) =>
					document.adoptedStyleSheets.some((sheet) =>
						Array.from(sheet.cssRules).some(
							(r) =>
								r instanceof CSSStyleRule &&
								r.selectorText.startsWith(`#${el.id} `),
						),
					),
				),
		).toBe(true);
	}
});
