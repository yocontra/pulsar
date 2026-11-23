import type { Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

/** A phone at 400 px or less keeps Find in the agent bar's More menu. */
const findInMore = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 400;
const findButton = (page: Page) =>
	page.getByRole("button", { name: "Find in messages", exact: true });
const moreButton = (page: Page) =>
	page
		.getByTestId("agent-actions")
		.last()
		.getByRole("button", { name: "More" });

/** Open the agent page's find bar, from the bar or from More. */
async function openFind(page: Page) {
	if (!findInMore(page)) return findButton(page).click();
	await moreButton(page).click();
	await page
		.getByRole("menu")
		.getByRole("menuitem", { name: "Find in Messages" })
		.click();
}

/**
 * Message search (web/src/features/search): Cmd-K's "In messages" group on
 * the desktop, the search page on the phone, and the find bar a hit opens
 * in its session. Shared by search.desktop.e2e.ts and search.ios.e2e.ts.
 */

const findBar = (page: Page) =>
	page.getByRole("search", { name: "Find in messages" });

/**
 * The find bar's match count once its search is done ("N of N", on the
 * newest match). Read from the bar, not from an earlier API call: the mock's
 * sessions are live, and a new matching message can land in between.
 */
async function landed(page: Page): Promise<number> {
	const count = findBar(page).locator(".msr-count");
	await expect(count).toHaveText(/^(\d+) of \1$/);
	return Number((await count.textContent())!.split(" ")[0]);
}

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
			// Home's one search field: it filters the tree and lists matching
			// messages under it ("In messages").
			const box = page.getByLabel("Search agents and messages");
			await box.fill("fa");
			// One short word: no message search yet.
			await page.waitForTimeout(600);
			await expect(page.getByTestId("home-messages")).toHaveCount(0);
			await box.fill("fake timers");
			const list = page.getByRole("region", { name: "In messages" });
			const first = list.locator(".msr-row").first();
			await expect(first).toBeVisible();
			await expect(first.locator(".msr-who")).toHaveText("Agent:");
			await expect(first.locator("mark").first()).toHaveText(/fake|timers/i);
			await first.click();
		} else {
			// The sidebar's Search item (Cmd-K's twin): the tree can paint from
			// the last-screen snapshot before the key handler is attached, and
			// Cmd-K toggles, so pressing it again isn't safe.
			await page.locator("button.d-nav-item", { hasText: "Search" }).click();
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

	if (phone)
		test("Home's In messages opens the search page with the query (phone)", async ({
			page,
		}) => {
			await ready(page);
			await page.getByLabel("Search agents and messages").fill("fake timers");
			const section = page.getByRole("region", { name: "In messages" });
			await expect(section.locator(".msr-row").first()).toBeVisible();
			await section.locator(".msr-all").click();
			await expect(page).toHaveURL(/#\/search\?q=fake(\+|%20)timers$/);
			const box = page.getByLabel("Search messages");
			await expect(box).toHaveValue("fake timers");
			await expect(
				page
					.getByRole("region", { name: "Messages" })
					.locator(".msr-row")
					.first(),
			).toBeVisible();
			// One short word: nothing is searched yet.
			await box.fill("fa");
			await expect(
				page.getByText("Type a word of 3 letters or more."),
			).toBeVisible();
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
		// The session is live: a new match lands after that count (as the
		// mock's own sessions do at any time).
		const added = await request.post("/api/v1/__mock/realtime", {
			headers: { "X-Pulsar": "1" },
			data: {
				action: "transcript",
				id,
				text: "Moved the retry test to fake timers too.",
			},
		});
		expect(added.ok()).toBe(true);
		await ready(page);
		await page.evaluate((id) => {
			location.hash = `#/a/${encodeURIComponent(id)}`;
		}, id);
		await openFind(page);
		const bar = findBar(page);
		await bar.getByRole("searchbox").fill("fake timers");
		const n = await landed(page);
		expect(n).toBeGreaterThan(body.hits.length);
		// Wraps from the newest to the oldest.
		await bar.getByRole("searchbox").press("Enter");
		await expect(bar).toContainText(`1 of ${n}`);
		const el = page
			.locator("section.session")
			.last()
			.locator(`[data-ev-id="${oldest.eventId}"]`);
		await expect(el).toBeInViewport();
		await expect(el).toHaveAttribute("data-find-current", "");
		await bar.getByRole("button", { name: "Next match" }).click();
		await expect(bar).toContainText(`2 of ${n}`);
		await bar.getByRole("button", { name: "Previous match" }).click();
		await expect(bar).toContainText(`1 of ${n}`);
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
		await openFind(page);
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
			findInMore(page) ? moreButton(page) : findButton(page),
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
		await openFind(page);
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
		if (phone) {
			// Home's search field filters the tree only: no "In messages".
			await page.getByLabel("Search agents and messages").fill("fake timers");
			await page.waitForTimeout(800);
			await expect(page.getByTestId("home-messages")).toHaveCount(0);
		}
		await page.evaluate((id) => {
			location.hash = `#/a/${encodeURIComponent(id)}`;
		}, id);
		if (findInMore(page)) {
			await moreButton(page).click();
			await expect(
				page
					.getByRole("menu")
					.getByRole("menuitem", { name: "Find in Messages" }),
			).toBeDisabled();
			return;
		}
		const find = findButton(page);
		await expect(find).toBeDisabled();
		await expect(
			page.locator("span[title^='Message search is off']", { has: find }),
		).toHaveCount(1);
	});

	test(`an older match whose page fails to load leaves nothing marked and no error (${platform})`, async ({
		page,
		request,
		errors,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		const res = await request.get(
			`/api/v1/search/messages?q=${encodeURIComponent("fake timers")}&agent=${encodeURIComponent(id)}`,
			{ headers: { "X-Pulsar": "1" } },
		);
		const oldest = ((await res.json()) as { hits: { cursor: string | null }[] })
			.hits[0]!;
		// The oldest match is behind "load earlier", so stepping to it needs a page.
		expect(oldest.cursor).not.toBeNull();
		await ready(page);
		await page.evaluate((id) => {
			location.hash = `#/a/${encodeURIComponent(id)}`;
		}, id);
		const bar = findBar(page);
		await openFind(page);
		await bar.getByRole("searchbox").fill("fake timers");
		const n = await landed(page);
		// Older pages fail from now on.
		await page.route("**/transcript?cursor=**", (r) =>
			r.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({
					error: { code: "unavailable", message: "down" },
				}),
			}),
		);
		// The oldest match needs an earlier page.
		await bar.getByRole("searchbox").press("Enter");
		await expect(bar).toContainText(`1 of ${n}`);
		await expect(page.locator("[data-find-current]")).toHaveCount(0);
		// Stepping back to a match on screen still lands.
		await bar.getByRole("button", { name: "Previous match" }).click();
		await expect(bar).toContainText(`${n} of ${n}`);
		await expect(
			page.locator("section.session").last().locator("[data-find-current]"),
		).toHaveCount(1);
		// Only the refused requests' own log lines; no unhandled rejection.
		errors.splice(
			0,
			errors.length,
			...errors.filter((e) => !/status of 503/.test(e)),
		);
	});

	test(`the current match stays on screen when the conversation changes size, until the operator scrolls (${platform})`, async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await ready(page);
		await page.evaluate((id) => {
			location.hash = `#/a/${encodeURIComponent(id)}`;
		}, id);
		await openFind(page);
		const bar = findBar(page);
		await bar.getByRole("searchbox").fill("fake timers");
		await landed(page);
		const current = page
			.locator("section.session")
			.last()
			.locator("[data-find-current]");
		await expect(current).toHaveCount(1);
		await current.evaluate((e) => e.setAttribute("data-zz-newest", ""));
		// Step to an older match, away from the end. The mark moves once that
		// match is revealed and pinned: until then `current` is still the
		// newest one, and a touch now would come before the new pin.
		await bar.getByRole("button", { name: "Previous match" }).click();
		await expect(
			page.locator("[data-zz-newest][data-find-current]"),
		).toHaveCount(0);
		await expect(current).toHaveCount(1);
		// On screen and, on the phone, clear of the glass bar and the composer
		// dock that overlay the conversation.
		const uncovered = async (el: typeof current) => {
			await expect(el).toBeInViewport();
			if (!phone) return;
			await expect
				.poll(() =>
					el.evaluate((e) => {
						const r = e.getBoundingClientRect();
						const page = e.closest(".ion-page");
						const bar = page
							?.querySelector("ion-header")
							?.getBoundingClientRect();
						const dock = page
							?.querySelector(".m-composer")
							?.getBoundingClientRect();
						return (
							r.top >= (bar?.bottom ?? 0) - 1 &&
							r.bottom <= (dock?.top ?? innerHeight) + 1
						);
					}),
				)
				.toBe(true);
		};
		await uncovered(current);
		// Something above the match grows (an image or diagram that sized late).
		const grow = () =>
			page.evaluate(() => {
				const cur = document.querySelector(
					"section.session [data-find-current]",
				);
				const turn = cur?.closest(".ds-turn") ?? cur;
				const tall = document.createElement("div");
				tall.className = "zz-grow";
				tall.style.height = "1600px";
				turn?.parentElement?.insertBefore(tall, turn);
			});
		await grow();
		await uncovered(current);
		// The operator scrolls: the match is theirs to leave.
		if (phone) await current.dispatchEvent("touchstart");
		else {
			await current.hover();
			await page.mouse.wheel(0, -200);
		}
		// Released: a scroll that takes the match off screen is not undone, on
		// a scroll or a resize (a pin answers both within a frame). Content
		// growing above is no test: reading above the end turns the browser's
		// scroll anchoring on (AnchorWhileReading), which holds the match on its
		// own, depending on which element the browser anchors to.
		await current.evaluate((e) => {
			let p = e.parentElement;
			while (
				p &&
				!(
					p.scrollHeight > p.clientHeight &&
					/auto|scroll/.test(getComputedStyle(p).overflowY)
				)
			)
				p = p.parentElement;
			p?.scrollBy(0, -1500);
		});
		await grow();
		await page.evaluate(
			() =>
				new Promise((r) =>
					requestAnimationFrame(() => requestAnimationFrame(r)),
				),
		);
		await expect(current).not.toBeInViewport();
	});
}
