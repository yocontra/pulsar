import type { Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * The extension points (src/lib/registry.tsx) are wired into both layouts:
 * a test registers through the e2e hook (main.tsx) and finds each slot,
 * settings section, command, provider and page where it belongs. Shared by
 * slots.desktop.e2e.ts and slots.ios.e2e.ts.
 */

type Fn = (...a: unknown[]) => unknown;
type Hook = Record<
	| "registerSlot"
	| "registerSettingsSection"
	| "registerCommand"
	| "registerPaletteProvider"
	| "registerPage",
	Fn
>;

/** The app with the e2e hook (set before the app loads). */
async function open(page: Page) {
	await page.addInitScript(() => {
		(window as { __pulsarE2E?: object }).__pulsarE2E = {};
	});
	await ready(page);
}

/** Registers what the tests look for; function components return plain text. */
async function registerAll(page: Page) {
	await page.evaluate(() => {
		const h = (window as unknown as { __pulsarE2E: Hook }).__pulsarE2E;
		const w = window as unknown as { ran?: string[] };
		w.ran = [];
		h.registerSlot("sidebar.header", {
			id: "e2e",
			component: ({ mobile }: { mobile: boolean }) =>
				`SIDEBAR-SLOT ${mobile ? "phone" : "desktop"}`,
		});
		h.registerSlot("session.header", {
			id: "e2e",
			component: ({ agent }: { agent: { name: string } }) =>
				`SESSION-SLOT ${agent.name}`,
		});
		h.registerSlot("composer.left", {
			id: "e2e",
			component: () => "LEFT-SLOT",
		});
		h.registerSlot("composer.right", {
			id: "e2e",
			component: ({ hasText }: { hasText: boolean }) =>
				`RIGHT-SLOT ${hasText ? "text" : "empty"}`,
		});
		h.registerSettingsSection({
			id: "e2e",
			title: "E2E section",
			desktop: () => "SECTION-DESKTOP",
			phone: () => "SECTION-PHONE",
		});
		h.registerCommand({
			id: "e2e",
			label: "E2E command",
			keywords: ["zebra"],
			run: () => w.ran?.push("command"),
		});
		h.registerPaletteProvider({
			id: "e2e",
			group: "E2E results",
			search: async (q: string) => [
				{ key: "1", label: `Found ${q}`, run: () => w.ran?.push("result") },
			],
		});
		h.registerPage({
			name: "e2e-page",
			desktop: ({ arg }: { arg: string }) => `PAGE-DESKTOP ${arg}`,
			phone: ({ arg }: { arg: string }) => `PAGE-PHONE ${arg}`,
		});
	});
}

export function slotsSuite(platform: "desktop" | "phone") {
	test(`slots, settings sections and pages render (${platform})`, async ({
		page,
		request,
	}) => {
		const phone = platform === "phone";
		await open(page);
		await registerAll(page);
		const header = phone
			? page.locator("ion-header").first()
			: page.locator(".d-brand");
		await expect(header).toContainText(`SIDEBAR-SLOT ${platform}`);

		const id = await agentId(request, "name=apparish-auth");
		await page.evaluate((id) => {
			location.hash = `#/a/${encodeURIComponent(id)}`;
		}, id);
		const head = phone
			? page.locator("ion-header.p-agent-header")
			: page.locator(".d-session-head");
		await expect(head).toContainText("SESSION-SLOT apparish-auth");
		const composer = page.locator(".composer").last();
		await expect(composer).toContainText("LEFT-SLOT");
		await expect(composer).toContainText("RIGHT-SLOT empty");
		await composer.locator(".composer-input").fill("hello");
		await expect(composer).toContainText("RIGHT-SLOT text");

		await page.evaluate(() => {
			location.hash = "#/e2e-page/arg-1";
		});
		await expect(
			page.getByText(`PAGE-${phone ? "PHONE" : "DESKTOP"} arg-1`),
		).toBeVisible();

		if (phone) {
			await page.evaluate(() => {
				location.hash = "#/settings";
			});
			await expect(
				page.getByRole("region", { name: "E2E section" }),
			).toContainText("SECTION-PHONE");
		} else {
			await page.getByRole("button", { name: "Settings" }).click();
			const nav = page.getByRole("navigation", { name: "Settings sections" });
			await nav.getByRole("button", { name: "E2E section" }).click();
			await expect(
				page.locator('section[aria-labelledby="set-x-e2e"]'),
			).toContainText("SECTION-DESKTOP");
		}
	});

	if (platform === "desktop")
		test("Cmd-K lists registered commands and provider results", async ({
			page,
		}) => {
			await open(page);
			await registerAll(page);
			await page.getByRole("button", { name: "Search", exact: true }).click();
			const list = page.getByRole("listbox", { name: "Results" });
			await list.getByRole("option", { name: "E2E command" }).click();
			expect(
				await page.evaluate(() => (window as { ran?: string[] }).ran),
			).toEqual(["command"]);
			await page.getByRole("button", { name: "Search", exact: true }).click();
			await page.getByRole("textbox", { name: "Search" }).fill("zebra");
			await expect(
				list.getByRole("option", { name: "E2E command" }),
			).toBeVisible();
			await expect(list.getByText("E2E results")).toBeVisible();
			await list.getByRole("option", { name: "Found zebra" }).click();
			expect(
				await page.evaluate(() => (window as { ran?: string[] }).ran),
			).toEqual(["command", "result"]);
		});
}
