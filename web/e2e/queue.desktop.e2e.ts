import {
	agentId,
	expect,
	localhostBase,
	test,
	withPasskey,
} from "./fixtures.ts";
import {
	checkListing,
	clearQueue,
	editAndCancelOwn,
	promoteOthers,
	QUEUED_AGENT,
	seedQueue,
} from "./queue.shared.ts";

/** The queue strip above the desktop composer (queue.shared.ts). */
test.describe("queue strip", () => {
	test.afterEach(async ({ request }) => {
		await clearQueue(request);
	});

	test("lists waiting messages; edit, cancel and send now", async ({
		page,
		request,
		context,
	}) => {
		await seedQueue(request);
		const id = await agentId(
			request,
			"name=codex@apparish branch=feat/billing",
		);
		await page.goto(`${localhostBase()}/`);
		await withPasskey(page, request, context);
		await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(id)}`);
		await expect(page.locator(".session-header h1")).toHaveText(QUEUED_AGENT);
		await checkListing(page);
		await editAndCancelOwn(page);
		await promoteOthers(page);
	});

	test("no strip when nothing waits", async ({ page, request }) => {
		const id = await agentId(
			request,
			"name=codex@apparish branch=feat/billing",
		);
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await expect(page.locator(".session-header h1")).toHaveText(QUEUED_AGENT);
		await expect(page.locator(".prompt textarea")).toBeVisible();
		await expect(page.getByTestId("queue-strip")).toHaveCount(0);
	});
});
