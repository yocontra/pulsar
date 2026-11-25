import type { Locator, Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * One color per subagent, everywhere its name shows (lib/agent-color.ts).
 * chat-blocks (web/mock/subagents.ts, web/mock/blocks.ts) led a team:
 * parser (blue, Claude's color) and docs (green) wrote to it, it messaged
 * reviewer (no color: hashed from the name), and its Agent card started
 * "Find other refresh callers". Each name's dot has the same computed color
 * in the subagent list, the conversation (cards, messages) and the
 * subagent's own page; two subagents differ. Shared by desktop and phone.
 */

const SHOW = "pulsar.showFinishedSubagents";

/** The computed color of a dot. */
const paint = (dot: Locator) =>
	dot.evaluate((el) => getComputedStyle(el).backgroundColor);

/** Every name's dot: present, colored (not the fallback), and its value. */
async function colorOf(dot: Locator, name: string): Promise<string> {
	await expect(dot, `${name}'s dot`).toHaveCount(1);
	await dot.scrollIntoViewIfNeeded();
	await expect(dot).toBeVisible();
	const c = await paint(dot);
	expect(c, `${name}'s dot is painted`).not.toMatch(/rgba\(0, 0, 0, 0\)/);
	return c;
}

export function subagentColorSuite(phone: boolean) {
	test("a subagent has one color in the list, the chat and its page", async ({
		page,
		request,
	}) => {
		const lead = await agentId(request, "name=chat-blocks");
		// Its teammates are all done: list them.
		await page.addInitScript((k) => localStorage.setItem(k, "1"), SHOW);
		await ready(page);
		await page.goto(`/#/a/${encodeURIComponent(lead)}`);

		const list = await openList(page, lead, phone);
		const row = (name: string) =>
			list.locator("[data-subagent]").filter({
				has: page.getByText(name, { exact: true }),
			});
		await expect(list.locator("[data-subagent] .ds-avatar")).toHaveCount(0);
		const listed = {
			parser: await colorOf(row("parser").locator(".ds-agent-mark"), "parser"),
			reviewer: await colorOf(
				row("reviewer").locator(".ds-agent-mark"),
				"reviewer",
			),
			task: await colorOf(
				row("Find other refresh callers").locator(".ds-agent-mark"),
				"Find other refresh callers",
			),
		};
		await expect(row("parser").locator(".ds-agent-mark")).toHaveAttribute(
			"data-agent-color",
			"blue",
		);
		// Two subagents, two colors.
		expect(listed.parser).not.toBe(listed.reviewer);
		if (phone) await closeList(page, lead);

		const conv = page.locator(".ds-conv").last();
		// A teammate's message: the dot and the stripe.
		const notice = conv
			.locator(".ds-notice-turn")
			.filter({ hasText: "Four fixes ready for review" });
		expect(await colorOf(notice.locator(".ds-agent-mark"), "parser")).toBe(
			listed.parser,
		);
		// A message to a subagent (SendMessage `to: reviewer`).
		const sent = conv.locator('[data-tool="SendMessage"]').first();
		expect(await colorOf(sent.locator(".ds-agent-mark"), "reviewer")).toBe(
			listed.reviewer,
		);
		// The card of the call that started a subagent.
		const card = conv
			.locator('.ds-task[data-tool="Agent"]')
			.filter({ hasText: "Find other refresh callers" })
			.first();
		expect(
			await colorOf(
				card.locator(".ds-tool-head .ds-agent-mark"),
				"Find other refresh callers",
			),
		).toBe(listed.task);
		// …and its link to the subagent's page, inside the card.
		await card.locator(".ds-tool-head").click();
		const link = card.locator("[data-subagent-link]");
		expect(
			await colorOf(link.locator(".ds-agent-mark"), "the card's link"),
		).toBe(listed.task);

		// The subagent's own page.
		await link.click();
		const title = phone
			? page.locator(".p-sub-header .p-nav-title h1").last()
			: page.locator(".sub-title");
		await expect(title).toContainText("Find other refresh callers");
		expect(await colorOf(title.locator(".ds-agent-mark"), "page title")).toBe(
			listed.task,
		);
	});
}

/** The subagent list: the sidebar's rows (desktop), the page's section (phone). */
async function openList(page: Page, lead: string, phone: boolean) {
	if (phone) {
		const section = page.locator(`[data-subs-section="${lead}"]`).last();
		const toggle = section.locator(".p-sa-toggle");
		await expect(toggle).toContainText("30 subagents");
		if ((await toggle.getAttribute("aria-expanded")) !== "true")
			await toggle.click();
		return section;
	}
	// chat-blocks is in studio's apparish project: open it in the sidebar.
	const project = page.locator('[data-node="m:studio/p:apparish"]');
	if ((await project.getAttribute("aria-expanded")) !== "true")
		await project.locator(".chev").click();
	const toggle = page.locator(`[data-subs="${lead}"]`);
	await expect(toggle).toHaveText("30 subagents");
	if ((await toggle.getAttribute("aria-expanded")) !== "true")
		await toggle.click();
	return page.locator(".tree");
}

/** The phone's section sits over the conversation: fold it again. */
async function closeList(page: Page, lead: string) {
	const toggle = page
		.locator(`[data-subs-section="${lead}"]`)
		.last()
		.locator(".p-sa-toggle");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
}
