import { expect, ready, test } from "./fixtures.ts";

/**
 * Toasts (src/lib/toast.ts) render under the production CSP: Sonner's own
 * <style> is stripped at build time and its stylesheet loads as a file, so
 * the toast is styled and the console stays clean (the `errors` fixture
 * fails the test on any CSP violation). Shared by the desktop (Chromium)
 * and phone suites.
 */
export function toastSuite(tap: boolean) {
	test("a toast overlays the page without shifting it and its action works", async ({
		page,
	}) => {
		await page.addInitScript(() => {
			(window as { __pulsarE2E?: object }).__pulsarE2E = {};
		});
		await ready(page);
		const layout = page.locator(
			tap ? "ion-nav, .p-tabbar" : ".d-side, .d-main",
		);
		await expect(layout).toHaveCount(2);
		const rectangles = () =>
			layout.evaluateAll((elements) =>
				elements.map((el) => {
					const { x, y, width, height } = el.getBoundingClientRect();
					return { x, y, width, height };
				}),
			);
		const before = await rectangles();
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
		expect(await rectangles()).toEqual(before);
		await expect(
			page.locator("body > .p-toast-overlay [data-sonner-toast]"),
		).toHaveCount(1);
		await expect(page.locator(".p-toast-overlay")).toHaveCSS(
			"position",
			"fixed",
		);
		// Sonner's stylesheet applied (an injected <style> would be refused).
		expect(await card.evaluate((el) => getComputedStyle(el).position)).toBe(
			"absolute",
		);
		// Material uses a transparent action with a primary-colored label.
		const undo = card.getByRole("button", { name: "Undo" });
		const usesTheme = await undo.evaluate((el) => {
			const material =
				document.documentElement.classList.contains("k-material");
			const styles = getComputedStyle(el);
			const token = document.createElement("span");
			token.style.color = material
				? "var(--ds-primary-soft)"
				: "var(--ds-primary)";
			el.append(token);
			const expected = getComputedStyle(token).color;
			token.remove();
			return (material ? styles.color : styles.backgroundColor) === expected;
		});
		expect(usesTheme).toBe(true);
		if (tap) await undo.tap();
		else await undo.click();
		await expect
			.poll(() => page.evaluate(() => (window as { undone?: boolean }).undone))
			.toBe(true);
		await expect(card).toHaveCount(0);
		expect(await rectangles()).toEqual(before);
		// No <style> element was added at run time.
		expect(await page.locator("head style").count()).toBe(0);
	});
}
