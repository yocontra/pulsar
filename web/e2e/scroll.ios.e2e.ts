import { agentId, expect, test } from "./fixtures.ts";

/**
 * Scrolling a long conversation on the phone (WebKit) logs no console
 * error. Transcript images used to be lazy: each got its size only as it
 * scrolled near, which could land inside the stick-to-bottom
 * ResizeObserver's pass and log "ResizeObserver loop completed with
 * undelivered notifications" (the `errors` fixture fails on it).
 */
test("scrolling the gallery to its last reply logs no error", async ({
	page,
	request,
}) => {
	const id = await agentId(request, "fixture=blocks");
	await page.goto(`/#/a/${encodeURIComponent(id)}`);
	const conv = page.locator(".ds-conv").first();
	const last = conv.getByText("2 refreshes", { exact: true }).last();
	await expect(last).toBeVisible({ timeout: 15_000 });
	// Its images (tool screenshots, Markdown images) are on the way.
	await expect(conv.locator("img.transcript-image").first()).toBeAttached();
	await last.scrollIntoViewIfNeeded();
	await expect(last).toBeInViewport();
	// Every image in the conversation has loaded and laid out.
	await expect
		.poll(() =>
			conv
				.locator("img")
				.evaluateAll((imgs) =>
					imgs.every((i) => (i as HTMLImageElement).complete),
				),
		)
		.toBe(true);
	await page.evaluate(
		() =>
			new Promise((r) =>
				requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
			),
	);
});
