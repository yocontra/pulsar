import { agentId, expect, scrollConversationUp, test } from "./fixtures.ts";

export function sessionViewport(mobile: boolean) {
	test("short and long sessions fill the viewport and keep the composer docked", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=omp@apparish");
		let count = 0;
		await page.route("**/transcript", (route) =>
			route.fulfill({
				json: {
					available: true,
					cursor: null,
					events: Array.from({ length: count }, (_, i) => ({
						id: `viewport-${i}`,
						ts: Date.now() + i,
						role: i % 2 === 0 ? "user" : "assistant",
						kind: "text",
						text: `Viewport turn ${i}`,
					})),
				},
			}),
		);
		for (count of [0, 2, 40]) {
			const response = page.waitForResponse((r) =>
				new URL(r.url()).pathname.endsWith("/transcript"),
			);
			await page.goto(`/?viewportCase=${count}#/a/${encodeURIComponent(id)}`);
			await response;
			const session = page.locator("section.session:visible");
			const dock = session.locator(".composer");
			const scroller = session.locator(".ds-scroller > div").first();
			await expect(dock.locator("textarea")).toBeVisible();
			await expect(session.locator(".transcript-skel")).toHaveCount(0);
			if (count)
				await expect(
					session.getByText(`Viewport turn ${count - 1}`, { exact: true }),
				).toBeVisible();
			await expect
				.poll(() =>
					session.evaluate((s, mobile) => {
						const shell = s.closest(mobile ? ".ion-page" : ".d-app")!;
						const shellBox = shell.getBoundingClientRect();
						const rootBox = document
							.getElementById("app")!
							.getBoundingClientRect();
						const box = s.getBoundingClientRect();
						const composer = s
							.querySelector(".composer")!
							.getBoundingClientRect();
						const fits =
							Math.abs(shellBox.top) < 2 &&
							Math.abs(shellBox.left) < 2 &&
							Math.abs(shellBox.bottom - innerHeight) < 2 &&
							Math.abs(shellBox.right - innerWidth) < 2 &&
							Math.abs(box.bottom - innerHeight) < 2 &&
							Math.abs(box.right - innerWidth) < 2 &&
							composer.bottom <= innerHeight + 1 &&
							composer.bottom >= innerHeight - 48;
						return {
							fits,
							rootWidth: Math.round(rootBox.width),
							rootHeight: Math.round(rootBox.height),
							width: Math.round(shellBox.width),
							height: Math.round(shellBox.height),
						};
					}, mobile),
				)
				.toEqual({
					fits: true,
					rootWidth: page.viewportSize()!.width,
					rootHeight: page.viewportSize()!.height,
					width: page.viewportSize()!.width,
					height: page.viewportSize()!.height,
				});
			const overflow = () =>
				scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
			if (count < 40) {
				await expect.poll(overflow).toBeLessThanOrEqual(1);
				if (count) {
					const first = await session
						.getByText("Viewport turn 0", { exact: true })
						.boundingBox();
					const top = await scroller.boundingBox();
					expect(first!.y - top!.y).toBeLessThan(168);
				}
			} else {
				await expect.poll(overflow).toBeGreaterThan(100);
				// The newest turn is attached before the initial follow-to-bottom
				// completes. Confirm it has landed before the reader scrolls away.
				await expect
					.poll(() =>
						scroller.evaluate(
							(el) => el.scrollHeight - el.clientHeight - el.scrollTop,
						),
					)
					.toBeLessThan(2);
				const before = await dock.boundingBox();
				if (mobile) {
					await scrollConversationUp(scroller, "top");
				} else {
					await scroller.hover();
					await page.mouse.wheel(
						0,
						-(await scroller.evaluate((el) => el.scrollHeight)),
					);
				}
				await expect(
					session.getByRole("button", { name: "Jump to latest" }),
				).toBeVisible();
				await expect
					.poll(() => scroller.evaluate((el) => el.scrollTop))
					.toBeLessThan(2);
				const after = await dock.boundingBox();
				expect(after!.y).toBeCloseTo(before!.y, 0);
				expect(await page.evaluate(() => window.scrollY)).toBe(0);
			}
		}
	});
}
