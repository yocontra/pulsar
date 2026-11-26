import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "../fixtures.ts";

export async function reopenSavedConversation(
	page: Page,
	request: APIRequestContext,
	header: string,
) {
	const port = Number(process.env.PULSAR_REAL_PORT ?? 47392);
	const control = `http://127.0.0.1:${process.env.PULSAR_REAL_CONTROL_PORT ?? port + 1}/archive-fixture`;
	const created = await request.post(control);
	expect(created.ok()).toBe(true);
	const { id, marker } = (await created.json()) as {
		id: string;
		marker: string;
	};
	const route = `/#/a/${encodeURIComponent(id)}`;
	await page.goto(route);
	await expect(page.locator(header)).toContainText("archive-reader");
	await expect(page.getByText(marker, { exact: true })).toBeVisible();
	await expect(page.locator(".composer-input")).toBeVisible();

	await page.goto("about:blank");
	expect((await request.delete(control)).ok()).toBe(true);
	await expect
		.poll(async () => {
			const detail = await request.get(
				`/api/v1/agents/${encodeURIComponent(id)}`,
				{ headers: { "X-Pulsar": "1" } },
			);
			return (await detail.json()).archived;
		})
		.toBe(true);
	await page.goto(route);
	await expect(page.locator(header)).toContainText("archive-reader");
	await expect(page.getByText(marker, { exact: true })).toBeVisible();
	await expect(
		page.getByText("Saved conversation · Session closed", { exact: true }),
	).toBeVisible();
	await expect(page.locator(".composer-input")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Send", exact: true }),
	).toHaveCount(0);
}
