/** The phone off Tailscale under an open app (e2e/unreachable.shared.ts). */
import type { Page } from "@playwright/test";
import { unreachableSpecs } from "./unreachable.shared.ts";

const top = (page: Page) =>
	page.locator("ion-nav > .ion-page:not(.ion-page-hidden)").last();

unreachableSpecs({
	title: "Can't Reach studio",
	body: "Check that the Tailscale app is on, then try again.",
	openLazy: (page) => page.getByTestId("tab-usage").click(),
	lazyShown: (page) => top(page).getByTestId("usage-total"),
	home: (page) => page.getByTestId("tab-usage"),
});
