import type { APIRequestContext, Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * The whole UI is live: a change on the server shows within 1 s, with no
 * reload and no user action (the event stream patches the query cache).
 * The mock's `/__mock/realtime` changes state and pushes it at once.
 */
const LIVE_MS = 1000;

async function change(request: APIRequestContext, body: object) {
	const res = await request.post("/api/v1/__mock/realtime", {
		headers: { "X-Pulsar": "1" },
		data: body,
	});
	expect(res.ok()).toBe(true);
	return (await res.json()) as Record<string, string>;
}

/** The subscription follows what is mounted (debounced): let it land. */
const settle = (page: Page) => page.waitForTimeout(800);

async function openApparish(page: Page) {
	await ready(page);
	const apparish = page.locator('[data-node="m:studio/p:apparish"]');
	if ((await apparish.getAttribute("aria-expanded")) !== "true")
		await apparish.locator(".chev").click();
	await expect(
		page.locator(".tree [data-agent]", { hasText: "apparish-auth" }),
	).toBeVisible();
}

test.describe("realtime", () => {
	// The mock serves every project in the run: put its fixtures back.
	test.afterAll(async ({ request }) => {
		await change(request, { action: "restore" });
	});

	test("an agent's status changes in the tree", async ({ page, request }) => {
		const id = await agentId(request, "name=apparish-auth");
		await change(request, { action: "status", id, status: "idle" });
		await openApparish(page);
		const row = page.locator(`.tree [data-agent="${id}"]`);
		await expect(row).toHaveAttribute("aria-label", /, idle/);
		await settle(page);
		await change(request, { action: "status", id, status: "busy" });
		await expect(row).toHaveAttribute("aria-label", /, busy/, {
			timeout: LIVE_MS,
		});
		await change(request, { action: "status", id, status: "idle" });
		await expect(row).toHaveAttribute("aria-label", /, idle/, {
			timeout: LIVE_MS,
		});
	});

	test("a new agent appears in its branch", async ({ page, request }) => {
		await openApparish(page);
		await settle(page);
		const name = `rt-new-${Date.now().toString(36)}`;
		await change(request, {
			action: "add-agent",
			name,
			machine: "studio",
			project: "apparish",
		});
		await expect(
			page.locator(".tree [data-agent]", { hasText: name }),
		).toBeVisible({ timeout: LIVE_MS });
	});

	test("a needs-you item shows", async ({ page, request }) => {
		const id = await agentId(request, "name=apparish-auth");
		await change(request, { action: "status", id, status: "idle" });
		await openApparish(page);
		await settle(page);
		// The sidebar's needs-you count comes from the attention topic.
		const needCount = async () => {
			const t = await page
				.locator(".d-section .ds-needs-badge > [aria-hidden]")
				.first()
				.textContent({ timeout: 100 })
				.catch(() => null);
			return t ? Number(t.replace(/\D/g, "")) : 0;
		};
		const before = await needCount();
		await change(request, { action: "needs-you", id });
		await expect
			.poll(needCount, { timeout: LIVE_MS, intervals: [50] })
			.toBeGreaterThan(before);
		await expect(page.locator(`.tree [data-agent="${id}"]`)).toHaveAttribute(
			"aria-label",
			/needs approval/,
			{ timeout: LIVE_MS },
		);
	});

	test("a prompt only the terminal answers shows read-only, with no answer buttons", async ({
		page,
		request,
	}) => {
		// An agent of its own: no other test shares it.
		const name = `rt-term-${Date.now().toString(36)}`;
		const { id } = (await change(request, {
			action: "add-agent",
			name,
			machine: "studio",
			project: "apparish",
		})) as { id: string };
		await change(request, { action: "terminal", id, expired: true });
		await ready(page);
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const card = page.locator("[data-terminal-card]");
		await expect(card).toContainText("Answer in the terminal on studio");
		await expect(card).toContainText("The app's time to answer ran out.");
		// The expired prompt's details, exactly as the approval card shows them.
		await expect(card).toContainText("Clean and rebuild");
		await expect(card.getByRole("button")).toHaveText(["Copy command"]);
		await expect(card.getByRole("timer")).toHaveCount(0);
		await expect(page.locator("#approval")).toHaveCount(0);
		// Live: the next prompt never reached the app.
		await settle(page);
		await change(request, { action: "terminal", id });
		await expect(card).toContainText("This prompt wasn't sent to the app.", {
			timeout: LIVE_MS,
		});
		await expect(card).toContainText("waiting in its terminal");
		await expect(card.getByRole("button")).toHaveCount(0);
		// Needs you: its own group, the machine to go to, never "Review".
		await page.goto("/#/needs");
		const row = page.locator(".needs-list .d-card-row", { hasText: name });
		await expect(row).toContainText("Answer in the terminal on studio");
		await expect(row).toContainText("View");
		await expect(
			page.locator(".needs-list .d-block", { hasText: name }).locator("h2"),
		).toContainText("In the terminal");
	});

	test("an agent that just went idle reads Idle, never Idle 0s", async ({
		page,
		request,
	}) => {
		// A new agent of its own (idle since now): no other test shares it.
		const name = `rt-idle-${Date.now().toString(36)}`;
		const { id } = await change(request, {
			action: "add-agent",
			name,
			machine: "studio",
			project: "apparish",
		});
		await openApparish(page);
		await page.locator(`.tree [data-agent="${id}"]`).click();
		const head = page.locator(".d-session-head");
		await expect(head).toContainText("Idle");
		// Row, header and every other label: a state is never shown with "0s".
		const zero = /\b(idle|working)( for)? 0s\b/i;
		await expect(page.locator("body")).not.toHaveText(zero);
		await expect(head).not.toHaveText(zero);
		const row = page.locator(`.tree [data-agent="${id}"]`);
		await expect(row).toHaveAttribute("aria-label", /, idle/);
		await expect(row).not.toHaveAttribute("aria-label", zero);
	});

	test("a transcript line streams into the open session", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await openApparish(page);
		const subscribed = page.waitForResponse((response) => {
			const request = response.request();
			return (
				response.ok() &&
				request.method() === "PUT" &&
				new URL(response.url()).pathname.startsWith("/api/v1/subscriptions/") &&
				request.postDataJSON()?.session === id
			);
		});
		await page.locator(`.tree [data-agent="${id}"]`).click();
		await expect(page.locator(".transcript .ev").first()).toBeVisible();
		await subscribed;
		const text = `realtime line ${Date.now().toString(36)}`;
		await change(request, { action: "transcript", id, text });
		await expect(page.locator(".transcript")).toContainText(text, {
			timeout: LIVE_MS,
		});
	});

	test("a receipt streams onto the sent bubble", async ({ page, request }) => {
		await openApparish(page);
		await page
			.locator(".tree [data-agent]", { hasText: "codex@apparish" })
			.first()
			.click();
		await page.locator(".composer-input").fill("realtime receipt check");
		await page.keyboard.press("ControlOrMeta+Enter");
		const note = page.locator(".ds-delivery").last();
		await expect(note).toBeVisible();
		await settle(page);
		const reply = `rt-reply-${Date.now().toString(36)}`;
		await change(request, { action: "receipt", state: "replied", reply });
		// The sent bubble says so, live.
		await expect(note).toHaveText("Replied", { timeout: LIVE_MS });
	});
});

