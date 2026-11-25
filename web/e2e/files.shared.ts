import type { Locator, Page } from "@playwright/test";
import { agentId, expect } from "./fixtures.ts";

/**
 * The file viewer (web/src/features/files) and the file references that
 * open it (web/src/session/file-ref.tsx), shared by the desktop and iOS
 * suites. The chat-blocks gallery runs in /work/demo; its last reply links
 * a file inside that folder (`src/auth/refresh.ts`), an absolute path inside
 * it (`/work/demo/out/qa/report.html`), one outside (`/tmp/demo-run.log`)
 * and a web page (web/mock/blocks.ts). Files come from web/mock/files.ts.
 */

/** Records what the app copies (the clipboard itself differs per browser). */
export async function recordCopies(page: Page) {
	await page.addInitScript(() => {
		const w = window as unknown as { __copied: string[] };
		w.__copied = [];
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (t: string) => {
					w.__copied.push(t);
				},
			},
		});
	});
}

export const copies = (page: Page) =>
	page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

export const fileUrl = (id: string, path: string) =>
	new RegExp(
		`#/file/${encodeURIComponent(id)}\\?path=${encodeURIComponent(path).replace(/[.]/g, "\\.")}$`,
	);

/** Opens the gallery agent; returns its id. */
export async function openGallery(page: Page) {
	const id = await agentId(page.request, "fixture=blocks");
	await page.goto(`/#/a/${encodeURIComponent(id)}`);
	await expect(ref(page, "QA report")).toBeVisible({ timeout: 15_000 });
	return id;
}

export const ref = (page: Page, name: string) =>
	page
		.locator(".ds-conv")
		.first()
		.getByRole("button", { name, exact: true })
		.last();

/** File references: inside the folder they open the viewer, outside they copy. */
export async function expectRefs(page: Page) {
	const conv = page.locator(".ds-conv").first();
	await expect(
		conv.locator('a[href*="/work/demo"], a[href^="/tmp"]'),
	).toHaveCount(0);
	await expect(ref(page, "QA report")).toHaveAttribute(
		"title",
		"Open out/qa/report.html",
	);
	await expect(ref(page, "refresh.ts")).toHaveAttribute(
		"title",
		"Open src/auth/refresh.ts",
	);
	await expect(ref(page, "run log")).toHaveAttribute(
		"title",
		"Copy /tmp/demo-run.log",
	);
	const docs = conv.getByRole("link", { name: "docs", exact: true });
	await expect(docs).toHaveAttribute("target", "_blank");
}

/** Clicking an outside path copies it and stays on the page. */
export async function expectCopyOutside(page: Page) {
	const before = page.url();
	await ref(page, "run log").click();
	await expect(page.getByText("Path copied")).toBeVisible();
	expect(await copies(page)).toContain("/tmp/demo-run.log");
	expect(page.url()).toBe(before);
}

/** Exercise the read-only viewer with an external keyboard. */
export async function expectFileKeys(view: Locator) {
	const code = view
		.getByRole("region", { name: "File contents: refresh.ts" })
		.locator("pre");
	const status = view.getByText(/^Line \d+ of \d+$/);
	await expect(view.locator(".fv-hl")).toContainText(
		"export async function refresh",
	);
	await code.focus();
	await code.press("ArrowDown");
	await expect(status).toHaveText("Line 8 of 12");
	await code.press("Home");
	await expect(status).toHaveText("Line 1 of 12");
	await code.press("End");
	await expect(status).toHaveText("Line 12 of 12");
	await code.press("Control+f");
	const find = view.getByRole("searchbox", { name: "Find in file" });
	await expect(find).toBeFocused();
	await find.fill("session");
	await expect(view.getByText(/^1 of \d+ matching lines$/)).toBeVisible();
	await find.press("Enter");
	await expect(view.getByText(/^2 of \d+ matching lines$/)).toBeVisible();
	await find.press("Shift+Enter");
	await expect(view.getByText(/^1 of \d+ matching lines$/)).toBeVisible();
	await find.press("Escape");
	await expect(code).toBeFocused();
	await code.press("Control+g");
	const line = view.getByRole("spinbutton", { name: "Line number" });
	await expect(line).toBeFocused();
	await line.fill("4");
	await line.press("Enter");
	await expect(code).toBeFocused();
	await expect(status).toHaveText("Line 4 of 12");
	await expect(view.locator(".fv-hl")).toContainText("const lock");
}
