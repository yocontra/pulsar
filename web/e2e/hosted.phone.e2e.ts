import { ready, test } from "./fixtures.ts";
import { hostedFixture, openHosted } from "./hosted.shared.ts";

test("hosted tasks show offline observers and stale provider results on a phone", async ({
	page,
}) => {
	await hostedFixture(page);
	await ready(page);
	await openHosted(page);
});
