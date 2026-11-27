import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

/** Live turns can place the parent tool call on any earlier transcript page. */
export async function openChildFromCard(page: Page, id: string) {
	const response = await page.request.get(
		`/api/v1/subagents/${encodeURIComponent(id)}`,
		{ headers: { "X-Pulsar": "1" } },
	);
	expect(response.ok()).toBe(true);
	const { callId } = (await response.json()) as { callId: string };
	expect(callId).toBeTruthy();
	const card = page.locator(`.ds-task[data-call-id="${callId}"]`);
	const earliest = page.locator(".ds-conv [data-msg-id]").first();
	await expect(earliest).toBeAttached();
	while (!(await card.count())) {
		const previous = await earliest.getAttribute("data-msg-id");
		await page
			.getByRole("button", { name: "Load earlier messages" })
			.last()
			.click();
		await expect(earliest).not.toHaveAttribute("data-msg-id", previous!);
	}
	await card.locator(".ds-tool-head").click();
	const link = card.locator(`[data-subagent-link="${id}"]`);
	await expect(link).toBeVisible();
	await link.click();
}
