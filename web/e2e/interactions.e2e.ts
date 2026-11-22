import type { APIRequestContext, Locator, Page } from "@playwright/test";
import {
	addAuthenticator,
	agentId,
	expect,
	localhostBase,
	proveInSheet,
	resetPasskeys,
	test,
	withPasskey,
} from "./fixtures.ts";

/**
 * Interactions answered from the app, on the
 * desktop (dialog) and the phone (sheet): every kind, the passkey gate,
 * and first answer wins against the agent's own screen and another device.
 * Runs in the `interactions-desktop` and `interactions-phone` projects.
 */

async function change(request: APIRequestContext, body: object) {
	const res = await request.post("/api/v1/__mock/realtime", {
		headers: { "X-Pulsar": "1" },
		data: body,
	});
	expect(res.ok()).toBe(true);
	return (await res.json()) as Record<string, string>;
}

/** Opens the agent's interaction card, inline in its conversation. */
async function open(page: Page, agent: string): Promise<Locator> {
	await page.goto(`${localhostBase()}/#/approval/${encodeURIComponent(agent)}`);
	const card = page.locator(".prompt-inline .interaction-card");
	// The card waits on the attention list and two lazy chunks: slow machines.
	await expect(card).toBeVisible({ timeout: 15_000 });
	return card;
}

/** The answer's options request, made again (another device answering late). */
async function lateOptions(
	request: APIRequestContext,
	requestId: string,
	answer: object,
) {
	const r = await request.post(
		`/api/v1/approvals/${encodeURIComponent(requestId)}/options`,
		{
			headers: { "X-Pulsar": "1" },
			data: { decision: "answer", answer },
		},
	);
	return { status: r.status(), body: await r.json() };
}

