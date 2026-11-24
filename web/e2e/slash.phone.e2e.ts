import type { Locator, Page } from "@playwright/test";
import { openAgent, plusMenu } from "./composer.shared.ts";
import { agentId, expect, test } from "./fixtures.ts";
import { ran, slashSuite } from "./slash.shared.ts";

slashSuite("phone");

/** Opens the command sheet from the composer's + menu; resolves once its
 *  rows show. */
async function openSheet(page: Page, composer: Locator) {
	await (await plusMenu(page, composer))
		.getByRole("menuitem", { name: "Skills & Commands" })
		.click();
	const sheet = page.getByTestId("slash-sheet");
	await expect(
		sheet.getByRole("button", { name: "/compact", exact: true }),
	).toBeVisible();
	return sheet;
}

/** Scrolls the sheet's list to its end; the last row's bottom edge. */
async function scrollToEnd(sheet: Locator) {
	const body = sheet.locator(".p-sheet-body");
	await body.evaluate((b) => {
		b.scrollTop = b.scrollHeight;
	});
	await expect
		.poll(() =>
			body.evaluate((b) => b.scrollTop + b.clientHeight >= b.scrollHeight - 1),
		)
		.toBe(true);
	const last = sheet.locator(".slash-row").last();
	return (await last.boundingBox())!.y + (await last.boundingBox())!.height;
}

/** Sets the app's inset variables (emulation reports none). */
const insets = (page: Page, v: { sab?: number; kb?: number }) =>
	page.evaluate(({ sab, kb }) => {
		const r = document.documentElement.style;
		if (sab !== undefined) r.setProperty("--sab", `${sab}px`);
		if (kb !== undefined) r.setProperty("--kb", `${kb}px`);
	}, v);

test("+ → Skills & Commands opens the command sheet: search, tap inserts, Run sends (phone)", async ({
	page,
	request,
}) => {
	const composer = await openAgent(page, request, "name=apparish-auth");
	const id = await agentId(request, "name=apparish-auth");
	const sheet = await openSheet(page, composer);
	await expect(
		page.getByRole("dialog", { name: "Skills & Commands" }),
	).toBeVisible();
	await sheet.getByPlaceholder("Search commands and skills").fill("ship");
	await sheet.getByRole("button", { name: "/ship", exact: true }).click();
	await expect(composer.locator(".composer-input")).toHaveValue("/ship ");
	// A command that takes nothing runs from the sheet in one tap.
	await openSheet(page, composer);
	await sheet.getByPlaceholder("Search commands and skills").fill("recap");
	await sheet.getByRole("button", { name: "Run /recap", exact: true }).click();
	await expect(
		page.getByText("Ran /recap in apparish-auth's session"),
	).toBeVisible();
	expect(await ran(request)).toContainEqual({ agent: id, line: "/recap" });
});

test("the command sheet: search under the header, one scroller, rows clear the insets (phone)", async ({
	page,
	request,
}) => {
	const composer = await openAgent(page, request, "name=apparish-auth");
	await insets(page, { sab: 34 });
	const sheet = await openSheet(page, composer);
	const field = sheet.getByPlaceholder("Search commands and skills");
	// Sections, in the platform's grouped lists.
	await expect(sheet.getByRole("region", { name: "Commands" })).toBeVisible();
	await expect(sheet.getByRole("region", { name: "Skills" })).toBeAttached();
	// The field sits under the header, with room (not flush to it). Both
	// read in one frame: the sheet may still be sliding in.
	const gap = await sheet.evaluate((m) => {
		const head = m.querySelector(".p-sheet-head")!.getBoundingClientRect();
		const bar = m.querySelector(".k-searchbar")!.getBoundingClientRect();
		return bar.top - head.bottom;
	});
	expect(gap).toBeGreaterThanOrEqual(8);
	// The slide-in has settled: the header holds still across two frames.
	await expect
		.poll(() =>
			sheet.evaluate(async (m) => {
				const y = () =>
					m.querySelector(".p-sheet-head")!.getBoundingClientRect().y;
				const before = y();
				await new Promise((r) =>
					requestAnimationFrame(() => requestAnimationFrame(r)),
				);
				return y() === before;
			}),
		)
		.toBe(true);
	const fieldTop = (await field.boundingBox())!.y;
	// Tap targets.
	for (const row of await sheet
		.locator(".slash-row")
		.all()
		.then((r) => r.slice(0, 4)))
		expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	// One scroller: the list. Nothing else in the sheet scrolls.
	const scrollers = await sheet.evaluate((m) =>
		[...m.querySelectorAll<HTMLElement>("*")]
			.filter((el) => {
				const o = getComputedStyle(el).overflowY;
				return (
					(o === "auto" || o === "scroll") &&
					el.scrollHeight > el.clientHeight + 1
				);
			})
			.map((el) => el.className),
	);
	expect(scrollers).toHaveLength(1);
	expect(scrollers[0]).toContain("p-sheet-body");
	// At the opening detent the list scrolls to its end: the field stays put,
	// and the last row clears the home indicator.
	const bottom = await scrollToEnd(sheet);
	expect((await field.boundingBox())!.y).toBe(fieldTop);
	await expect(field).toBeInViewport();
	const vh = await page.evaluate(() => innerHeight);
	expect(bottom).toBeLessThanOrEqual(vh - 34);
});

