import { expect, localhostBase, test, withPasskey } from "./fixtures.ts";
import { hostedFixture, openHosted } from "./hosted.shared.ts";

test("hosted tasks show every observer and remote writes prove their exact target", async ({
	page,
	request,
	context,
}) => {
	await hostedFixture(page);
	await page.goto(`${localhostBase()}/`);
	await withPasskey(page, request, context);
	await openHosted(page);
	await page.route("**/api/v1/hosted", async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		const payload = route.request().postDataJSON();
		expect(payload).toMatchObject({
			machine: "remote",
			params: {
				provider: "copilot",
				action: "create",
				repo: "example/repo",
				prompt: "Synthetic task",
			},
			assertion: expect.any(Object),
		});
		const verified = await route.fetch({
			url: `${localhostBase()}/api/v1/__mock/acting`,
			postData: JSON.stringify({ ...payload, op: "hosted.write" }),
		});
		expect(verified.ok()).toBe(true);
		await route.fulfill({ json: { state: "accepted", id: "task-2" } });
	});
	await page.getByText("New hosted task", { exact: true }).click();
	await page.getByLabel("GitHub repository").fill("example/repo");
	await page.getByLabel("Prompt", { exact: true }).fill("Synthetic task");
	await page.getByRole("button", { name: "Start task" }).click();
	await expect(page.getByText("Task accepted · task-2.")).toBeVisible();
});
