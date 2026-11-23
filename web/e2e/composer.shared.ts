import type { APIRequestContext, Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * Composer attachments, the `@` file menu and Stop (features/composer):
 * pick, paste and drop files, tiles with progress and Retry, the bubble's
 * chips, `@` mentions as chips, and Stop in place of Send. The mock checks
 * the manifest and hashes like the daemon. Shared by composer.desktop.e2e.ts
 * and composer.ios.e2e.ts.
 */

/** A 1×1 PNG. */
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
export const PNG = Buffer.from(PNG_B64, "base64");

/** The app with the e2e hook and a passkey session (the mock's, no WebAuthn). */
export async function openAgent(
	page: Page,
	request: APIRequestContext,
	selector: string,
) {
	await page.addInitScript(() => {
		(window as { __pulsarE2E?: object }).__pulsarE2E = {};
	});
	await ready(page);
	const res = await request.post("/api/v1/__mock/session", {
		headers: { "X-Pulsar": "1" },
	});
	const { token } = (await res.json()) as { token: string };
	const id = await agentId(request, selector);
	await page.evaluate(
		({ token, id }) => {
			(
				window as unknown as {
					__pulsarE2E: { setSessionToken: (t: string) => void };
				}
			).__pulsarE2E.setSessionToken(token);
			location.hash = `#/a/${encodeURIComponent(id)}`;
		},
		{ token, id },
	);
	const composer = page.locator(".composer").last();
	await expect(composer.locator(".composer-input")).toBeVisible();
	// The drop and paste handlers come with the composer's lazy chunk (and
	// the agent's row): a paste before then is the browser's own.
	await expect(composer).toHaveAttribute("data-attach", "ready");
	return composer;
}

export function composerSuite(platform: "desktop" | "phone") {
	const phone = platform === "phone";

	test(`attach from the picker, send, and the bubble shows the files (${platform})`, async ({
		page,
		request,
	}) => {
		const composer = await openAgent(page, request, "name=apparish-auth");
		if (phone) {
			await composer.getByRole("button", { name: "Attach files" }).click();
			const menu = page.getByRole("menu", { name: "Attach" });
			await expect(
				menu.getByRole("menuitem", { name: "Photo Library" }),
			).toBeVisible();
			await expect(
				menu.getByRole("menuitem", { name: "Choose Files" }),
			).toBeVisible();
			await page.locator(".m-menu-shade").click();
		} else
			await expect(
				composer.getByRole("button", { name: "Attach files" }),
			).toHaveAttribute("title", "Attach files");
		await composer.getByTestId("attach-files").setInputFiles([
			{
				name: "notes.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("hello\n"),
			},
			{ name: "shot.png", mimeType: "image/png", buffer: PNG },
		]);
		const tiles = composer.getByTestId("attachment");
		await expect(tiles).toHaveCount(2);
		await expect(tiles.nth(0)).toHaveAttribute("data-state", "done");
		await expect(tiles.nth(1)).toHaveAttribute("data-state", "done");
		await expect(tiles.nth(1).locator("img")).toBeVisible();
		// Files alone are a message.
		const send = composer.getByRole("button", { name: "Send", exact: true });
		await expect(send).toBeEnabled();
		await composer.locator(".composer-input").fill("Look at these");
		await send.click();
		await expect(tiles).toHaveCount(0);
		const bubble = page.locator(".ds-turn--user").last();
		await expect(bubble).toContainText("Look at these");
		const files = bubble.getByRole("list", { name: "Attachments" });
		await expect(files).toContainText("notes.txt");
		await expect(files.locator("img")).toHaveAttribute("alt", "shot.png");
		await expect(bubble).not.toContainText("Attached:");
	});

	test(`limits, a failed upload's Retry, and removing a file (${platform})`, async ({
		page,
		request,
		errors,
	}) => {
		const composer = await openAgent(page, request, "name=apparish-auth");
		const input = composer.getByTestId("attach-files");
		await input.setInputFiles([
			{ name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
		]);
		await expect(
			page.getByText("'empty.txt' is empty or could not be read."),
		).toBeVisible();
		await input.setInputFiles(
			Array.from({ length: 11 }, (_, i) => ({
				name: `f${i}.txt`,
				mimeType: "text/plain",
				buffer: Buffer.from(`file ${i}`),
			})),
		);
		await expect(
			page.getByText("You can attach up to 10 files per message."),
		).toBeVisible();
		const tiles = composer.getByTestId("attachment");
		await expect(tiles).toHaveCount(10);
		// On the phone the toasts slide in over the tiles (bottom-center): a
		// click during that slide lands on the toast and removes nothing.
		// Click once they are gone (sonner's 4 s, plus its exit).
		await expect(page.locator(".p-toast-card")).toHaveCount(0, {
			timeout: 10_000,
		});
		for (let i = 9; i >= 0; i--)
			await composer.getByRole("button", { name: `Remove f${i}.txt` }).click();
		await expect(tiles).toHaveCount(0);

		// The mock drops a `flaky…` file's first upload.
		await input.setInputFiles([
			{ name: "flaky.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
		]);
		await expect(tiles.first()).toHaveAttribute("data-state", "failed");
		const send = composer.getByRole("button", { name: "Send", exact: true });
		await composer.locator(".composer-input").fill("with a file");
		await expect(send).toBeDisabled();
		await expect(send).toHaveAttribute(
			"title",
			"Remove or retry the file that failed",
		);
		await composer.getByRole("button", { name: /^Retry flaky\.txt/ }).click();
		await expect(tiles.first()).toHaveAttribute("data-state", "done");
		await expect(send).toBeEnabled();
		// The dropped upload logged its 503.
		errors.splice(
			0,
			errors.length,
			...errors.filter((e) => !/status of 503/.test(e)),
		);
	});

	test(`@ opens the file menu; a pick is a chip that deletes as one (${platform})`, async ({
		page,
		request,
	}) => {
		const composer = await openAgent(page, request, "name=apparish-auth");
		const field = composer.locator(".composer-input");
		await field.click();
		await field.pressSequentially("see @composer");
		const menu = page.getByRole("listbox", { name: "Files" });
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("option").first()).toContainText(
			"Composer.tsx",
		);
		await expect(menu.getByRole("option").first()).toContainText(
			"web/src/components",
		);
		await field.press("Enter");
		await expect(menu).toHaveCount(0);
		await expect(field).toHaveValue("see @web/src/components/Composer.tsx ");
		await expect(composer.locator(".mention-chip")).toContainText(
			"Composer.tsx",
		);
		// Backspace takes the whole mention.
		await field.press("Backspace");
		await expect(field).toHaveValue("see ");
		await expect(composer.locator(".mention-chip")).toHaveCount(0);
		// Nothing matches.
		await field.pressSequentially("@zzzq");
		await expect(menu).toContainText("No matching files or folders.");
		await field.press("Escape");
		await expect(menu).toHaveCount(0);
	});

	test(`Stop replaces Send while the agent works and the draft is empty (${platform})`, async ({
		page,
		request,
	}) => {
		const composer = await openAgent(
			page,
			request,
			"name=codex@apparish status=busy",
		);
		const stop = composer.getByRole("button", { name: "Stop turn" });
		await expect(stop).toBeVisible();
		await expect(
			composer.getByRole("button", { name: "Send", exact: true }),
		).toHaveCount(0);
		await composer.locator(".composer-input").fill("wait");
		await expect(stop).toHaveCount(0);
		await expect(
			composer.getByRole("button", { name: "Send", exact: true }),
		).toBeVisible();
		await composer.locator(".composer-input").fill("");
		await stop.click();
		// Stop always confirms.
		if (phone)
			await expect(page.getByText("Stop codex@apparish's turn?")).toBeVisible();
		else
			await expect(
				page.getByRole("alertdialog").getByText("Stop codex@apparish?"),
			).toBeVisible();
	});
}
