import type { Page } from "@playwright/test";
import type { HostedReport } from "../../src/hosted/wire.ts";
import { expect } from "./fixtures.ts";

const report: HostedReport = {
	machines: [
		{ machineId: "remote", name: "Remote", state: "reachable" },
		{ machineId: "alternate", name: "Second Mac", state: "reachable" },
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
			machineId: "alternate",
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
		{
			machineId: "remote",
			provider: "cursor",
			state: "ready",
			detail: null,
			observedAt: 123,
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
				{ machineId: "alternate", state: "reachable" },
				{ machineId: "offline", state: "offline" },
			],
		},
		{
			provider: "cursor",
			id: "bc-123",
			title: "Cursor background task",
			context: "example/repo",
			status: "ACTIVE",
			url: null,
			updatedAt: null,
			sources: [{ machineId: "remote", state: "reachable" }],
		},
	],
};

export async function hostedFixture(page: Page) {
	let fail = false;
	let details = 0;
	let forced = 0;
	await page.route("**/api/v1/hello", async (route) => {
		const response = await route.fetch();
		const hello = await response.json();
		await route.fulfill({
			response,
			json: { ...hello, features: [...hello.features, "hosted"] },
		});
	});
	await page.route(
		(url) => url.pathname === "/api/v1/hosted",
		async (route) => {
			if (new URL(route.request().url()).searchParams.get("refresh") === "1")
				forced++;
			if (route.request().method() === "GET")
				await route.fulfill({
					status: fail ? 503 : 200,
					json: fail ? {} : report,
				});
			else await route.fallback();
		},
	);
	await page.route("**/api/v1/hosted/copilot/tasks/task-1?*", async (route) => {
		const machineId = new URL(route.request().url()).searchParams.get(
			"machine",
		);
		details++;
		expect(["remote", "alternate"]).toContain(machineId);
		await route.fulfill({
			json: {
				provider: "copilot",
				id: "task-1",
				machineId,
				...(machineId === "remote"
					? {
							state: "ready",
							detail: { kind: "text", text: "Provider task output" },
						}
					: { state: "unavailable", reason: "read-failed" }),
			},
		});
	});
	let cursorStatus = "RUNNING";
	await page.route("**/api/v1/hosted/cursor/tasks/bc-123?*", async (route) => {
		await route.fulfill({
			json: {
				state: "ready",
				provider: "cursor",
				id: "bc-123",
				machineId: "remote",
				detail: {
					kind: "task",
					task: {
						...report.tasks.find((task) => task.id === "bc-123"),
						status: cursorStatus,
					},
				},
			},
		});
	});
	return {
		cursorStatus: (status: string) => {
			cursorStatus = status;
		},
		failRefresh: (value: boolean) => {
			fail = value;
		},
		detailsRead: () => details,
		forcedRefreshes: () => forced,
	};
}

export async function openHosted(page: Page) {
	await page.getByRole("button", { name: "Hosted agents" }).click();
	await expect(page).toHaveURL(/#\/hosted$/);
}

export async function inspectHosted(page: Page) {
	const search = page.getByRole("searchbox", { name: "Search hosted tasks" });
	await search.fill("missing");
	await expect(
		page.getByText("No tasks match your search.").first(),
	).toBeVisible();
	await search.fill("example/repo");
	const copilot = page.getByRole("region", { name: "GitHub Copilot" });
	await copilot
		.getByText("One hosted task")
		.locator("xpath=ancestor::summary")
		.press("Enter");
	await expect(
		copilot.getByRole("link", { name: "Open in GitHub Copilot" }),
	).toHaveAttribute("href", report.tasks[0]?.url ?? "");
	await expect(copilot.getByText("Unavailable Mac · Offline")).toBeVisible();
	await copilot.getByRole("button", { name: "Load provider details" }).click();
	await expect(
		copilot.getByRole("region", { name: "Provider output" }),
	).toHaveText("Provider task output");
	const source = copilot.getByLabel("Details from");
	await source.selectOption("alternate");
	await expect(
		copilot.getByRole("region", { name: "Provider output" }),
	).toBeHidden();
	await copilot.getByRole("button", { name: "Load provider details" }).click();
	await expect(
		copilot.getByText("Could not load provider details.", { exact: false }),
	).toBeVisible();
	await expect(copilot.getByText("Unavailable Mac · Offline")).toBeVisible();
	await source.selectOption("remote");
	await copilot.getByRole("button", { name: "Load provider details" }).click();
	await expect(
		copilot.getByRole("region", { name: "Provider output" }),
	).toBeVisible();

	const filter = page.getByLabel("Filter by provider");
	await filter.selectOption("codex");
	await expect(copilot).toBeHidden();
	const codex = page.getByRole("region", { name: "Codex Cloud" });
	await codex.getByText("Connections", { exact: true }).click();
	await expect(codex.getByText("Showing last available results")).toBeVisible();
	await expect(codex.getByText("Machine offline")).toBeVisible();
	await filter.selectOption("all");
	await expect(
		copilot.getByRole("region", { name: "Provider output" }),
	).toBeVisible();
}
