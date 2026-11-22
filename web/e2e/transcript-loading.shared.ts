import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * Opening an agent whose transcript the daemon has not found yet (a session
 * file not written, a lookup that missed, a slow home node) shows loading,
 * never "no transcript", and the transcript as soon as it is found. Only a
 * harness that keeps none says so. The mock holds a transcript back with
 * `/__mock/realtime` `transcript-missing`. Shared by the desktop (Chromium)
 * and iOS (WebKit) suites.
 */

/** The page asks again every 2 s while not found (data/queries.ts POLL_MS). */
const FOUND_MS = 5000;
/** The notice says why after 6 s (session/TranscriptMissing.tsx). */
const NOTICE_MS = 9000;

async function change(request: APIRequestContext, body: object) {
	const res = await request.post("/api/v1/__mock/realtime", {
		headers: { "X-Pulsar": "1" },
		data: body,
	});
	expect(res.ok()).toBe(true);
	return (await res.json()) as Record<string, string>;
}

/** A fresh agent of its own, so no other test sees its transcript held back. */
async function freshAgent(request: APIRequestContext): Promise<string> {
	const { id } = await change(request, {
		action: "add-agent",
		name: `tl-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
	});
	return id!;
}

/** Records whether a "no transcript" notice was ever on the page. */
async function watchForNone(page: Page) {
	await page.addInitScript(() => {
		const w = window as { __sawNone?: string };
		const check = () => {
			const text = document.body?.textContent ?? "";
			if (/doesn't share|No transcript for this/.test(text))
				w.__sawNone ??= text.slice(0, 200);
		};
		new MutationObserver(check).observe(document, {
			subtree: true,
			childList: true,
			characterData: true,
		});
	});
}

const sawNone = (page: Page) =>
	page.evaluate(() => (window as { __sawNone?: string }).__sawNone ?? null);

const open = (page: Page, id: string) =>
	page.goto(`/#/a/${encodeURIComponent(id)}`);

export function transcriptLoadingSuite(phone: boolean) {
	const events = (page: Page) => page.locator(".transcript .ev");
	const skeleton = (page: Page) => page.locator(".transcript-skel");
	const notice = (page: Page) => page.locator("[data-transcript-missing]");

	test.afterAll(async ({ request }) => {
		await change(request, { action: "restore" });
	});

	test("a transcript not found yet loads, then shows once found", async ({
		page,
		request,
	}) => {
		const id = await freshAgent(request);
		await change(request, {
			action: "transcript-missing",
			id,
			missing: "not_found",
		});
		await watchForNone(page);
		await open(page, id);
		await expect(skeleton(page)).toBeVisible();
		// Several "not found" pages later: still loading, no notice.
		await page.waitForTimeout(2500);
		await expect(skeleton(page)).toBeVisible();
		await expect(notice(page)).toHaveCount(0);
		await expect(events(page)).toHaveCount(0);
		// Found: the next page shows it, with no reload (the stream covers
		// the key, so only the not-found poll can bring it).
		await change(request, { action: "transcript-missing", id, missing: null });
		await expect(events(page).first()).toBeVisible({ timeout: FOUND_MS });
		await expect(skeleton(page)).toHaveCount(0);
		await expect(notice(page)).toHaveCount(0);
		expect(await sawNone(page)).toBeNull();
	});

	test("a slow page shows loading, never the notice", async ({
		page,
		request,
	}) => {
		const id = await freshAgent(request);
		await change(request, {
			action: "transcript-missing",
			id,
			missing: null,
			delayMs: 2500,
		});
		await watchForNone(page);
		await open(page, id);
		await expect(skeleton(page)).toBeVisible();
		await expect(events(page).first()).toBeVisible({ timeout: FOUND_MS });
		expect(await sawNone(page)).toBeNull();
		await expect(notice(page)).toHaveCount(0);
	});

	test("still not found: the reason, with Retry", async ({ page, request }) => {
		const id = await freshAgent(request);
		await change(request, {
			action: "transcript-missing",
			id,
			missing: "no_session",
		});
		await watchForNone(page);
		await open(page, id);
		const n = notice(page);
		await expect(n).toHaveAttribute("data-transcript-missing", "no_session", {
			timeout: NOTICE_MS,
		});
		await expect(n).toContainText("No transcript yet.");
		await expect(n).toContainText("hasn't started a session for this agent");
		await expect(skeleton(page)).toHaveCount(0);
		// Retry asks for the page now (still missing: the notice stays).
		const retry = n.getByRole("button", { name: "Retry" });
		const asked = page.waitForRequest((r) =>
			r.url().includes(`/agents/${encodeURIComponent(id)}/transcript`),
		);
		if (phone) await retry.tap();
		else await retry.click();
		await asked;
		await expect(n).toHaveAttribute("data-transcript-missing", "no_session");
		// Found: it shows without a reload.
		await change(request, { action: "transcript-missing", id, missing: null });
		await expect(events(page).first()).toBeVisible({ timeout: FOUND_MS });
		await expect(notice(page)).toHaveCount(0);
		expect(await sawNone(page)).toBeNull();
	});

	test("a harness that keeps no transcript says so plainly", async ({
		page,
		request,
	}) => {
		const id = await freshAgent(request);
		await change(request, {
			action: "transcript-missing",
			id,
			missing: "unsupported",
		});
		await open(page, id);
		const n = notice(page);
		await expect(n).toHaveAttribute("data-transcript-missing", "unsupported");
		await expect(n).toHaveText(
			"No transcript for this agent. You can still message it; replies show here.",
		);
		await expect(skeleton(page)).toHaveCount(0);
		// The composer still works.
		await expect(page.locator(".composer-input")).toBeVisible();
	});
}