test.describe("interactions", () => {
	test.afterEach(async ({ request }) => {
		await change(request, { action: "restore" });
	});

	test("a question: chips, options, Other; signed answer; a later answer loses", async ({
		page,
		request,
		context,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(localhostBase());
		await withPasskey(page, request, context);
		const { requestId } = await change(request, {
			action: "interaction",
			id,
			kind: "question",
		});
		const card = await open(page, id);
		await expect(
			card
				.getByRole("heading", { name: "Claude asks" })
				.or(card.getByText("Claude asks").first()),
		).toBeVisible();
		await expect(
			card.locator(".ix-chip", { hasText: "Auth method" }),
		).toBeVisible();
		await expect(card).toContainText("Sign in with the identity provider");
		const send = card.getByRole("button", {
			name: /^Send answer( · Face ID)?$/,
		});
		await expect(send).toBeDisabled();
		await card.getByRole("radio", { name: /OAuth/ }).check();
		await card.getByRole("checkbox", { name: /staging/ }).check();
		await card.getByRole("checkbox", { name: "Other" }).check();
		await card
			.getByLabel("Other answer: Which environments get it first?")
			.fill("canary");
		await send.click();
		// Not proven in this tab yet: one check, then the answer goes with the session.
		await proveInSheet(page);
		await expect(page.locator(".prompt-outcome")).toContainText(
			/Answered: OAuth · staging, canary by You · passkey session on /,
		);
		// Another device answering after: refused with the outcome.
		const late = await lateOptions(request, requestId!, {
			kind: "question",
			answers: {
				"Which auth method should the API use?": ["API keys"],
				"Which environments get it first?": ["dev"],
			},
		});
		expect(late.status).toBe(409);
		expect(JSON.stringify(late.body)).toContain("Answered: OAuth");
	});

	test("a plan: Markdown, then Keep planning with feedback", async ({
		page,
		request,
		context,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(localhostBase());
		await withPasskey(page, request, context);
		await change(request, { action: "interaction", id, kind: "plan" });
		const card = await open(page, id);
		await expect(card).toContainText("Claude's plan");
		await expect(
			card.locator(".ix-plan-body h2", {
				hasText: "Fix the token refresh race",
			}),
		).toBeVisible();
		await expect(card.locator(".ix-plan-body li")).toHaveCount(3);
		await card.getByRole("button", { name: "Keep planning…" }).click();
		await card.getByLabel("Feedback for the agent").fill("Add a load test");
		await card.getByRole("button", { name: "Keep planning" }).click();
		await proveInSheet(page);
		await expect(page.locator(".prompt-outcome")).toContainText(
			/^Keep planning by You /,
		);
	});

	test("host dialogs: select, confirm and input from omp", async ({
		page,
		request,
		context,
	}) => {
		const id = await agentId(request, "name=omp@apparish");
		await page.goto(localhostBase());
		await withPasskey(page, request, context);

		await change(request, { action: "interaction", id, kind: "select" });
		let card = await open(page, id);
		await expect(card).toContainText("Deploy where?");
		await card.getByRole("button", { name: /^staging/ }).click();
		// Proven once here: the confirm and the input below ask nothing more.
		await proveInSheet(page);
		await expect(page.locator(".prompt-outcome")).toContainText(
			"Picked: staging by You",
		);

		await change(request, { action: "restore" });
		await change(request, { action: "interaction", id, kind: "confirm" });
		card = await open(page, id);
		await expect(card).toContainText("This rewrites 3 commits on origin.");
		await card.getByRole("button", { name: /^Yes( · Face ID)?$/ }).click();
		await expect(page.locator(".prompt-outcome")).toContainText(
			"Confirmed by You",
		);

		await change(request, { action: "restore" });
		await change(request, { action: "interaction", id, kind: "input" });
		card = await open(page, id);
		await card.getByLabel("Commit message").fill("fix: serialize refresh");
		await card.getByRole("button", { name: /^Send( · Face ID)?$/ }).click();
		await expect(page.locator(".prompt-outcome")).toContainText(
			"Answered by You",
		);
	});

	test("the agent's own screen answers first: the card shows it", async ({
		page,
		request,
		context,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(localhostBase());
		await withPasskey(page, request, context);
		await change(request, { action: "interaction", id, kind: "question" });
		const card = await open(page, id);
		await expect(card.getByRole("radio", { name: /OAuth/ })).toBeVisible();
		await change(request, { action: "answered-locally", id });
		await expect(page.locator(".prompt-outcome")).toContainText(
			"Answered on studio",
		);
		await expect(card.getByRole("radio", { name: /OAuth/ })).toHaveCount(0);
	});

	test("Codex in its app-server: answered from the app", async ({
		page,
		request,
		context,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await page.goto(localhostBase());
		await withPasskey(page, request, context);
		await change(request, { action: "interaction", id, kind: "codex-live" });
		const card = await open(page, id);
		await expect(card).toContainText("Codex asks");
		await expect(card).not.toContainText(
			"Waiting for an answer in the terminal",
		);
		await card.getByRole("radio", { name: /staging/ }).check();
		await card
			.getByRole("button", { name: /^Send answer( · Face ID)?$/ })
			.click();
		await proveInSheet(page);
		await expect(page.locator(".prompt-outcome")).toContainText(
			/Answered: staging by You/,
		);
	});

	test("Codex with --no-daemon: shown read-only, answered only in its terminal", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await change(request, { action: "interaction", id, kind: "codex" });
		const card = await open(page, id);
		await expect(card).toContainText("Codex asks");
		await expect(card).toContainText(
			"Waiting for an answer in the terminal on",
		);
		await expect(card).toContainText("Which environment should I deploy to?");
		await expect(
			card.getByRole("button", { name: /^Send answer( · Face ID)?$/ }),
		).toBeDisabled();
		await change(request, { action: "answered-locally", id });
		await expect(page.locator(".prompt-outcome")).toContainText("Answered on");
	});

	test("no passkey: Prove Human first, then the answer goes on", async ({
		page,
		request,
		context,
	}) => {
		await resetPasskeys(request);
		await page.goto(localhostBase());
		await addAuthenticator(page, context);
		const id = await agentId(request, "name=omp@apparish");
		await change(request, { action: "interaction", id, kind: "confirm" });
		const card = await open(page, id);
		await card.getByRole("button", { name: /^Yes( · Face ID)?$/ }).click();
		// Nothing is answered before the person is proven.
		await expect(page.locator(".prompt-outcome")).toHaveCount(0);
		await proveInSheet(page);
		await expect(page.locator(".prompt-outcome")).toContainText("Confirmed by");
	});
});
