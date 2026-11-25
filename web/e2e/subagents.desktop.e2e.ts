import type { Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * Subagents in the desktop app (web/mock/subagents.ts): apparish-auth runs
 * four (one running, one finished with a nested one, an idle teammate).
 * The sidebar shows them collapsed under the agent; opening one shows its
 * transcript with a breadcrumb back, and the composer says where a message
 * goes (Claude Code subagents can't take messages: the parent, naming it).
 * Finished ones are listed only with "Show idle and finished subagents" (Settings).
 */

/** Starts with "Show idle and finished subagents" on (this device's setting). */
const showFinished = (page: Page) =>
	page.addInitScript(() =>
		localStorage.setItem("pulsar.showFinishedSubagents", "1"),
	);

async function openApparish(page: Page) {
	await ready(page);
	const apparish = page.locator('[data-node="m:studio/p:apparish"]');
	if ((await apparish.getAttribute("aria-expanded")) !== "true")
		await apparish.locator(".chev").click();
}

test.describe("subagents (desktop)", () => {
	test("finished subagents are hidden until the setting shows them", async ({
		page,
		request,
	}) => {
		const auth = await agentId(request, "name=apparish-auth");
		await openApparish(page);
		const toggle = page.locator(`[data-subs="${auth}"]`);
		// Only the running task appears while the setting is off.
		await expect(toggle).toHaveText("1 running subagent");
		await toggle.click();
		const rows = page.locator(".tree [data-subagent]");
		await expect(rows).toHaveCount(1);
		await expect(rows.locator(".d-name")).toHaveText([
			"Find other refresh callers",
		]);

		// Settings: turn "Show idle and finished subagents" on.
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = page.getByRole("dialog", { name: "Settings" });
		const sw = settings.getByRole("switch", {
			name: "Show idle and finished subagents",
		});
		await expect(sw).not.toBeChecked();
		await sw.click();
		await expect(sw).toBeChecked();
		await page.keyboard.press("Escape");
		await expect(settings).toBeHidden();

		await expect(toggle).toHaveText("4 subagents · 1 running");
		await expect(rows).toHaveCount(4);
		const done = rows.filter({ hasText: "Write the regression test" });
		await expect(done).toContainText(/Finished \d+[smhd] ago/);
		await expect(done).toHaveCSS("opacity", "0.6");
		// Saved on this device.
		await page.reload();
		await expect(page.locator(`[data-subs="${auth}"]`)).toHaveText(
			"4 subagents · 1 running",
		);

		// And off again.
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page
			.getByRole("dialog", { name: "Settings" })
			.getByRole("switch", { name: "Show idle and finished subagents" })
			.click();
		await page.keyboard.press("Escape");
		await expect(page.locator(`[data-subs="${auth}"]`)).toHaveText(
			"1 running subagent",
		);
	});

	test("an agent whose subagents all stopped shows none by default", async ({
		page,
		request,
	}) => {
		// chat-blocks: 30 teammates, all stopped (done). Dead ones count for nothing.
		const lead = await agentId(request, "name=chat-blocks");
		const auth = await agentId(request, "name=apparish-auth");
		await openApparish(page);
		// The live ones of another agent still show, so the tree has rendered.
		await expect(page.locator(`[data-subs="${auth}"]`)).toHaveText(
			"1 running subagent",
		);
		await expect(page.locator(`[data-subs="${lead}"]`)).toHaveCount(0);
		await expect(
			page.locator(".tree [data-subagent]", { hasText: "stopped-mate" }),
		).toHaveCount(0);

		// "Show idle and finished subagents" lists them, dimmed.
		await showFinished(page);
		await page.reload();
		await openApparish(page);
		const toggle = page.locator(`[data-subs="${lead}"]`);
		await expect(toggle).toHaveText("30 subagents");
		await toggle.click();
		const rows = page.locator(".tree [data-subagent]", {
			hasText: "stopped-mate",
		});
		// The tree is virtualized: check the first rows, not all 30.
		await expect(rows.first()).toBeVisible();
		await expect(rows.first()).toContainText(/Finished \d+[smhd] ago/);
	});

	test("expand an agent's subagents, open one, message it, go back", async ({
		page,
		request,
	}) => {
		const auth = await agentId(request, "name=apparish-auth");
		await showFinished(page);
		await ready(page);
		const apparish = page.locator('[data-node="m:studio/p:apparish"]');
		if ((await apparish.getAttribute("aria-expanded")) !== "true")
			await apparish.locator(".chev").click();
		const toggle = page.locator(`[data-subs="${auth}"]`);
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveText("4 subagents · 1 running");
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		// Collapsed by default: no subagent rows.
		await expect(page.locator(".tree [data-subagent]")).toHaveCount(0);

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		const rows = page.locator(".tree [data-subagent]");
		await expect(rows).toHaveCount(4);
		// Running first; a nested one sits under the one that started it.
		await expect(rows.first()).toContainText("Find other refresh callers");
		await expect(rows.first()).toContainText("Running");
		const names = await rows.locator(".d-name").allTextContents();
		expect(names.indexOf("Check the test runner flags")).toBe(
			names.indexOf("Write the regression test") + 1,
		);
		const pad = (name: string) =>
			rows
				.filter({ hasText: name })
				.evaluate((el) =>
					Number.parseFloat((el as HTMLElement).style.paddingLeft),
				);
		expect(await pad("Check the test runner flags")).toBeGreaterThan(
			await pad("Write the regression test"),
		);
		// Subagents are not agents: not in the agent list.
		const list = await request.get("/api/v1/agents?selector=*&limit=500", {
			headers: { "X-Pulsar": "1" },
		});
		const body = (await list.json()) as { items: { id: string }[] };
		expect(body.items.some((a) => a.id.includes("/sub:"))).toBe(false);

		// Open one: its transcript in the main pane, a breadcrumb to the parent.
		await rows.filter({ hasText: "Write the regression test" }).click();
		const sub = `${auth}/sub:a2fix`;
		await expect(page).toHaveURL(new RegExp(`#/s/${encodeURIComponent(sub)}$`));
		const pageEl = page.locator(`[data-subagent-page="${sub}"]`);
		await expect(pageEl.locator(".sub-title h1")).toHaveText(
			"Write the regression test",
		);
		await expect(pageEl.locator(".sub-crumbs")).toContainText("apparish-auth");
		await expect(pageEl).toContainText(
			"two concurrent refreshes now share one",
		);
		await expect(
			rows.filter({ hasText: "Write the regression test" }),
		).toHaveAttribute("aria-current", "page");

		// The composer says where a message goes, and sends it there.
		const note = pageEl.locator(".sub-note");
		await expect(note).toHaveAttribute("data-messaging", "parent");
		await expect(note).toContainText(
			"Claude Code subagents can't receive messages",
		);
		const sent = page.waitForRequest(
			(r) => r.url().endsWith("/api/v1/send") && r.method() === "POST",
		);
		await pageEl.locator(".composer-input").fill("Is the test green?");
		await page.keyboard.press("ControlOrMeta+Enter");
		const req = await sent;
		const payload = req.postDataJSON() as {
			ids: string[];
			viaParent?: boolean;
		};
		expect(payload.ids).toEqual([sub]);
		expect(payload.viaParent).toBe(true);
		const res = await req.response();
		expect(res?.status()).toBe(200);
		await expect(pageEl.locator(".receipt-line")).toBeVisible({
			timeout: 8000,
		});

		// Back to the parent through the breadcrumb.
		await pageEl.locator(".sub-crumbs button").click();
		await expect(page).toHaveURL(
			new RegExp(`#/a/${encodeURIComponent(auth)}$`),
		);
		await expect(page.locator(".d-session-head h1")).toContainText(
			"apparish-auth",
		);

		// Collapse again.
		await toggle.click();
		await expect(page.locator(".tree [data-subagent]")).toHaveCount(0);
	});

	test("a hidden finished subagent opens from the parent's card", async ({
		page,
		request,
	}) => {
		const auth = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(auth)}`);
		await expect(page.locator(".d-session-head h1")).toBeVisible();
		await expect(page.locator(".tree [data-subagent]")).toHaveCount(0);
		const cards = page.locator(".ds-task");
		const sub = `${auth}/sub:a2fix`;
		const link = page.locator(`[data-subagent-link="${sub}"]`);
		// New mock turns can push the finished subagent's parent call onto
		// the previous page, even when its result is on the newest page.
		await expect(cards.first()).toBeVisible();
		const newestCount = await cards.count();
		await page.getByRole("button", { name: "Load earlier messages" }).click();
		await expect.poll(() => cards.count()).toBeGreaterThan(newestCount);
		// Open cards from the newest back until this subagent's link shows.
		for (let i = (await cards.count()) - 1; i >= 0; i--) {
			if (await link.count()) break;
			await cards.nth(i).locator(".ds-tool-head").click();
		}
		await expect(link).toContainText("Write the regression test");
		await link.click();
		const view = page.locator(`[data-subagent-page="${sub}"]`);
		await expect(view.locator(".sub-title h1")).toHaveText(
			"Write the regression test",
		);
		await expect(view).toContainText(/Finished \d+[smhd] ago/);
		// The sidebar still lists no finished one.
		await expect(page.locator(`.tree [data-subagent="${sub}"]`)).toHaveCount(0);
	});

	test("the parent's subagent card links to the subagent's page", async ({
		page,
		request,
	}) => {
		const auth = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(auth)}`);
		await expect(page.locator(".d-session-head h1")).toBeVisible();
		// Earlier tests in the run add turns to this transcript (a newer task
		// card may be last): open cards from the last until one links out.
		const cards = page.locator(".ds-task");
		await expect(cards.first()).toBeVisible();
		// The running explorer's card: other cards link to other subagents.
		const link = page.locator('[data-subagent-link$="/sub:a1explore"]');
		for (let i = (await cards.count()) - 1; i >= 0; i--) {
			if (await link.count()) break;
			await cards.nth(i).locator(".ds-tool-head").click();
		}
		await expect(link).toBeVisible();
		await expect(link).toContainText("Find other refresh callers");
		await link.click();
		await expect(
			page.locator(
				`[data-subagent-page="${auth}/sub:a1explore"] .sub-title h1`,
			),
		).toHaveText("Find other refresh callers");
	});

	test("a subagent that takes messages directly says so", async ({
		page,
		request,
	}) => {
		const res = await request.get(
			"/api/v1/agents?selector=harness=opencode%20machine=studio&limit=50",
			{
				headers: { "X-Pulsar": "1" },
			},
		);
		const { items } = (await res.json()) as {
			items: { id: string; subagents?: { total: number } }[];
		};
		const parent = items.find((a) => a.subagents);
		test.skip(!parent, "the mock pool has no OpenCode agent on studio");
		const sub = `${parent!.id}/sub:ses_mockkid`;
		await page.goto(`/#/s/${encodeURIComponent(sub)}`);
		const pageEl = page.locator(`[data-subagent-page="${sub}"]`);
		await expect(pageEl.locator(".sub-note")).toHaveAttribute(
			"data-messaging",
			"direct",
		);
		await expect(pageEl).toContainText("No transcript for this subagent.");
		const sent = page.waitForRequest((r) => r.url().endsWith("/api/v1/send"));
		await pageEl.locator(".composer-input").fill("look at src/");
		await page.keyboard.press("ControlOrMeta+Enter");
		const req = await sent;
		const payload = req.postDataJSON() as {
			ids: string[];
			viaParent?: boolean;
		};
		expect(payload).toMatchObject({ ids: [sub] });
		expect(payload.viaParent).toBeUndefined();
		expect((await req.response())?.status()).toBe(200);
	});
});

test.describe("no subagents (desktop)", () => {
	test("an agent with none shows no subagent disclosure or wording anywhere", async ({
		page,
		request,
	}) => {
		await showFinished(page);
		const codex = await agentId(request, "name=codex@apparish");
		await openApparish(page);
		// The sidebar shows disclosures (apparish-auth has subagents)…
		const auth = await agentId(request, "name=apparish-auth");
		await expect(page.locator(`[data-subs="${auth}"]`)).toBeVisible();
		// …and none for an agent without any.
		await expect(page.locator(`[data-subs="${codex}"]`)).toHaveCount(0);
		await page.goto(`/#/a/${encodeURIComponent(codex)}`);
		await expect(page.locator(".session-header h1")).toHaveText(
			"codex@apparish",
		);
		await expect(page.locator(".session-header")).not.toContainText(
			/subagent/i,
		);
		await expect(page.locator(`[data-subs="${codex}"]`)).toHaveCount(0);
	});
});
