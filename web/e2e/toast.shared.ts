import { expect, ready, test } from "./fixtures.ts";

/**
 * Toasts (src/lib/toast.ts) render under the production CSP: Sonner's own
 * <style> is stripped at build time and its stylesheet loads as a file, so
 * the toast is styled and the console stays clean (the `errors` fixture
 * fails the test on any CSP violation). Shared by the desktop (Chromium)
 * and iOS (WebKit) suites.
 */
export function toastSuite(tap: boolean) {
	test("a toast with an action renders styled, with no CSP errors", async ({
		page,
	}) => {
		await page.addInitScript(() => {
			(window as { __pulsarE2E?: object }).__pulsarE2E = {};
		});
		await ready(page);
		await page.evaluate(() => {
			const w = window as unknown as {
				__pulsarE2E: {
					toast: (m: string, o: object) => Promise<unknown>;
				};
				undone?: boolean;
			};
			void w.__pulsarE2E.toast("Archived 2 agents", {
				tone: "success",
				description: "They stay in the list until you clear it",
				duration: 60_000,
				action: { label: "Undo", onClick: () => (w.undone = true) },
			});
		});
		const card = page.locator("[data-sonner-toast]");
		await expect(card).toHaveCount(1);
		await expect(card).toContainText("Archived 2 agents");
		await expect(card).toContainText("They stay in the list");
		// Sonner's stylesheet applied (an injected <style> would be refused).
		expect(await card.evaluate((el) => getComputedStyle(el).position)).toBe(
			"absolute",
		);
		// Our tokens applied (styles/toasts.css): the action uses the primary color.
		const undo = card.getByRole("button", { name: "Undo" });
		const [bg, primary] = await undo.evaluate((el) => [
			getComputedStyle(el).backgroundColor,
			getComputedStyle(document.documentElement)
				.getPropertyValue("--ds-primary")
				.trim(),
		]);
		expect(primary).not.toBe("");
		expect(bg).not.toBe("rgba(0, 0, 0, 0)");
		if (tap) await undo.tap();
		else await undo.click();
		await expect
			.poll(() => page.evaluate(() => (window as { undone?: boolean }).undone))
			.toBe(true);
		await expect(card).toHaveCount(0);
		// No <style> element was added at run time.
		expect(await page.locator("head style").count()).toBe(0);
	});
}
