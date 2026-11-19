import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, proveInSheet, test, withPasskey } from "../fixtures.ts";

/**
 * Presence checks (docs/presence.md) through the real daemon and the built
 * app: an agent runs a pool change over its socket, the daemon opens a
 * confirm card in Needs You, and the operator answers it with a passkey
 * (virtual authenticator). The test daemon has no OS prompt
 * (PULSAR_NATIVE_PRESENCE=off), so the app is the only way to confirm.
 */

const PORT = Number(process.env.PULSAR_REAL_PORT ?? 47392);
const CONTROL = `http://127.0.0.1:${Number(process.env.PULSAR_REAL_CONTROL_PORT ?? PORT + 1)}`;
const LOCAL = `http://localhost:${PORT}`;

type Presence = {
	agent: string;
	state?: "pending" | "done" | "error";
	result?: { change?: string; method?: string; code?: string };
};

async function presence(
	request: APIRequestContext,
	start?: string,
	as = "agent",
) {
	const r = start
		? await request.post(
				`${CONTROL}/presence?as=${as}&login=${encodeURIComponent(start)}`,
			)
		: await request.get(`${CONTROL}/presence`);
	return (await r.json()) as Presence;
}

/** The agent's inline prompt card (in its conversation). */
async function inlineCard(page: Page, agent: string): Promise<Locator> {
	await page.goto(`${LOCAL}/#/approval/${encodeURIComponent(agent)}`);
	const card = page.locator(".prompt-inline .interaction-card");
	await expect(card).toBeVisible({ timeout: 15_000 });
	return card;
}

/**
 * Answers Yes or No. The labels may end in "· Face ID" only when a ceremony
 * will run, so match the role and the start of the name. An unproven browser
 * opens Prove Human first (one Face ID per session), then the answer goes on.
 */
async function answer(page: Page, card: Locator, yes: boolean) {
	await card.getByRole("button", { name: yes ? /^Yes\b/ : /^No\b/ }).click();
	const sheet = page.getByRole("dialog", { name: "Prove Human" });
	// Either Prove Human opens (an unproven browser) or the card is answered.
	await expect(sheet.or(page.locator(".prompt-outcome"))).toBeVisible();
	if (await sheet.isVisible()) await proveInSheet(page);
}

test.describe("presence checks @real", () => {
	// A failed test hangs up its request, so its card never leaks into the next.
	test.afterEach(async ({ request }) => {
		await request.delete(`${CONTROL}/presence`);
	});

	test("an agent's pool change waits for Yes in the app; Prove Human once, then the session answers it @real", async ({
		page,
		request,
		context,
	}) => {
		await page.goto(`${LOCAL}/`);
		await withPasskey(page, request, context, { mock: false });
		const { agent } = await presence(request, "first@example.com");
		const card = await inlineCard(page, agent);
		await expect(card).toContainText(
			"Confirm: make first@example.com the pool owner on this tagged node (pulsar mesh)",
		);
		await expect(card).toContainText(
			/Asked by agent asker\S* \(pi\) on studio/,
		);
		expect((await presence(request)).state).toBe("pending");
		await answer(page, card, true);
		await expect.poll(async () => (await presence(request)).state).toBe("done");
		// Bound to this card's action and text, answered with the proven session.
		expect((await presence(request)).result).toMatchObject({
			method: "passkey session",
		});
	});

	test("No in the app refuses the change @real", async ({
		page,
		request,
		context,
	}) => {
		await page.goto(`${LOCAL}/`);
		await withPasskey(page, request, context, { mock: false });
		const { agent } = await presence(request, "second@example.com");
		const card = await inlineCard(page, agent);
		await expect(card).toContainText("second@example.com");
		await answer(page, card, false);
		await expect
			.poll(async () => (await presence(request)).state)
			.toBe("error");
		expect((await presence(request)).result).toMatchObject({ code: "denied" });
	});

	test("a terminal's pool change shows on the operator in Needs You and opens from there @real", async ({
		page,
		request,
		context,
	}) => {
		await page.goto(`${LOCAL}/`);
		await withPasskey(page, request, context, { mock: false });
		await presence(request, "third@example.com", "terminal");
		const needs = page.getByRole("button", {
			name: /operator on studio: Confirm: make third@example\.com the pool owner/,
		});
		await expect(needs).toBeVisible();
		await needs.click();
		const card = page.locator(".prompt-inline .interaction-card");
		await expect(card).toContainText("Asked by a terminal on studio");
		await answer(page, card, true);
		await expect.poll(async () => (await presence(request)).state).toBe("done");
	});
});
