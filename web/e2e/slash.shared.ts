import type { APIRequestContext, Page } from "@playwright/test";
import { openAgent } from "./composer.shared.ts";
import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * Slash commands and modes in the composer (web/src/features/slash): the
 * `/` menu, a command line running in the agent's session (an acting op),
 * "Send as text", and the mode chip. The mock (web/mock/controls.ts) keeps
 * what ran, readable at `/__mock/commands`. Shared by slash.desktop.e2e.ts
 * and slash.phone.e2e.ts.
 */

export async function ran(request: APIRequestContext) {
	const res = await request.get("/api/v1/__mock/commands", {
		headers: { "X-Pulsar": "1" },
	});
	return (await res.json()) as Array<{ agent: string; line: string }>;
}

/** The agent page without a passkey session: an acting op asks for Prove Human. */
export async function openUnproven(
	page: Page,
	request: APIRequestContext,
	selector: string,
) {
	await ready(page);
	const id = await agentId(request, selector);
	await page.evaluate((id) => {
		location.hash = `#/a/${encodeURIComponent(id)}`;
	}, id);
	const composer = page.locator(".composer").last();
	await expect(composer.locator(".composer-input")).toBeVisible();
	return composer;
}

/** Sends the draft with the Send button (Enter adds a newline on desktop). */
const send = (composer: ReturnType<Page["locator"]>) =>
	composer.getByRole("button", { name: "Send", exact: true }).click();

export function slashSuite(platform: "desktop" | "phone") {
	test(`/ opens the menu; Enter inserts; the line runs in the session (${platform})`, async ({
		page,
		request,
	}) => {
		const composer = await openAgent(page, request, "name=apparish-auth");
		const id = await agentId(request, "name=apparish-auth");
		const field = composer.locator(".composer-input");
		await field.click();
		await field.pressSequentially("/");
		const menu = page.getByRole("listbox", { name: "Commands" });
		await expect(menu).toBeVisible();
		// Built-ins, custom commands and skills, each with its source.
		await expect(menu).toContainText("/compact");
		await field.pressSequentially("gh");
		await expect(menu).toContainText("plugin skill");
		await field.press("Backspace");
		await field.press("Backspace");
		await field.pressSequentially("compa");
		await expect(menu.getByRole("option").first()).toContainText("/compact");
		await field.press("Enter");
		await expect(menu).toHaveCount(0);
		await expect(field).toHaveValue("/compact ");
		// Replacing a selected skill or command can start another lookup immediately.
		await field.fill("/rec");
		await expect(menu).toContainText("/recap");
		await field.fill("/compact ");
		await field.pressSequentially("keep the API notes");
		const note = composer.getByTestId("slash-note");
		await expect(note).toContainText(
			"Runs /compact in apparish-auth's session",
		);
		await send(composer);
		await expect(
			composer.getByRole("status").filter({ hasText: "Ran" }),
		).toContainText("Ran /compact");
		await expect(field).toHaveValue("");
		expect(await ran(request)).toContainEqual({
			agent: id,
			line: "/compact keep the API notes",
		});
	});

	test(`advertised arguments fill the command draft (${platform})`, async ({
		page,
		request,
	}) => {
		await page.route("**/api/v1/agents/*/commands", async (route) => {
			const response = await route.fetch();
			const catalog = await response.json();
			await route.fulfill({
				response,
				json: {
					...catalog,
					commands: catalog.commands.map((c: { name: string }) =>
						c.name === "compact"
							? {
									...c,
									argumentChoices: [{ value: "api", label: "API notes" }],
								}
							: c,
					),
				},
			});
		});
		const composer = await openAgent(page, request, "name=apparish-auth");
		const field = composer.locator(".composer-input");
		await field.fill("/compact ");
		await composer
			.getByRole("combobox", { name: "Argument for /compact" })
			.selectOption("api");
		await expect(field).toHaveValue("/compact api");
		await send(composer);
		await expect(field).toHaveValue("");
		expect(await ran(request)).toContainEqual({
			agent: await agentId(request, "name=apparish-auth"),
			line: "/compact api",
		});
	});

	test(`reopening the picker loads commands advertised after startup (${platform})`, async ({
		page,
		request,
	}) => {
		const composer = await openAgent(page, request, "name=apparish-auth");
		let first = true;
		await page.route("**/api/v1/agents/*/commands", async (route) => {
			if (!first) return route.continue();
			first = false;
			const response = await route.fetch();
			await route.fulfill({
				response,
				json: {
					...(await response.json()),
					commands: [],
					runnable: false,
					reason: "Starting session",
				},
			});
		});
		const field = composer.locator(".composer-input");
		await field.fill("/");
		const menu = page.getByRole("listbox", { name: "Commands" });
		await expect(composer).toContainText("Starting session");
		await field.fill("");
		await expect(menu).toHaveCount(0);
		await field.fill("/");
		await expect(menu).toContainText("/compact");
	});

	test(`fuzzy match, Escape, and a dialog-only command is not offered (${platform})`, async ({
		page,
		request,
	}) => {
		const composer = await openAgent(page, request, "name=apparish-auth");
		const field = composer.locator(".composer-input");
		await field.click();
		await field.pressSequentially("/rev");
		const menu = page.getByRole("listbox", { name: "Commands" });
		await expect(menu).toContainText("/gh:review");
		await field.press("Escape");
		await expect(menu).toHaveCount(0);
		await field.fill("");
		await field.pressSequentially("/config");
		const config = menu
			.getByRole("option")
			.filter({ hasText: "/config" })
			.first();
		await expect(config).toHaveAttribute("aria-disabled", "true");
		await expect(config).toContainText("only the terminal can answer");
	});

	test(`Send as text sends a / message as a message (${platform})`, async ({
		page,
		request,
	}) => {
		const composer = await openAgent(page, request, "name=apparish-auth");
		const before = (await ran(request)).length;
		const field = composer.locator(".composer-input");
		await field.click();
		await field.fill("/compact is the command I mean");
		const note = composer.getByTestId("slash-note");
		await note.getByRole("button", { name: "Send as text" }).click();
		await expect(note).toContainText("Sends as a message.");
		await send(composer);
		await expect(
			page.getByText("/compact is the command I mean").first(),
		).toBeVisible();
		expect((await ran(request)).length).toBe(before);
	});

	test(`without a passkey session a command asks for Prove Human; cancel runs nothing (${platform})`, async ({
		page,
		request,
	}) => {
		const composer = await openUnproven(page, request, "name=apparish-auth");
		const before = (await ran(request)).length;
		const field = composer.locator(".composer-input");
		await field.click();
		await field.fill("/recap");
		await send(composer);
		const prove = page.getByRole("dialog", { name: "Prove Human" });
		await expect(prove).toBeVisible();
		await expect(prove).toContainText("run a command in its terminal");
		await page.keyboard.press("Escape");
		await expect(prove).toHaveCount(0);
		// The line is back in the box; nothing ran.
		await expect(field).toHaveValue("/recap");
		expect((await ran(request)).length).toBe(before);
	});
}
