import type { Page } from "@playwright/test";
import { expectCleanCopy } from "./copy.ts";
import { expectIonicStyledUnderCsp } from "./csp-phone.ts";
import {
	addAuthenticator,
	agentId,
	expect,
	localhostBase,
	ready,
	resetPasskeys,
	SHOTS,
	test,
} from "./fixtures.ts";

/** The phone shell (Ionic, iOS mode) on a Pixel-sized Chromium. */
const node = (page: Page, id: string) =>
	page.locator(`[data-tree-node="${id}"]`);

async function openSession(page: Page) {
	await ready(page);
	await node(page, "m:studio/p:apparish").locator("ion-item").click();
	await page
		.locator("[data-tree-node] ion-item[data-agent]", {
			hasText: "codex@apparish",
		})
		.first()
		.click();
	await expect(page.locator(".p-nav-title h1")).toHaveText(
		/^codex@apparish(-\d+)?$/,
	);
}

test.describe("mobile", () => {
	test("home keeps loading machine pages as it scrolls", async ({ page }) => {
		// Smaller pages than the app asks for: 200 machines take 5 pages.
		const pages: string[] = [];
		await page.route(/\/api\/v1\/tree\?/, (r) => {
			const u = new URL(r.request().url());
			if (u.searchParams.get("group") && !u.searchParams.get("parent")) {
				u.searchParams.set("limit", "40");
				if (u.searchParams.get("cursor")) pages.push(u.search);
			}
			return r.continue({ url: u.toString() });
		});
		await ready(page);
		const content = page.locator("ion-content").first();
		for (let i = 0; i < 8 && pages.length < 4; i++) {
			await content.evaluate((el) =>
				(
					el as HTMLElement & { scrollToBottom: (ms: number) => Promise<void> }
				).scrollToBottom(0),
			);
			await page.waitForTimeout(400);
		}
		expect(pages.length).toBeGreaterThanOrEqual(4);
	});

	test("home is search-first; a group row expands in place", async ({
		page,
	}) => {
		await ready(page);
		await expect(page.getByLabel("Search agents and messages")).toBeVisible();
		// The top app bar's title (Material: no large title).
		// No title on a tab's root: the tab bar says where you are.
		const top = page.locator("ion-nav > .ion-page:last-child");
		await expect(top.locator("ion-title")).toHaveCount(0);
		await expect(
			top.getByRole("heading", { level: 1, name: "Agents" }),
		).toBeAttached();
		// Machines and projects show no rollup counts: only a needs-you badge.
		const studio = node(page, "m:studio");
		await expect(studio).toHaveAttribute("data-expanded", "true");
		await expect(studio).not.toContainText("43");

		const apparish = node(page, "m:studio/p:apparish");
		await apparish.locator("ion-item").click();
		await expect(apparish).toHaveAttribute("data-expanded", "true");
		await expect(page.locator("ion-modal")).toHaveCount(0);
		await expect(
			page.locator("[data-tree-node] ion-item[data-agent]", {
				hasText: "apparish-auth",
			}),
		).toBeVisible();
		await page.screenshot({ path: `${SHOTS}mobile-home.png` });

		await studio.locator("ion-item").click();
		await expect(studio).toHaveAttribute("data-expanded", "false");
	});

	test("an old #/ask link lands on Home; Home has no Ask button", async ({
		page,
	}) => {
		await page.goto("/#/ask");
		await expect(page.locator("ion-content.p-home")).toBeVisible();
		await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
		await expect(page.getByRole("button", { name: "Ask" })).toHaveCount(0);
		await expect(page.locator(".p-ask, .p-ask-empty")).toHaveCount(0);
	});

	test("Ionic is styled under the strict CSP (Chromium)", async ({ page }) => {
		await ready(page);
		await expect(page.locator("ion-item-sliding").first()).toBeAttached();
		await expectIonicStyledUnderCsp(page);
	});

	test("copy is clean on every phone screen", async ({ page }) => {
		await ready(page);
		await expectCleanCopy(page, "Home", "ion-app");
		await page.getByTestId("needs-summary").click();
		await expect(page.locator(".p-needs .p-attn").first()).toBeVisible();
		await expectCleanCopy(page, "Needs You", ".p-needs");
		await page.goto("/#/settings");
		await expect(page.locator(".p-settings")).toBeVisible();
		await page.waitForTimeout(500);
		await expectCleanCopy(page, "Settings", ".p-settings");
		await openSession(page);
		await expectCleanCopy(page, "Agent header", ".p-agent-header");
	});

	test("long-press a machine to message everyone on it; back closes the sheet", async ({
		page,
	}) => {
		await ready(page);
		await node(page, "m:studio")
			.locator("ion-item")
			.dispatchEvent("contextmenu");
		await page
			.getByRole("button", { name: "Message Everyone on studio" })
			.click();
		// The dialog role and name sit in the modal's shadow root; its content
		// is slotted into the ion-modal host.
		await expect(
			page.getByRole("dialog", { name: "Message group" }),
		).toBeVisible();
		const sheet = page.locator("ion-modal");
		await expect(sheet.locator("h1")).toHaveText("Everyone on studio");
		await expect(sheet.locator(".selector-line")).toHaveText("machine=studio");
		// Rows say only what differs: no machine (all on studio), and no wake
		// word where it is the usual one (the summary line counts them).
		const rows = sheet.locator(".preview-list li");
		await expect(rows.first()).toBeVisible();
		await expect(sheet.locator(".preview-list .d-prev-machine")).toHaveCount(0);
		await expect(sheet.locator(".preview-list .wake.w-wakes")).toHaveCount(0);
		await expect(sheet.locator(".wake-summary")).toContainText("Wakes");
		await page.goBack();
		await expect(page.locator("ion-modal")).toHaveCount(0);
		await expect(node(page, "m:studio")).toBeVisible();
	});

	test("session streams and the nav stack follows history", async ({
		page,
	}) => {
		await openSession(page);
		const before = await page.locator(".transcript").textContent();
		await expect
			.poll(
				async () =>
					(await page.locator(".transcript").textContent()) !== before,
				{ timeout: 10_000 },
			)
			.toBe(true);
		await page.screenshot({ path: `${SHOTS}mobile-session.png` });

		// The back button and the browser/Android back both pop the stack.
		await page.getByRole("button", { name: "Back" }).last().click();
		await expect(page).not.toHaveURL(/#\/a\//);
		await expect(page.locator(".p-nav-title h1")).toHaveCount(0);
		await page.goForward();
		await expect(page.locator(".p-nav-title h1")).toHaveText(
			/^codex@apparish(-\d+)?$/,
		);
		await page.goBack();
		await expect(page.locator(".p-nav-title h1")).toHaveCount(0);
		await expect(node(page, "m:studio")).toBeVisible();
	});

	test("the agent menu opens its PR, branch and repo outside the app", async ({
		page,
	}) => {
		await openSession(page);
		await page.evaluate(() => {
			const w = window as unknown as { __opened: unknown[] };
			w.__opened = [];
			window.open = (...args: unknown[]) => {
				w.__opened.push(args);
				return null;
			};
		});
		await page.getByRole("button", { name: "More" }).last().click();
		const repo = "https://github.com/acme/apparish";
		await expect(
			page.getByRole("menuitem", { name: "Open Branch" }),
		).toBeVisible();
		await expect(
			page.getByRole("menuitem", { name: "Open Repository" }),
		).toBeVisible();
		await page
			.getByRole("menuitem", { name: "Open Pull Request #1402" })
			.click();
		expect(
			await page.evaluate(
				() => (window as unknown as { __opened: unknown[] }).__opened,
			),
		).toEqual([[`${repo}/pull/1402`, "_blank", "noopener,noreferrer"]]);
	});

	test("an approval opens in its agent's conversation, inline, not as a sheet", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await ready(page);
		await page.getByTestId("needs-summary").click();
		await page
			.locator(".p-needs .p-attn", { hasText: "apparish-auth" })
			.first()
			.click();
		await expect(page).toHaveURL(
			new RegExp(
				`#/a/${encodeURIComponent(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
			),
		);
		await expect(page.locator(".p-nav-title h1")).toHaveText("apparish-auth");
		const card = page.locator(".prompt-inline .approval-card");
		await expect(card).toBeInViewport();
		await expect(
			card.locator(".mk-ctl", { hasText: "<U+202E>" }),
		).toBeVisible();
		await expect(card).toContainText("can't approve");
		// No sheet, no dialog: the prompt lives in the conversation.
		await expect(page.locator("ion-modal")).toHaveCount(0);
		await page.screenshot({ path: `${SHOTS}mobile-approval.png` });
	});

	test("an unproven approve opens Prove Human: the phone registers with no code, then the answer goes on", async ({
		page,
		context,
		request,
	}) => {
		await resetPasskeys(request);
		await addAuthenticator(page, context);
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`${localhostBase()}/#/approval/${encodeURIComponent(id)}`);
		const card = page.locator(".prompt-inline .approval-card");
		await expect(card).toContainText("apparish-auth");
		await card
			.getByRole("button", { name: /^Allow once( · Face ID)?$/ })
			.click();
		const prove = page.getByRole("dialog", { name: "Prove Human" });
		await expect(prove).toContainText("To answer this prompt");
		// A phone runs no agents: no terminal code.
		await expect(prove).not.toContainText("pulsar passkeys add");
		await expectCleanCopy(page, "Prove Human (approve)", ".prove-sheet");
		await prove.getByRole("button", { name: /^Prove with/ }).click();
		await expect(prove).toHaveCount(0);
		await expect(page.locator(".prompt-outcome")).toContainText(
			/Allowed once by You · passkey session on .+ · \d/,
		);
	});

	test("Prove Human from the home row shows who is proven, and until when", async ({
		page,
		context,
		request,
	}) => {
		await resetPasskeys(request);
		await addAuthenticator(page, context);
		// Prove Human leads the phone's Settings.
		await page.goto(`${localhostBase()}/#/settings`);
		await page
			.getByRole("button", { name: /^Prove Human: Not proven/ })
			.click();
		const prove = page.getByRole("dialog", { name: "Prove Human" });
		await expect(prove).toContainText(
			"Agents can't pass your device's passkey check",
		);
		await prove.getByRole("button", { name: /^Prove with/ }).click();
		await expect(prove).toContainText("Proven as You");
		await expect(prove).toContainText(/This device on .+ · until/);
		await expectCleanCopy(page, "Prove Human (proven)", ".prove-sheet");
		// Modal: Tab and Shift+Tab stay in the sheet.
		for (const key of ["Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
			await page.keyboard.press(key);
			expect(
				await page.evaluate(
					() => !!document.activeElement?.closest(".prove-sheet"),
				),
				`focus after ${key}`,
			).toBe(true);
		}
		await prove.getByRole("button", { name: "Close" }).click();
		await expect(prove).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: /^Prove Human: Proven as You/ }),
		).toBeVisible();
	});

	test("broadcast with a full-screen facet picker", async ({ page }) => {
		await ready(page);
		await page.getByRole("button", { name: "Broadcast…" }).click();
		await expect(page.getByTestId("match-count")).toHaveText(/^3,\d{3} agents/);
		await page.getByRole("button", { name: "Narrow it down" }).click();
		await page.locator('.bc-facet[aria-label="machine facet"] .link').click();
		const picker = page.getByRole("dialog", { name: "Choose machine" });
		await expect(picker).toBeVisible();
		await picker.getByLabel("Search machine").fill("studio");
		await picker.locator(".picker-row", { hasText: "studio" }).first().click();
		await page.goBack();
		await expect(picker).toHaveCount(0);
		await expect(page.getByTestId("match-count")).toHaveText(
			"43 agents on 1 machine",
		);
		await expect(page.locator(".bc-sentence")).toContainText("on studio");
		await page.screenshot({ path: `${SHOTS}mobile-builder.png` });
	});
});
