import { devices } from "@playwright/test";
import { expect, test } from "../fixtures.ts";

const PORT = Number(process.env.PULSAR_REAL_PORT ?? 47392);
const CONTROL = `http://127.0.0.1:${Number(process.env.PULSAR_REAL_CONTROL_PORT ?? PORT + 1)}`;

// The phone app in WebKit, as on the operator's iPhone 13 mini.
const { defaultBrowserType: _, ...phone } = devices["iPhone 13 Mini"];
test.use({ ...phone, browserName: "webkit" });

/**
 * Nothing about subagents shows for an agent with none listed: the real
 * daemon's fixer has one finished subagent, and "Show finished subagents"
 * is off; reviewer has none at all.
 */
test("no Subagents bar for an agent with none listed (phone) @real", async ({
	page,
	request,
}) => {
	const ids = (await (await request.get(`${CONTROL}/agents`)).json()) as {
		fixer: string;
		reviewer: string;
	};
	for (const [id, name] of [
		[ids.fixer, "fixer"],
		[ids.reviewer, "reviewer"],
	] as const) {
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const header = page.locator(".p-agent-header").last();
		// The first visit compiles the app cold in WebKit; give it time under load.
		await expect(header.locator(".p-nav-title")).toContainText(name, {
			timeout: 15_000,
		});
		// The agent row has loaded (its status line), so the bar had its chance.
		await expect(header.locator(".p-nav-sub")).toBeVisible();
		await expect(page.locator("[data-subs-section]")).toHaveCount(0);
		await expect(page.locator(".p-subs-bar")).toHaveCount(0);
		await expect(header).not.toContainText(/subagent/i);
	}
});
