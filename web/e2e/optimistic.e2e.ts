import type { APIRequestContext, Page } from "@playwright/test";
import type { AgentsPage } from "../src/api/types.ts";
import {
	agentId,
	expect,
	localhostBase,
	proveInSheet,
	test,
	withPasskey,
} from "./fixtures.ts";

/**
 * Optimistic rendering on a slow, failing network (docs/optimistic.md):
 * the mock delays or fails chosen requests (`/__mock/faults`) and echoes
 * sends into the transcript as a harness does. Feedback must be instant,
 * a failure must roll back with Retry, and the echo must never duplicate
 * the bubble, whether it lands before or after the send's response.
 */

interface Rule {
	method?: string;
	path: string;
	count?: number;
	beforeMs?: number;
	afterMs?: number;
	fail?: number;
	failAfter?: number;
}

async function faults(
	request: APIRequestContext,
	body: { rules?: Rule[]; echoMs?: number } = {},
) {
	const res = await request.post("/api/v1/__mock/faults", {
		headers: { "X-Pulsar": "1" },
		data: body,
	});
	expect(res.ok()).toBe(true);
}

test.afterEach(async ({ request, errors }) => {
	await faults(request);
	// The browser logs each injected failure; any other console error still fails.
	const injected =
		/^Failed to load resource: the server responded with a status of 50[023]/;
	for (let i = errors.length - 1; i >= 0; i--)
		if (injected.test(errors[i]!)) errors.splice(i, 1);
});

/** Opens an agent's session and waits for its transcript. */
async function openSession(page: Page, id: string) {
	await page.goto(`/#/a/${encodeURIComponent(id)}`);
	await expect(page.locator(".session-header h1")).toBeVisible();
	await expect(page.locator(".transcript-skel")).toHaveCount(0, {
		timeout: 15_000,
	});
}

/**
 * The sent messages holding this text (optimistic or echoed): the
 * operator's own bubble, or the app's line for an unproven send.
 */
const bubbles = (page: Page, text: string) =>
	page.locator(".ds-turn--user, .ds-turn--peer.is-app", { hasText: text });
const echoed = (page: Page, text: string) =>
	page.locator(".ds-turn[data-pulsar-id]:not([data-msg-id^='local:'])", {
		hasText: text,
	});

async function send(page: Page, text: string) {
	await page.locator(".composer-input").fill(text);
	await page.keyboard.press("ControlOrMeta+Enter");
}