test("coming back to the tab refetches what is shown", async ({ page }) => {
	await ready(page);
	// /hello polls every 10 s; after 1 s it is stale, so focus refetches it.
	await page.waitForTimeout(1500);
	let hellos = 0;
	page.on("request", (r) => {
		if (r.url().endsWith("/api/v1/hello")) hellos++;
	});
	await page.evaluate(() =>
		window.dispatchEvent(new Event("visibilitychange")),
	);
	await expect.poll(() => hellos, { timeout: LIVE_MS }).toBeGreaterThan(0);
});

test.describe("slow identity lookup (503 identity_unavailable)", () => {
	const outage = (request: APIRequestContext, body: object) =>
		request.post("/api/v1/__mock/identity", {
			headers: { "X-Pulsar": "1" },
			data: body,
		});

	test("REST retries quietly: no wrong-account screen", async ({
		page,
		request,
		errors,
	}) => {
		await outage(request, { count: 3 });
		await ready(page);
		await expect(page.locator("[data-failure]")).toHaveCount(0);
		// The 503s log "Failed to load resource"; that's the point of this test.
		errors.splice(
			0,
			errors.length,
			...errors.filter((e) => !/Failed to load resource/.test(e)),
		);
	});

	test("the stream shows Reconnecting…, then is live again", async ({
		page,
		request,
		errors,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await openApparish(page);
		await settle(page);
		await outage(request, { count: 2, eventsOnly: true, drop: true });
		await expect(
			page.getByRole("status").filter({ hasText: "Reconnecting" }),
		).toBeVisible();
		await expect(page.locator("[data-failure]")).toHaveCount(0);
		await expect(
			page.getByRole("status").filter({ hasText: "Reconnecting" }),
		).toHaveCount(0, { timeout: 10_000 });
		await settle(page);
		await change(request, { action: "status", id, status: "busy" });
		await expect(page.locator(`.tree [data-agent="${id}"]`)).toHaveAttribute(
			"aria-label",
			/, busy/,
			{ timeout: LIVE_MS },
		);
		await change(request, { action: "restore" });
		errors.splice(
			0,
			errors.length,
			...errors.filter((e) => !/Failed to load resource/.test(e)),
		);
	});
});
