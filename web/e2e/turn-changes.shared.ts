import { agentId, expect, test } from "./fixtures.ts";

/**
 * The end-of-turn change summary, on the chat-blocks gallery agent
 * (fixture=blocks, web/mock/blocks.ts): each turn that edited files ends in
 * "Changed N files +A −R", which opens to the files; a file opens its diff,
 * "Show all diffs" opens every file's diff.
 */
export function turnChangesSuite(platform: "desktop" | "phone") {
	test(`a turn's changed files and their diffs (${platform})`, async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "fixture=blocks");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const conv = page.locator(".ds-conv").first();
		// The Codex turn: one apply_patch over three files.
		const codex = conv
			.locator(".ds-turn--assistant")
			.filter({ has: page.locator('[data-tool="apply_patch"]') })
			.locator("[data-turn-changes]");
		await expect(codex).toHaveCount(1);
		await expect(codex).toHaveAttribute("data-turn-changes", "3");
		const head = codex.locator(".ds-turnchg-head");
		await head.scrollIntoViewIfNeeded();
		await expect(head).toContainText("+2");
		await expect(head).toContainText("−1");
		await expect(head).toHaveAttribute("aria-expanded", "false");
		await head.click();
		await expect(head).toHaveAttribute("aria-expanded", "true");

		const files = codex.locator(".ds-turnchg-item");
		await expect(files).toHaveCount(3);
		await expect(files.nth(0)).toHaveAttribute("data-path", "src/net/retry.ts");
		await expect(files.nth(1)).toContainText("index.ts");
		await expect(files.nth(2)).toContainText("Deleted");

		// One file: its diff.
		const retry = files.nth(0);
		await retry.locator(".ds-turnchg-file").click();
		const diff = retry.locator(".ds-turnchg-diff");
		await expect(diff).toBeVisible();
		await expect(diff).toHaveClass(
			platform === "desktop" ? /split/ : /unified/,
		);
		await expect(diff).toContainText("tries = 3");
		await expect(codex.locator(".ds-turnchg-diff")).toHaveCount(1);

		// Every file: the turn's combined diff.
		const all = codex.locator(".ds-turnchg-all");
		await expect(all).toHaveText("Show all diffs");
		await all.click();
		await expect(all).toHaveText("Hide all diffs");
		await expect(codex.locator(".ds-turnchg-diff")).toHaveCount(2);
		await expect(files.nth(2)).toContainText("The file was deleted.");
		await all.click();
		await expect(codex.locator(".ds-turnchg-diff")).toHaveCount(0);

		// Closing the summary keeps the transcript as it was.
		await head.click();
		await expect(files).toHaveCount(0);
	});
}