test.describe("optimistic sends", () => {
	test("the bubble shows at once on a slow send, then the echo replaces it (echo after the response)", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await openSession(page, id);
		await faults(request, {
			rules: [{ method: "POST", path: "/send", beforeMs: 2500 }],
			echoMs: 300,
		});
		const text = `slow send ${Date.now()}`;
		const t0 = Date.now();
		await send(page, text);
		await expect(bubbles(page, text)).toHaveCount(1, { timeout: 1000 });
		expect(Date.now() - t0).toBeLessThan(1000);
		await expect(page.locator('[data-send-state="sending"]')).toBeVisible();
		// The box is free for the next message at once.
		await expect(page.locator(".composer-input")).toHaveValue("");
		await expect(page.locator('[data-send-state="sending"]')).toHaveCount(0, {
			timeout: 8000,
		});
		// The echo carries the message id: it takes the bubble's place.
		await expect(echoed(page, text)).toHaveCount(1, { timeout: 5000 });
		await page.waitForTimeout(500);
		await expect(bubbles(page, text)).toHaveCount(1);
		// One state line, under that bubble: the receipts' state now.
		const note = bubbles(page, text).locator(".ds-delivery");
		await expect(note).toHaveText(/^(Sent|Delivered|Read|Replied)/);
		await expect(page.locator(".ds-delivery")).toHaveCount(1);
		await expect(page.locator(".ds-send-state")).toHaveCount(0);
	});

	test("an echo that lands before the response leaves one bubble", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await openSession(page, id);
		// Handled at once (echo after 100 ms), response held 2.5 s.
		await faults(request, {
			rules: [{ method: "POST", path: "/send", afterMs: 2500 }],
			echoMs: 100,
		});
		const text = `echo first ${Date.now()}`;
		await send(page, text);
		await expect(bubbles(page, text)).toHaveCount(1, { timeout: 1000 });
		// The echo arrives while the send is in flight: still one bubble.
		await page.waitForTimeout(1200);
		await expect(bubbles(page, text)).toHaveCount(1);
		await page.waitForTimeout(2000);
		await expect(bubbles(page, text)).toHaveCount(1);
		await expect(page.locator('[data-send-state="sending"]')).toHaveCount(0);
	});

	test("a failed send stays as Not sent with Retry; Retry sends it once", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await openSession(page, id);
		await faults(request, {
			rules: [{ method: "POST", path: "/send", fail: 503, count: 1 }],
			echoMs: 100,
		});
		const text = `fails once ${Date.now()}`;
		await send(page, text);
		const failed = page.locator('[data-send-state="failed"]');
		await expect(failed).toContainText("Not sent");
		await expect(bubbles(page, text)).toHaveCount(1);
		await failed.getByRole("button", { name: "Retry" }).click();
		await expect(failed).toHaveCount(0);
		await expect(echoed(page, text)).toHaveCount(1, { timeout: 5000 });
		await expect(bubbles(page, text)).toHaveCount(1);
	});

	test("a lost response, then Retry: the daemon sends it once (client id)", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await openSession(page, id);
		// The send is handled (and echoed), but its response is lost.
		await faults(request, {
			rules: [{ method: "POST", path: "/send", failAfter: 502, count: 1 }],
			// The echo lands after the failure shows (a fast echo would mark
			// the bubble sent first).
			echoMs: 1500,
		});
		const text = `lost response ${Date.now()}`;
		await send(page, text);
		await expect(page.locator('[data-send-state="failed"]')).toBeVisible();
		await page
			.locator('[data-send-state="failed"]')
			.getByRole("button", { name: "Retry" })
			.click();
		await page.waitForTimeout(3500);
		// A second send would echo a second line.
		await expect(bubbles(page, text)).toHaveCount(1);
		await expect(page.locator(".ds-send-state")).toHaveCount(0);
	});

	test("Delete removes a failed bubble", async ({ page, request }) => {
		const id = await agentId(request, "name=codex@apparish");
		await openSession(page, id);
		await faults(request, {
			rules: [{ method: "POST", path: "/send", fail: 500, count: 1 }],
		});
		const text = `deleted ${Date.now()}`;
		await send(page, text);
		const failed = page.locator('[data-send-state="failed"]');
		await failed.getByRole("button", { name: "Delete" }).click();
		await expect(bubbles(page, text)).toHaveCount(0);
	});

	test("a send to several agents shows Sending… and, on failure, an error with Retry", async ({
		page,
		request,
	}) => {
		await page.goto("/");
		await page.locator('[data-node="m:studio/p:apparish"] .row-main').click();
		await expect(page.locator(".scope h1")).toBeVisible();
		await faults(request, {
			rules: [
				{ method: "POST", path: "/send", beforeMs: 1500, fail: 503, count: 2 },
			],
		});
		await page
			.locator(".scope .composer-input")
			.fill("several recipients, slow and failing");
		await page.keyboard.press("ControlOrMeta+Enter");
		// The dry run is slow too: the composer says so at once.
		await expect(page.getByRole("status").filter({ hasText: /…/ })).toBeVisible(
			{ timeout: 1000 },
		);
		const alert = page.locator(".composer .error");
		await expect(alert).toBeVisible({ timeout: 8000 });
		// The text is back in the box.
		await expect(page.locator(".scope .composer-input")).toHaveValue(
			"several recipients, slow and failing",
		);
	});
});

async function change(request: APIRequestContext, body: object) {
	const res = await request.post("/api/v1/__mock/realtime", {
		headers: { "X-Pulsar": "1" },
		data: body,
	});
	expect(res.ok()).toBe(true);
	return (await res.json()) as Record<string, string>;
}

test.describe("broadcast builder", () => {
	test("Send says Checking…/Sending…; a failure shows Retry, and Retry sends it once", async ({
		page,
		request,
	}) => {
		await page.goto(
			`/#/broadcast?s=${encodeURIComponent("project=apparish machine=studio")}`,
		);
		const sendBtn = page.locator(".bc-send-btn");
		await expect(sendBtn).toContainText(/Send to \d+/, { timeout: 15_000 });
		// The dry run goes through (slowly); the real send fails once.
		await faults(request, {
			rules: [
				{ method: "POST", path: "/send", beforeMs: 800, count: 1 },
				{ method: "POST", path: "/send", fail: 503, count: 1 },
			],
		});
		await page.locator("#bc-body").fill(`builder retry ${Date.now()}`);
		await sendBtn.click();
		await expect(sendBtn).toContainText(/Checking…|Sending…/, {
			timeout: 1000,
		});
		// A wide send asks first (inline or in a dialog): confirm it.
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: /^(Confirm send to|Send to) \d+/ })
			.click({ timeout: 8000 });
		const alert = page.locator(".bc-error");
		await expect(alert).toBeVisible({ timeout: 8000 });
		await alert.getByRole("button", { name: "Retry" }).click();
		await expect(alert).toHaveCount(0, { timeout: 8000 });
	});
});

