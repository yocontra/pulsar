/** The desktop off Tailscale under an open app (e2e/unreachable.shared.ts). */
import { unreachableSpecs } from "./unreachable.shared.ts";

unreachableSpecs({
	title: "Can't reach studio",
	body: "Check that Tailscale is on, then try again.",
	openLazy: async (page) => {
		await page.evaluate(() => {
			location.hash = "#/usage";
		});
	},
	lazyShown: (page) => page.getByRole("main", { name: "Usage" }),
	home: (page) => page.locator("#filter"),
});
