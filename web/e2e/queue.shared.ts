import type { APIRequestContext, Page } from "@playwright/test";
import { expect, proveInSheet } from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

/**
 * The queue strip above the composer (web/src/features/queue): messages
 * not yet in the agent's conversation, with state, age and Cancel / Send
 * now / Edit (web/mock/queue.ts). Shared by queue.desktop.e2e.ts and
 * queue.ios.e2e.ts.
 */

export const QUEUED_AGENT = "codex@apparish";

export async function seedQueue(page: Page, request: APIRequestContext) {
	const createdAt = Date.now();
	await page.clock.setFixedTime(createdAt);
	const res = await request.post("/api/v1/__mock/queue", {
		headers: { "X-Pulsar": "1" },
		data: {
			reset: true,
			agent: QUEUED_AGENT,
			items: [
				{ body: "Run the billing tests next", state: "next-turn", createdAt },
				{
					body: "Pause refresh() changes",
					state: "held",
					mine: false,
					from: { id: "claude:9", name: "apparish-auth" },
				},
				{ body: "Then rebase on main", state: "idle" },
			],
		},
	});
	expect(res.ok()).toBe(true);
}

export async function clearQueue(request: APIRequestContext) {
	await request.post("/api/v1/__mock/queue", {
		headers: { "X-Pulsar": "1" },
		data: { reset: true },
	});
}

const strip = (page: Page) => page.getByTestId("queue-strip");
const row = (page: Page, text: string) =>
	strip(page).locator(".q-row", { hasText: text });

/** Opens the strip if it starts folded (the phone). */
export async function expand(page: Page) {
	const head = strip(page).locator(".q-head");
	await expect(head).toBeVisible();
	if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
	await expect(head).toHaveAttribute("aria-expanded", "true");
}

/** States, ages, disabled reasons and colors of the seeded queue. */
export async function checkListing(page: Page) {
	await expect(strip(page).locator(".q-title")).toHaveText("Queued (3)");
	await expand(page);
	const mine = row(page, "Run the billing tests next");
	await expect(mine.locator(".q-from")).toHaveText("You");
	await expect(mine.locator(".q-chip")).toHaveText("Next turn");
	await expect(mine.locator(".q-age")).toHaveText("now");
	await expect(mine.getByRole("button", { name: /^Edit/ })).toBeEnabled();
	const other = row(page, "Pause refresh() changes");
	await expect(other.locator(".q-from")).toHaveText("apparish-auth");
	await expect(other.locator(".q-chip")).toHaveText("Held");
	// Not the operator's: no Edit.
	await expect(other.getByRole("button", { name: /^Edit/ })).toHaveCount(0);
	const handed = row(page, "Then rebase on main");
	await expect(handed.locator(".q-chip")).toHaveText("Waiting for idle");
	const cancel = handed.getByRole("button", { name: /^Cancel/ });
	await expect(cancel).toBeDisabled();
	// The reason is the tooltip of its wrapper.
	await expect(handed.locator(".q-tip").last()).toHaveAttribute(
		"title",
		/lands when the current turn ends/,
	);
	expect(await contrastFailures(page, ".q-strip *")).toEqual([]);
}

/** Edit and Cancel on the operator's own message (no proof, as a send). */
export async function editAndCancelOwn(page: Page) {
	const mine = row(page, "Run the billing tests next");
	await mine.getByRole("button", { name: /^Edit/ }).click();
	const area = strip(page).getByRole("textbox", { name: "Edit message" });
	await area.fill("Run the billing and auth tests next");
	await strip(page).getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Message updated")).toBeVisible();
	await expect(row(page, "Run the billing and auth tests next")).toBeVisible();
	await row(page, "Run the billing and auth tests next")
		.getByRole("button", { name: /^Cancel/ })
		.click();
	await expect(page.getByText("Message withdrawn")).toBeVisible();
	await expect(row(page, "billing and auth")).toHaveCount(0);
	await expect(strip(page).locator(".q-title")).toHaveText("Queued (2)");
}

/** Send now on another agent's held message: Prove Human first. */
export async function promoteOthers(page: Page) {
	await row(page, "Pause refresh() changes")
		.getByRole("button", { name: /^Send now/ })
		.click();
	await proveInSheet(page);
	await expect(page.getByText("Sent with urgent priority")).toBeVisible();
	await expect(row(page, "Pause refresh() changes")).toHaveCount(0);
	await expect(strip(page).locator(".q-title")).toHaveText("Queued (1)");
}