test.describe("answers are never optimistic", () => {
	test("an answer says Answering… until the daemon confirms, then its outcome", async ({
		page,
		request,
		context,
	}) => {
		const id = await agentId(request, "name=omp@apparish");
		await page.goto(localhostBase());
		await withPasskey(page, request, context);
		await change(request, { action: "interaction", id, kind: "confirm" });
		await page.goto(`${localhostBase()}/#/approval/${encodeURIComponent(id)}`);
		const card = page.locator(".prompt-inline .interaction-card");
		await expect(card).toBeVisible({ timeout: 15_000 });
		await faults(request, {
			rules: [{ method: "POST", path: "/approvals/", beforeMs: 2500 }],
		});
		await card.getByRole("button", { name: /^Yes( · Face ID)?$/ }).click();
		await proveInSheet(page);
		await expect(card.getByRole("status")).toContainText("Answering…");
		await expect(page.locator(".prompt-outcome")).toHaveCount(0);
		await expect(page.locator(".prompt-outcome")).toContainText(
			"Confirmed by",
			{ timeout: 10_000 },
		);
	});

	test("a refused answer shows the error and leaves the prompt open to answer again", async ({
		page,
		request,
		context,
	}) => {
		const id = await agentId(request, "name=omp@apparish");
		await page.goto(localhostBase());
		await withPasskey(page, request, context);
		await change(request, { action: "interaction", id, kind: "confirm" });
		await page.goto(`${localhostBase()}/#/approval/${encodeURIComponent(id)}`);
		const card = page.locator(".prompt-inline .interaction-card");
		await expect(card).toBeVisible({ timeout: 15_000 });
		await faults(request, {
			rules: [{ method: "POST", path: "/approvals/", fail: 500, count: 1 }],
		});
		const yes = card.getByRole("button", { name: /^Yes( · Face ID)?$/ });
		await yes.click();
		await proveInSheet(page);
		await expect(card.getByRole("alert")).toBeVisible();
		await expect(page.locator(".prompt-outcome")).toHaveCount(0);
		await yes.click();
		await expect(page.locator(".prompt-outcome")).toContainText(
			"Confirmed by",
			{ timeout: 10_000 },
		);
	});
});

test.describe("Stop and navigation", () => {
	test("Stop says Stopping… until the daemon answers; the row is not idle before", async ({
		page,
		request,
		context,
	}) => {
		const list = (
			(await (
				await request.get(
					`/api/v1/agents?selector=${encodeURIComponent("status=busy")}&limit=500&sort=name`,
					{ headers: { "X-Pulsar": "1" } },
				)
			).json()) as AgentsPage
		).items;
		const busy = list.find((a) => a.canStop && !a.name.startsWith("apparish"))!;
		await page.goto(`${localhostBase()}/`);
		await withPasskey(page, request, context);
		await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(busy.id)}`);
		await expect(page.locator(".session-header h1")).toHaveText(busy.name);
		await faults(request, {
			rules: [{ method: "POST", path: "/agents/", beforeMs: 2000 }],
		});
		await page.getByRole("button", { name: "Stop", exact: true }).click();
		const confirm = page.getByRole("alertdialog", { name: "Confirm stop" });
		await confirm.getByRole("button", { name: "Stop this turn" }).click();
		await proveInSheet(page);
		await expect(
			confirm.getByRole("button", { name: "Stopping…" }),
		).toBeDisabled({ timeout: 1000 });
		// Not optimistic: the header says Stopping…, never Idle, until the answer.
		await expect(page.locator(".session-header [aria-live]")).toHaveText(
			"Stopping…",
		);
		await expect(page.locator(".session-header")).not.toContainText(/\bIdle\b/);
		await expect(page.locator(".toast")).toHaveText(
			`Stopped ${busy.name}'s turn`,
			{ timeout: 8000 },
		);
	});

	test("a revisited session shows its transcript at once while it refetches", async ({
		page,
		request,
	}) => {
		const a = await agentId(request, "name=codex@apparish");
		const b = await agentId(request, "name=apparish-auth");
		await openSession(page, a);
		await openSession(page, b);
		await faults(request, {
			rules: [
				{ method: "GET", path: `/agents/${a}/transcript`, beforeMs: 4000 },
			],
		});
		await page.goBack();
		await expect(page.locator(".ds-turn").first()).toBeVisible({
			timeout: 1000,
		});
		await expect(page.locator(".transcript-skel")).toHaveCount(0);
	});

	test("hovering a row prefetches the session: it opens without a skeleton", async ({
		page,
		request,
	}) => {
		await page.goto("/");
		await page.locator('[data-node="m:studio/p:apparish"] .chev').click();
		const row = page
			.locator(".tree [data-agent]", { hasText: "codex@apparish" })
			.first();
		await expect(row).toBeVisible();
		const id = await row.getAttribute("data-agent");
		await faults(request, {
			rules: [
				{ method: "GET", path: `/agents/${id}/transcript`, beforeMs: 1500 },
			],
		});
		await row.hover();
		// The prefetch is in flight while the pointer rests; it lands in 1.5 s.
		await page.waitForTimeout(2200);
		await row.click();
		await expect(page.locator(".session-header h1")).toBeVisible();
		await expect(page.locator(".ds-turn").first()).toBeVisible({
			timeout: 700,
		});
		await expect(page.locator(".transcript-skel")).toHaveCount(0);
	});
});
