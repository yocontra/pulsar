import type { Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * Message search (web/src/features/search): Cmd-K's "In messages" group on
 * the desktop, the search page on the phone, and the find bar a hit opens
 * in its session. Shared by search.desktop.e2e.ts and search.ios.e2e.ts.
 */

const findBar = (page: Page) =>
	page.getByRole("search", { name: "Find in messages" });

/** The session's find bar is open, prefilled, on match `n` of `of`, and the match is on screen. */
async function expectAtMatch(page: Page, q: string) {
	const bar = findBar(page);
	await expect(bar).toBeVisible();
	await expect(bar.getByRole("searchbox")).toHaveValue(q);
	await expect(bar).toContainText(/\d+ of \d+/);
}

export function searchSuite(platform: "desktop" | "phone") {
	const phone = platform === "phone";

	test(`a message hit opens its session at the match with the find bar (${platform})`, async ({
		page,
	}) => {
		await ready(page);
		if (phone) {
			await page.getByRole("button", { name: "Search messages" }).click();
			const box = page.locator(".p-search-page ion-searchbar input");
			await box.fill("fa");
			// One short word: nothing is searched yet.
			await expect(
				page.getByText("Type a word of 3 letters or more."),
			).toBeVisible();
			await box.fill("fake timers");
			const list = page.getByRole("list", { name: "Messages" });
			const first = list.locator(".msr-row").first();
			await expect(first).toBeVisible();
			await expect(first.locator(".msr-who")).toHaveText("Agent:");
			await expect(first.locator("mark").first()).toHaveText(/fake|timers/i);
			await first.click();
		} else {
			await page.keyboard.press("ControlOrMeta+k");
			const dialog = page.getByRole("dialog", { name: "Search the pool" });
			await dialog.getByLabel("Search").fill("fake timers");
			await expect(
				dialog.locator(".d-pal-group", { hasText: "In messages" }),
			).toBeVisible();
			const hit = dialog
				.getByRole("option")
				.filter({ has: page.locator(".msr-snip") })
				.first();
			await expect(hit.locator(".msr-who")).toHaveText("Agent:");
			await expect(hit.locator("mark")).toHaveText(["fake", "timers"]);
			await hit.click();
			await expect(dialog).toBeHidden();
		}
		await expectAtMatch(page, "fake timers");
		// The chosen message is the current match, on screen.
		const current = page
			.locator("section.session")
			.last()
			.locator("[data-find-current]");
		await expect(current).toHaveCount(1);
		await expect(current).toContainText(/fake timers/i);
		await expect(current).toBeInViewport();
		await findBar(page).getByRole("button", { name: "Close find" }).click();
		await expect(findBar(page)).toBeHidden();
	});

	test(`the find bar steps to an older match that needs earlier pages (${platform})`, async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		const res = await request.get(
			`/api/v1/search/messages?q=${encodeURIComponent("fake timers")}&agent=${encodeURIComponent(id)}`,
			{ headers: { "X-Pulsar": "1" } },
		);
		const body = (await res.json()) as {
			hits: { eventId: string; cursor: string | null }[];
		};
		// The oldest match is behind "load earlier".
		const oldest = body.hits[0]!;
		expect(oldest.cursor).not.toBeNull();
		await ready(page);
		await page.evaluate((id) => {
			location.hash = `#/a/${encodeURIComponent(id)}`;
		}, id);
		await page
			.getByRole("button", { name: "Find in messages", exact: true })
			.click();
		const bar = findBar(page);
		await bar.getByRole("searchbox").fill("fake timers");
		await expect(bar).toContainText(
			`${body.hits.length} of ${body.hits.length}`,
		);
		// Wraps from the newest to the oldest.
		await bar.getByRole("searchbox").press("Enter");
		await expect(bar).toContainText(`1 of ${body.hits.length}`);
		const el = page
			.locator("section.session")
			.last()
			.locator(`[data-ev-id="${oldest.eventId}"]`);
		await expect(el).toBeInViewport();
		await expect(el).toHaveAttribute("data-find-current", "");
		await bar.getByRole("button", { name: "Next match" }).click();
		await expect(bar).toContainText(`2 of ${body.hits.length}`);
		await bar.getByRole("button", { name: "Previous match" }).click();
		await expect(bar).toContainText(`1 of ${body.hits.length}`);
		// No matches: the steps are off.
		await bar.getByRole("searchbox").fill("zzqqxx");
		await expect(bar).toContainText("No matches");
		// Nothing stays marked.
		await expect(page.locator("[data-find-current]")).toHaveCount(0);
		await expect(
			bar.getByRole("button", { name: "Next match" }),
		).toBeDisabled();
		await bar.getByRole("searchbox").press("Escape");
		await expect(bar).toBeHidden();
		await expect(page.locator("[data-find-current]")).toHaveCount(0);
	});

	test(`leaving a session closes its find bar (${platform})`, async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await ready(page);
		await page.evaluate((id) => {
			location.hash = `#/a/${encodeURIComponent(id)}`;
		}, id);
		await page
			.getByRole("button", { name: "Find in messages", exact: true })
			.click();
		await findBar(page).getByRole("searchbox").fill("fake timers");
		await expect(findBar(page)).toContainText(/\d+ of \d+/);
		await page.evaluate(() => {
			location.hash = "#/";
		});
		await expect(findBar(page)).toBeHidden();
		await page.evaluate((id) => {
			location.hash = `#/a/${encodeURIComponent(id)}`;
		}, id);
		await expect(
			page.getByRole("button", { name: "Find in messages", exact: true }),
		).toBeVisible();
		await expect(findBar(page)).toBeHidden();
	});

	test(`a search that fails says so and offers Retry (${platform})`, async ({
		page,
		request,
		errors,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await ready(page);
		await page.evaluate((id) => {
			location.hash = `#/a/${encodeURIComponent(id)}`;
		}, id);
		await page.route("**/api/v1/search/messages?**", (r) =>
			r.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({
					error: { code: "unavailable", message: "down" },
				}),
			}),
		);
		await page
			.getByRole("button", { name: "Find in messages", exact: true })
			.click();
		const bar = findBar(page);
		await bar.getByRole("searchbox").fill("fake timers");
		await expect(bar).toContainText("Couldn't search");
		await expect(page.locator("[data-find-current]")).toHaveCount(0);
		await page.unroute("**/api/v1/search/messages?**");
		await bar.getByRole("button", { name: "Retry" }).click();
		await expect(bar).toContainText(/\d+ of \d+/);
		// The refused request logged its status: expected here.
		errors.splice(
			0,
			errors.length,
			...errors.filter((e) => !/status of 503/.test(e)),
		);
	});

	test(`with search off, the entry points say so (${platform})`, async ({
		page,
		request,
	}) => {
		// The daemon leaves "search" out of hello's features under PULSAR_NO_SEARCH.
		await page.route("**/api/v1/hello**", async (r) => {
			const res = await r.fetch();
			const body = (await res.json()) as { features: string[] };
			body.features = body.features.filter((f) => f !== "search");
			await r.fulfill({ response: res, json: body });
		});
		const id = await agentId(request, "name=apparish-auth");
		await ready(page);
		if (phone)
			await expect(
				page
					.getByRole("button", { name: "Agents" })
					.or(page.locator("ion-header").first()),
			).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Search messages" }),
		).toHaveCount(0);
		await page.evaluate((id) => {
			location.hash = `#/a/${encodeURIComponent(id)}`;
		}, id);
		const find = page.getByRole("button", {
			name: "Find in messages",
			exact: true,
		});
		await expect(find).toBeDisabled();
		await expect(
			page.locator("span[title^='Message search is off']", { has: find }),
		).toHaveCount(1);
	});
}
