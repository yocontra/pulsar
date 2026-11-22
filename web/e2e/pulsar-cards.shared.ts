import type { Locator } from "@playwright/test";
import { agentId, expect, test } from "./fixtures.ts";

/** Open a card: a tap while the list still renders can miss, so tap until it opens. */
async function openCard(card: Locator) {
	await expect(async () => {
		if (!(await card.locator(".ds-pulsar").count()))
			await card.locator(".ds-tool-head").click();
		await expect(card.locator(".ds-pulsar")).toBeVisible({ timeout: 1000 });
	}).toPass({ timeout: 15_000 });
}

/**
 * Pulsar's own MCP calls in the chat-blocks gallery (web/mock/pulsar-blocks.ts)
 * render with their bespoke card: a plain-words head with agent chips, a
 * body with the message and reply, raw JSON only under "Show details".
 */
export function pulsarCardsSuite(platform: "desktop" | "phone") {
	for (const scheme of ["light", "dark"] as const)
		test(`Pulsar tool calls get the Pulsar card (${platform}, ${scheme})`, async ({
			page,
			request,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			const id = await agentId(request, "fixture=blocks");
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			const conv = page.locator(".ds-conv").first();
			const cards = conv.locator(".ds-tool.is-pulsar");
			await expect(cards.first()).toBeAttached();
			expect(await cards.count()).toBeGreaterThanOrEqual(15);
			// Every harness's name for a Pulsar tool.
			for (const name of [
				"mcp__pulsar__send",
				"mcp__pulsar_send",
				"mcp_pulsar_send",
			])
				await expect(
					conv.locator(`.is-pulsar[data-tool="${name}"]`).first(),
				).toBeAttached();
			// Never the generic MCP line.
			await expect(cards.filter({ hasText: /Called pulsar/ })).toHaveCount(0);

			// send with await_reply: recipient, priority, the reply inline.
			const send = cards.filter({ hasText: "reply from reviewer" }).first();
			await send.scrollIntoViewIfNeeded();
			const head = send.locator(".ds-tool-head");
			await expect(head).toContainText("Sent to");
			await expect(head.locator(".ds-pulsar-chip")).toHaveText("reviewer");
			await expect(head.locator(".ds-pulsar-label")).toHaveText(
				"Interrupt now",
			);
			// The head stays one line inside the card.
			const fits = await head.evaluate(
				(el) => el.scrollWidth <= el.clientWidth + 1,
			);
			expect(fits).toBe(true);
			await openCard(send);
			const body = send.locator(".ds-pulsar");
			await expect(body.locator(".ds-pulsar-msg")).toContainText(
				"Three tries is fine.",
			);
			// The body as Markdown: bold rendered, no raw asterisks.
			const sent = body.locator(".ds-pulsar-sent");
			await expect(sent).toContainText("Is a 3-try limit enough");
			await expect(sent).not.toContainText("**");
			await expect(send.locator(".ds-json-block, .ds-args")).toHaveCount(0);
			await body.getByRole("button", { name: "Show details" }).click();
			await expect(
				send
					.locator(".ds-pulsar-raw .ds-args, .ds-pulsar-raw .ds-json-block")
					.first(),
			).toBeVisible();

			// respond: the sender and the message it answers, from the transcript.
			const reply = cards.filter({ hasText: "Replied to" }).first();
			await reply.scrollIntoViewIfNeeded();
			await expect(reply.locator(".ds-tool-head .ds-pulsar-chip")).toHaveText(
				"reviewer@demo",
			);
			await openCard(reply);
			await expect(reply.locator(".ds-pulsar-quote")).toContainText(
				"flaky retry test",
			);

			// list_agents: agents link to their sessions.
			const list = cards.filter({ hasText: "3 agents" }).first();
			await list.scrollIntoViewIfNeeded();
			await openCard(list);
			await expect(
				list.locator('a.ds-pulsar-chip[href="#/a/codex%3Ademo-reviewer"]'),
			).toBeVisible();
			// A name the mock does not know: the chip says it is not running now.
			const byName = reply
				.locator("button.ds-pulsar-chip[data-agent-name]")
				.first();
			await byName.click();
			await expect(byName).toBeDisabled();

			// Errors in red: "Failed" in the head (the reason as its title),
			// the reason once in the body.
			await expect(
				cards
					.filter({ has: page.locator('[title^="No live agent matches"]') })
					.first(),
			).toHaveClass(/is-error/);

			// A name the mock knows opens that agent's session.
			const toAll = cards
				.filter({ hasText: "Sent to" })
				.filter({ hasText: "everyone" })
				.last();
			await toAll.scrollIntoViewIfNeeded();
			await openCard(toAll);
			await toAll
				.locator('button.ds-pulsar-chip[data-agent-name="apparish-auth"]')
				.click();
			// That agent's own session, not just any (a no-op click stays here).
			const target = await agentId(request, "name=apparish-auth");
			await expect(page).toHaveURL(
				new RegExp(`#/a/${encodeURIComponent(target)}$`),
			);
			await page.goBack();
			await expect(cards.first()).toBeAttached();
		});
}
