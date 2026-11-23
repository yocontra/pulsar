import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * Subagents on the phone (web/mock/subagents.ts): the agent page lists them
 * in a section, collapsed to a count; tapping one pushes its page (its
 * transcript and a composer that says where a message goes); back pops it.
 * Finished ones are listed only with "Show finished subagents" (Settings).
 */

test.describe("subagents (phone)", () => {
	test("finished subagents are hidden until Settings shows them", async ({
		page,
		request,
	}) => {
		const auth = await agentId(request, "name=apparish-auth");
		await ready(page);
		await page.goto(`/#/a/${encodeURIComponent(auth)}`);
		const section = page.locator(`[data-subs-section="${auth}"]`);
		const toggle = section.locator(".p-sa-toggle");
		await expect(toggle).toContainText("2 subagents · 1 running");
		await toggle.click();
		const rows = section.locator("[data-subagent]");
		await expect(rows).toHaveCount(2);
		await expect(
			rows.filter({ hasText: "Write the regression test" }),
		).toHaveCount(0);

		await page.goto("/#/settings");
		// A Konsta switch row: a tap on the row flips its checkbox.
		const sw = page.locator('[data-setting="show-finished-subagents"]');
		const box = sw.getByRole("checkbox", { name: "Show Finished Subagents" });
		await expect(sw).toBeVisible();
		await expect(box).not.toBeChecked();
		await sw.click();
		await expect(box).toBeChecked();

		await page.goto(`/#/a/${encodeURIComponent(auth)}`);
		const section2 = page.locator(`[data-subs-section="${auth}"]`).last();
		const toggle2 = section2.locator(".p-sa-toggle");
		await expect(toggle2).toContainText("4 subagents · 1 running");
		if ((await toggle2.getAttribute("aria-expanded")) !== "true")
			await toggle2.click();
		const done = section2
			.locator("[data-subagent]")
			.filter({ hasText: "Write the regression test" });
		await expect(done).toContainText(/Finished \d+[smhd] ago/);
		await expect(done).toHaveCSS("opacity", "0.6");
	});

	test("an agent whose subagents all stopped shows none by default", async ({
		page,
		request,
	}) => {
		const lead = await agentId(request, "name=chat-blocks");
		await ready(page);
		await page.goto(`/#/a/${encodeURIComponent(lead)}`);
		await expect(page.locator(".p-nav-title h1")).toHaveText("chat-blocks");
		await expect(page.locator(`[data-subs-section="${lead}"]`)).toHaveCount(0);

		await page.goto("/#/settings");
		const sw = page.locator('[data-setting="show-finished-subagents"]');
		await sw.click();
		await expect(
			sw.getByRole("checkbox", { name: "Show Finished Subagents" }),
		).toBeChecked();
		await page.goto(`/#/a/${encodeURIComponent(lead)}`);
		await expect(
			page
				.locator(`[data-subs-section="${lead}"]`)
				.last()
				.locator(".p-sa-toggle"),
		).toContainText("30 subagents");
	});

	test("a hidden finished subagent opens from the parent's card", async ({
		page,
		request,
	}) => {
		const auth = await agentId(request, "name=apparish-auth");
		await ready(page);
		await page.goto(`/#/a/${encodeURIComponent(auth)}`);
		await expect(page.locator(".p-nav-title h1")).toHaveText("apparish-auth");
		const cards = page.locator(".ds-task");
		await expect(cards.last()).toBeVisible();
		const sub = `${auth}/sub:a2fix`;
		const link = page.locator(`[data-subagent-link="${sub}"]`);
		// Earlier tests add newer task cards: open cards from the newest back
		// until this subagent's link shows.
		for (let i = (await cards.count()) - 1; i >= 0; i--) {
			if (await link.count()) break;
			await cards.nth(i).locator(".ds-tool-head").click();
		}
		await expect(link).toContainText("Write the regression test");
		await link.click();
		await expect(page).toHaveURL(new RegExp(`#/s/${encodeURIComponent(sub)}$`));
		await expect(page.locator(".p-nav-title h1").last()).toHaveText(
			"Write the regression test",
		);
	});

	test("the agent page's Subagents section pushes a subagent's page", async ({
		page,
		request,
	}) => {
		const auth = await agentId(request, "name=apparish-auth");
		await page.addInitScript(() =>
			localStorage.setItem("pulsar.showFinishedSubagents", "1"),
		);
		await ready(page);
		await page.goto(`/#/a/${encodeURIComponent(auth)}`);
		await expect(page.locator(".p-nav-title h1")).toHaveText("apparish-auth");
		const section = page.locator(`[data-subs-section="${auth}"]`);
		await expect(section).toBeVisible();
		const toggle = section.locator(".p-sa-toggle");
		await expect(toggle).toContainText("4 subagents · 1 running");
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await expect(section.locator("[data-subagent]")).toHaveCount(0);

		await toggle.click();
		const rows = section.locator("[data-subagent]");
		await expect(rows).toHaveCount(4);
		await expect(rows.first()).toContainText("Find other refresh callers");

		await rows.filter({ hasText: "reviewer" }).click();
		const sub = `${auth}/sub:a4mate`;
		await expect(page).toHaveURL(new RegExp(`#/s/${encodeURIComponent(sub)}$`));
		await expect(page.locator(".p-nav-title h1").last()).toHaveText("reviewer");
		await expect(page.locator(".p-nav-sub").last()).toContainText("Idle");
		const view = page.locator(`[data-subagent-page="${sub}"]`);
		await expect(view).toContainText("Waiting for the next task.");
		await expect(view.locator(".sub-note")).toContainText(
			"This goes to the parent agent, apparish-auth",
		);

		// Back pops to the parent's page.
		await page.getByRole("button", { name: "Back" }).last().click();
		await expect(page).toHaveURL(
			new RegExp(`#/a/${encodeURIComponent(auth)}$`),
		);
		await expect(page.locator(".p-nav-title h1").last()).toHaveText(
			"apparish-auth",
		);
	});
});

test.describe("no subagents (phone)", () => {
	test("an agent with none has no Subagents bar, section or wording", async ({
		page,
		request,
	}) => {
		const codex = await agentId(request, "name=codex@apparish");
		await ready(page);
		await page.goto(`/#/a/${encodeURIComponent(codex)}`);
		const header = page.locator(".p-agent-header").last();
		await expect(header.locator(".p-nav-title")).toContainText(
			"codex@apparish",
		);
		await expect(page.locator("[data-subs-section]")).toHaveCount(0);
		await expect(page.locator(".p-subs-bar")).toHaveCount(0);
		await expect(header).not.toContainText(/subagent/i);
	});
});
