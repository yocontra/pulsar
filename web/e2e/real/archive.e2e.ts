import { test } from "../fixtures.ts";
import { reopenSavedConversation } from "./archive.shared.ts";

test("a saved conversation reopens after its agent closes on desktop @real", async ({
	page,
	request,
}) => {
	await reopenSavedConversation(page, request, ".session-header h1");
});
