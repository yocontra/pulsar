import type { BrowserContext, Page } from "@playwright/test";
import type { AgentsPage } from "../src/api/types.ts";
import {
	addAuthenticator,
	agentId,
	expect,
	localhostBase,
	resetPasskeys,
	test,
} from "./fixtures.ts";

/**
 * Prove Human once per session (SECURITY.md, docs/app.md): one passkey
 * check, then sends, Stop, permission prompts and questions on
 * this machine go on with no second ceremony; every open tab shares it; a
 * reload keeps it only where the token may persist (the installed phone app)
 * or while another tab holds it. Runs in `prove-once-desktop` and
 * `prove-once-phone`.
 */

const phone = () => test.info().project.name.endsWith("phone");

/** Counts every WebAuthn ceremony this page starts (`get` and `create`). */
async function countCeremonies(context: BrowserContext) {
	await context.addInitScript(() => {
		const w = window as unknown as { __ceremonies: number };
		w.__ceremonies = 0;
		const c = navigator.credentials;
		if (!c) return;
		const get = c.get.bind(c);
		const create = c.create.bind(c);
		c.get = (o) => {
			if (o && "publicKey" in o) w.__ceremonies++;
			return get(o);
		};
		c.create = (o) => {
			if (o && "publicKey" in o) w.__ceremonies++;
			return create(o);
		};
	});
}

const ceremonies = (page: Page) =>
	page.evaluate(
		() => (window as unknown as { __ceremonies: number }).__ceremonies,
	);

async function realtime(
	request: import("@playwright/test").APIRequestContext,
	body: object,
) {
	const res = await request.post("/api/v1/__mock/realtime", {
		headers: { "X-Pulsar": "1" },
		data: body,
	});
	expect(res.ok()).toBe(true);
	return (await res.json()) as Record<string, string>;
}

const sheet = (page: Page) => page.getByRole("dialog", { name: "Prove Human" });

/** Goes home without reloading the page. */
async function home(page: Page) {
	await page.evaluate(() => {
		location.hash = "#/";
	});
}

/** The nav's Prove Human item says whether this tab is proven. */
async function expectProven(page: Page, yes: boolean) {
	// The desktop sidebar or the phone's Settings, by hash: a full
	// navigation would be a reload.
	await home(page);
	if (phone()) await page.getByTestId("tab-settings").click();
	await expect(
		page.getByRole("button", { name: /^Prove Human: / }).first(),
	).toHaveAttribute(
		"aria-label",
		yes ? /^Prove Human: Proven/ : /^Prove Human: Not proven/,
	);
}

/** Answers apparish-auth's pending permission prompt with Allow once. */
async function allowOnce(page: Page, authId: string) {
	await page.goto(
		`${localhostBase()}/#/approval/${encodeURIComponent(authId)}`,
	);
	const card = page.locator(".prompt-inline .approval-card");
	await expect(card).toBeVisible();
	await card.getByRole("button", { name: /^Allow once( · Face ID)?$/ }).click();
	return card;
}

