import { devices } from "@playwright/test";
import { test } from "../fixtures.ts";
import { reopenSavedConversation } from "./archive.shared.ts";

const { defaultBrowserType: _, ...phone } = devices["iPhone 13 Mini"];
test.use({ ...phone, browserName: "webkit" });

test("a saved conversation reopens after its agent closes on phone @real", async ({
	page,
	request,
}) => {
	await reopenSavedConversation(page, request, ".p-agent-header .p-nav-title");
});
