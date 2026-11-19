import { devices } from "@playwright/test";
import { test } from "../fixtures.ts";
import { revisitPaintsFromSnapshot } from "./first-paint.shared.ts";

// The phone app (Ionic shell) in WebKit, as on the operator's iPhone 13 mini.
const { defaultBrowserType: _, ...phone } = devices["iPhone 13 Mini"];
test.use({ ...phone, browserName: "webkit" });

test("a revisit paints the last screen before the network answers (phone) @real", async ({
	page,
	request,
}) => {
	await revisitPaintsFromSnapshot(page, request);
});