test("the command sheet: typing expands it and the list clears the keyboard (phone)", async ({
	page,
	request,
}) => {
	const composer = await openAgent(page, request, "name=apparish-auth");
	const sheet = await openSheet(page, composer);
	const top = (await sheet.locator(".p-sheet-head").boundingBox())!.y;
	await sheet.getByPlaceholder("Search commands and skills").click();
	// The sheet moves to its full height (one move, not a jump per keystroke).
	await expect
		.poll(async () => (await sheet.locator(".p-sheet-head").boundingBox())!.y)
		.toBeLessThan(top);
	await insets(page, { kb: 300 });
	const bottom = await scrollToEnd(sheet);
	const vh = await page.evaluate(() => innerHeight);
	expect(bottom).toBeLessThanOrEqual(vh - 300);
});

test("the command sheet: a keyboard focus rings the row, a press does not (phone)", async ({
	page,
	request,
	browserName,
}) => {
	const composer = await openAgent(page, request, "name=apparish-auth");
	const sheet = await openSheet(page, composer);
	const row = sheet.locator(".slash-row").first();
	const ring = () =>
		row.evaluate((el) => {
			const s = getComputedStyle(el);
			return s.outlineStyle === "none" ? "none" : s.outlineWidth;
		});
	// A press (pointer down, released off the row so nothing inserts).
	const box = (await row.boundingBox())!;
	await page.mouse.move(box.x + 40, box.y + box.height / 2);
	await page.mouse.down();
	expect(await ring()).toBe("none");
	await page.mouse.move(box.x + 40, 5);
	await page.mouse.up();
	expect(await ring()).toBe("none");
	// The search field keeps Konsta's look: no app outline on it.
	const field = sheet.getByPlaceholder("Search commands and skills");
	await field.focus();
	expect(await field.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
		"none",
	);
	// Tab from the field to the first row: the row shows the ring.
	for (let i = 0; i < 4; i++) {
		// WebKit tabs to buttons with Option held (macOS's default).
		await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
		if (
			await page.evaluate(() =>
				document.activeElement?.classList.contains("slash-insert"),
			)
		)
			break;
	}
	await expect(sheet.locator(".slash-insert:focus")).toHaveCount(1);
	expect(
		await sheet
			.locator(".slash-row:has(.slash-insert:focus)")
			.evaluate((el) => getComputedStyle(el).outlineWidth),
	).toBe("2px");
});

test("the command sheet: a drag on the scrolled list scrolls, not the sheet; the header drags it (phone)", async ({
	page,
	request,
}) => {
	const composer = await openAgent(page, request, "name=apparish-auth");
	const sheet = await openSheet(page, composer);
	const top = () =>
		sheet.evaluate(
			(m) =>
				m.shadowRoot!.querySelector(".modal-wrapper")!.getBoundingClientRect()
					.top,
		);
	await expect
		.poll(async () => {
			const a = await top();
			await page.waitForTimeout(100);
			return (await top()) === a;
		})
		.toBe(true);
	const before = await top();
	// Scroll a row into the middle of the list.
	const row = sheet.locator(".slash-row:not(.is-off)").nth(6);
	await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
	const body = sheet.locator(".p-sheet-body");
	expect(await body.evaluate((b) => b.scrollTop)).toBeGreaterThan(0);
	// Drag down on it (mouse: Ionic's sheet gesture takes both).
	const box = (await row.boundingBox())!;
	const x = box.x + 60;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	for (let i = 1; i <= 10; i++) {
		await page.mouse.move(x, y + 15 * i);
		await page.waitForTimeout(20);
	}
	// Read mid-drag: a short drag would snap back to the detent on release.
	expect(Math.abs((await top()) - before)).toBeLessThan(2);
	// Release off the row, so it is not a tap that inserts.
	await page.mouse.move(x, 5);
	await page.mouse.up();
	await expect(
		page.getByRole("dialog", { name: "Skills & Commands" }),
	).toBeVisible();
	await expect(composer.locator(".composer-input")).toHaveValue("");
	// Drag the header to the bottom, beyond the dismissal breakpoint.
	const head = (await sheet.locator(".p-sheet-head h2").boundingBox())!;
	await page.mouse.move(head.x + 10, head.y + 5);
	await page.mouse.down();
	await page.mouse.move(head.x + 10, page.viewportSize()!.height - 1, {
		steps: 12,
	});
	await page.mouse.up();
	await expect(page.getByTestId("slash-sheet")).toHaveCount(0);
});

test("the mode chip above the composer opens the mode sheet (phone)", async ({
	page,
	request,
}) => {
	const composer = await openAgent(page, request, "name=codex@apparish");
	const chip = composer.getByTestId("mode-chip");
	await expect(chip).toHaveText("Default");
	await chip.click();
	await page.getByRole("button", { name: "Plan", exact: true }).click();
	await expect(page.getByText("codex@apparish is in Plan mode")).toBeVisible();
});

test("the agent page's More menu has Mode… (phone)", async ({
	page,
	request,
}) => {
	await openAgent(page, request, "name=chat-blocks");
	await page
		.getByTestId("agent-actions")
		.getByRole("button", { name: "More", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Mode…" }).click();
	await expect(page.getByText(/^Now: Manual/)).toBeVisible();
	await page.getByRole("button", { name: "Accept edits", exact: true }).click();
	await expect(
		page.getByText("chat-blocks is in Accept edits mode"),
	).toBeVisible();
});