test.describe("Prove Human once", () => {
	test.beforeEach(async ({ page, request, context }) => {
		await resetPasskeys(request);
		await countCeremonies(context);
		await page.goto(`${localhostBase()}/`);
		await addAuthenticator(page, context);
	});
	test.afterEach(async ({ request }) => {
		await realtime(request, { action: "restore" });
	});

	test("prove once (ad hoc, from a prompt), then send, Stop, a prompt and a question: no second check", async ({
		page,
		request,
	}) => {
		const authId = await agentId(request, "name=apparish-auth");
		// 1. A permission prompt, unproven: Prove Human opens inline, one
		// passkey check makes the passkey and the session, the answer goes on.
		await allowOnce(page, authId);
		await expect(sheet(page)).toContainText("To answer this prompt");
		await sheet(page)
			.getByRole("button", { name: /^Prove with/ })
			.click();
		await expect(sheet(page)).toHaveCount(0);
		await expect(page.locator(".prompt-outcome")).toContainText(
			/Allowed once by You · passkey session on /,
		);
		expect(await ceremonies(page)).toBe(1);

		// 2. Another prompt (an omp confirm dialog): no check.
		const ompId = await agentId(request, "name=omp@apparish");
		await realtime(request, {
			action: "interaction",
			id: ompId,
			kind: "confirm",
		});
		await page.goto(
			`${localhostBase()}/#/approval/${encodeURIComponent(ompId)}`,
		);
		const confirm = page.locator('.interaction-card[data-kind="confirm"]');
		// Proven, and the prompt is local: the button promises no Face ID.
		await expect(
			confirm.getByRole("button", { name: "Yes", exact: true }),
		).toBeVisible();
		await confirm.getByRole("button", { name: /^Yes( · Face ID)?$/ }).click();
		await expect(page.locator(".prompt-outcome")).toContainText(
			"Confirmed by You",
		);
		await expect(sheet(page)).toHaveCount(0);

		// 3. A question (an interaction): answered with the session.
		await realtime(request, {
			action: "interaction",
			id: authId,
			kind: "question",
		});
		await page.goto(
			`${localhostBase()}/#/approval/${encodeURIComponent(authId)}`,
		);
		const ix = page.locator('.interaction-card[data-kind="question"]');
		await expect(ix).toBeVisible();
		await ix.getByRole("radio", { name: /OAuth/ }).check();
		await ix.getByRole("checkbox", { name: /staging/ }).check();
		await ix
			.getByRole("button", { name: /^Send answer( · Face ID)?$/ })
			.click();
		await expect(page.locator(".prompt-outcome")).toContainText(
			/Answered: OAuth/,
		);
		await expect(sheet(page)).toHaveCount(0);

		if (!phone()) {
			// 4. Send as the operator: no Prove Human, receipts follow.
			await home(page);
			await page.locator('[data-node="m:studio/p:apparish"] .chev').click();
			await page
				.locator(".tree [data-agent]", { hasText: "codex@apparish" })
				.first()
				.click();
			await page.locator(".composer-input").fill("proven once");
			await page.keyboard.press("ControlOrMeta+Enter");
			await expect(page.locator(".ds-delivery").last()).toHaveText(
				/Sent|Delivered|Read|Replied/,
				{ timeout: 8000 },
			);
			await expect(sheet(page)).toHaveCount(0);

			// 5. Stop a busy agent on this machine: no Prove Human.
			const busy = (
				(await (
					await request.get(
						`/api/v1/agents?selector=${encodeURIComponent("status=busy")}&limit=500&sort=name`,
						{ headers: { "X-Pulsar": "1" } },
					)
				).json()) as AgentsPage
			).items.find((a) => a.canStop && !a.name.startsWith("apparish"))!;
			await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(busy.id)}`);
			await expect(page.locator(".session-header h1")).toHaveText(busy.name);
			await page.getByRole("button", { name: "Stop", exact: true }).click();
			await page
				.getByRole("alertdialog", { name: "Confirm stop" })
				.getByRole("button", { name: "Stop this turn" })
				.click();
			await expect(page.locator(".toast")).toContainText(busy.name);
			await expect(sheet(page)).toHaveCount(0);
		}

		// One WebAuthn ceremony in all.
		expect(await ceremonies(page)).toBe(1);
		await expectProven(page, true);
	});

	test("every open tab shares the proof; signing out signs out every tab", async ({
		page,
		context,
		request,
	}) => {
		const authId = await agentId(request, "name=apparish-auth");
		await allowOnce(page, authId);
		await sheet(page)
			.getByRole("button", { name: /^Prove with/ })
			.click();
		await expect(sheet(page)).toHaveCount(0);

		// A second tab of the same machine's app is proven at once.
		const second = await context.newPage();
		await second.goto(`${localhostBase()}/`);
		// The same browser's Face ID (the cards check for one).
		await addAuthenticator(second, context);
		await expectProven(second, true);
		await realtime(request, { action: "restore" });
		await allowOnce(second, authId);
		await expect(second.locator(".prompt-outcome")).toContainText(
			/Allowed once by You · passkey session/,
		);
		await expect(sheet(second)).toHaveCount(0);
		expect(await ceremonies(second)).toBe(0);

		// Sign out in the second tab: the first tab is signed out too.
		await home(second);
		if (phone()) await second.getByTestId("tab-settings").click();
		await second
			.getByRole("button", { name: /^Prove Human: / })
			.first()
			.click();
		await sheet(second)
			.getByRole("button", { name: "Sign out this device" })
			.click();
		await page.bringToFront();
		await expectProven(page, false);
		await second.close();
	});

	test("a reload: proven while another tab is open; alone, only the installed phone app keeps it", async ({
		page,
		context,
		request,
	}) => {
		const authId = await agentId(request, "name=apparish-auth");
		await allowOnce(page, authId);
		await sheet(page)
			.getByRole("button", { name: /^Prove with/ })
			.click();
		await expect(sheet(page)).toHaveCount(0);

		// Another tab holds the token: a reload takes it back from there.
		const other = await context.newPage();
		await other.goto(`${localhostBase()}/`);
		await expectProven(other, true);
		await page.reload();
		await expectProven(page, true);
		await other.close();

		// Alone: a reload in a browser tab (desktop or phone) forgets it, so
		// the next gated action asks again.
		await page.reload();
		await expectProven(page, false);
		expect(
			await page.evaluate(() => localStorage.getItem("pulsar.session")),
		).toBeNull();
	});

	test("the installed phone app keeps the proof across a reload", async ({
		page,
		context,
		request,
	}) => {
		test.skip(!phone(), "the installed app is a phone's");
		// Running from the home screen: (display-mode: standalone).
		await context.addInitScript(() => {
			const mm = window.matchMedia.bind(window);
			window.matchMedia = (q: string) =>
				// A query that always matches stands in (a real MediaQueryList).
				mm(q === "(display-mode: standalone)" ? "(min-width: 0px)" : q);
		});
		await page.reload();
		const authId = await agentId(request, "name=apparish-auth");
		await allowOnce(page, authId);
		await sheet(page)
			.getByRole("button", { name: /^Prove with/ })
			.click();
		await expect(sheet(page)).toHaveCount(0);
		// Restore first: its live update must not land while the sheet opens.
		await realtime(request, { action: "restore" });
		await page.reload();
		// Straight to the prompt (a home → sheet hop mid-transition can drop
		// the phone's sheet): answered with the kept session, no check.
		await allowOnce(page, authId);
		await expect(page.locator(".prompt-outcome")).toContainText(
			/Allowed once by You · passkey session/,
		);
		expect(await ceremonies(page)).toBe(0);
		await page.keyboard.press("Escape");
		await expectProven(page, true);
	});
});
