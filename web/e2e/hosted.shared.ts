import type { Page } from "@playwright/test";
import type { HostedReport } from "../../src/hosted/wire.ts";
import { expect } from "./fixtures.ts";

const report: HostedReport = {
	machines: [
		{ machineId: "remote", name: "Remote", state: "reachable" },
		{ machineId: "offline", name: "Unavailable Mac", state: "offline" },
	],
	providers: [
		{
			machineId: "remote",
			provider: "copilot",
			state: "ready",
			observedAt: 123,
			detail: null,
		},
		{
			machineId: "remote",
			provider: "codex",
			state: "stale",
			observedAt: 120,
			detail: "read-failed",
		},
	],
	tasks: [
		{
			provider: "copilot",
			id: "task-1",
			title: "One hosted task",
			status: "Queued",
			context: "example/repo",
			url: "https://github.com/example/repo/pull/1/agent-sessions/task-1",
			updatedAt: 123,
			sources: [
				{ machineId: "remote", state: "reachable" },
				{ machineId: "offline", state: "offline" },
			],
		},
	],
};

export async function hostedFixture(page: Page) {
	await page.route("**/api/v1/hello", async (route) => {
		const response = await route.fetch();
		const hello = await response.json();
		await route.fulfill({
			response,
			json: { ...hello, features: [...hello.features, "hosted"] },
		});
	});
	await page.route("**/api/v1/hosted", async (route) => {
		if (route.request().method() === "GET")
			await route.fulfill({ json: report });
		else await route.fallback();
	});
}

export async function openHosted(page: Page) {
	await page.getByRole("button", { name: "Hosted agents" }).click();
	await expect(page).toHaveURL(/#\/hosted$/);
	await expect(page.getByRole("link", { name: "One hosted task" })).toHaveCount(
		1,
	);
	await expect(
		page.getByText("Remote, Unavailable Mac (offline)", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Remote · Showing last available results"),
	).toBeVisible();
}
