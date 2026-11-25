import { expect, localhostBase, test, withPasskey } from "./fixtures.ts";
import { hostedFixture, inspectHosted, openHosted } from "./hosted.shared.ts";

test("hosted tasks show every observer and remote writes prove their exact target", async ({
	page,
	request,
	context,
}) => {
	const fixture = await hostedFixture(page);
	await page.goto(`${localhostBase()}/`);
	await withPasskey(page, request, context);
	await openHosted(page);
	await inspectHosted(page);
	await page.getByRole("searchbox", { name: "Search hosted tasks" }).fill("");
	const cursor = page.getByRole("region", { name: "Cursor Cloud" });
	await cursor.getByText("Cursor background task").click();
	await expect(cursor.getByText("Follow up", { exact: true })).toBeHidden();
	await cursor.getByRole("button", { name: "Load provider details" }).click();
	await expect(
		cursor.getByText("Follow-up is available when the task is idle."),
	).toBeVisible();
	fixture.cursorStatus("IDLE");
	await cursor.getByRole("button", { name: "Load provider details" }).click();
	await expect(cursor.getByText("Follow up", { exact: true })).toBeVisible();
	await page.getByLabel("Filter by provider").selectOption("copilot");
	const intents: unknown[] = [];
	await page.route("**/api/v1/hosted", async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		const payload = route.request().postDataJSON();
		intents.push(payload.params);
		const first = payload.params.action === "create";
		expect(payload).toMatchObject({
			machine: "remote",
			params: first
				? {
						provider: "copilot",
						action: "create",
						repo: "example/repo",
						prompt: "Synthetic task",
					}
				: { action: "receipt", nonce: expect.any(String) },
			assertion: expect.any(Object),
		});
		const verified = await route.fetch({
			url: `${localhostBase()}/api/v1/__mock/acting`,
			postData: JSON.stringify({ ...payload, op: "hosted.write" }),
		});
		expect(verified.ok()).toBe(true);
		await route.fulfill({
			json:
				intents.length === 1
					? { state: "unknown" }
					: intents.length === 2
						? { state: "not-found" }
						: { state: "accepted", id: "task-2" },
		});
	});
	const copilot = page.getByRole("region", { name: "GitHub Copilot" });
	await copilot.getByText("New hosted task", { exact: true }).click();
	await copilot.getByLabel("Run from machine").selectOption("remote");
	await copilot.getByLabel("GitHub repository").fill("example/repo");
	await copilot.getByLabel("Prompt", { exact: true }).fill("Synthetic task");
	await copilot.getByRole("button", { name: "Start task" }).click();
	await expect(
		copilot.getByText("The provider may have accepted", { exact: false }),
	).toBeVisible();
	await copilot.getByRole("button", { name: "Check receipt" }).click();
	await expect(
		copilot.getByText("No receipt exists", { exact: false }),
	).toBeVisible();
	await copilot
		.getByRole("button", { name: "Submit again on same machine" })
		.click();
	await expect(copilot.getByText("Task accepted · task-2.")).toBeVisible();
	expect(intents).toEqual([
		expect.objectContaining({ action: "create", nonce: expect.any(String) }),
		{ action: "receipt", nonce: (intents[0] as { nonce: string }).nonce },
		intents[0],
	]);
});
