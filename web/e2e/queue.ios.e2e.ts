import {
	agentId,
	expect,
	localhostBase,
	resetPasskeys,
	test,
} from "./fixtures.ts";
import {
	checkListing,
	clearQueue,
	editAndCancelOwn,
	promoteOthers,
	seedQueue,
} from "./queue.shared.ts";
import { softAuthenticator } from "./soft-webauthn.ts";

/** The queue strip above the phone composer, folded at first (queue.shared.ts). */
test.describe("queue strip", () => {
	test.afterEach(async ({ request }) => {
		await clearQueue(request);
	});

	test("folded with a count; unfolds; edit, cancel and send now", async ({
		page,
		request,
	}) => {
		await seedQueue(request);
		const id = await agentId(
			request,
			"name=codex@apparish branch=feat/billing",
		);
		await resetPasskeys(request);
		await softAuthenticator(page);
		await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(id)}`);
		const strip = page.getByTestId("queue-strip");
		await expect(strip.locator(".q-head")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		await expect(strip.locator(".q-peek")).toContainText("Next turn");
		await checkListing(page);
		await editAndCancelOwn(page);
		await promoteOthers(page);
	});
});
