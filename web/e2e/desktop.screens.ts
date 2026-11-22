/**
 * Design-review screenshots of every desktop screen
 * (see playwright.desktop-shots.config.ts). Not a test suite: each step only
 * waits for its screen and saves a PNG.
 */
import { type Page, test } from "@playwright/test";
import { addAuthenticator, agentId, resetPasskeys } from "./fixtures.ts";

const DIR =
	process.env.SHOTS_DIR ??
	new URL("../screenshots/desktop/", import.meta.url).pathname;

const shot = (page: Page, name: string) =>
	page.screenshot({
		path: `${DIR}${name}-${test.info().project.name}.png`,
	});

async function home(page: Page) {
	await page.goto("/");
	await page.locator('[data-node="m:studio"]').waitFor();
	await page.waitForTimeout(800);
}

async function session(page: Page, id: string) {
	await page.goto(`/#/a/${encodeURIComponent(id)}`);
	await page.locator(".transcript .ev").first().waitFor();
	await page.waitForTimeout(2000);
}

test.describe("desktop screens", () => {
	test("home", async ({ page }) => {
		await home(page);
		await shot(page, "01-home");
	});

	test("tree expanded", async ({ page }) => {
		await home(page);
		await page.locator('[data-node="m:studio/p:apparish"] .chev').click();
		await page.waitForTimeout(600);
		await shot(page, "02-tree-expanded");
	});

	test("session", async ({ page, request }) => {
		const id = await agentId(request, "name=apparish-auth");
		await home(page);
		await session(page, id);
		await shot(page, "03-session");
		const edit = page.locator(".ev.tool[data-tool='Edit']").last();
		await edit.scrollIntoViewIfNeeded();
		await edit.locator("button").first().click();
		await edit.locator(".diff").first().waitFor();
		await edit.evaluate((el) => el.scrollIntoView({ block: "center" }));
		await page.waitForTimeout(600);
		await shot(page, "03b-session-diff");
		const bash = page.locator(".ev.tool[data-tool='Bash']").last();
		if (await bash.count()) {
			await bash.evaluate((el) => el.scrollIntoView({ block: "center" }));
			await page.waitForTimeout(600);
			await shot(page, "03c-session-bash");
		}
	});

	test("approval", async ({ page, request }) => {
		const id = await agentId(request, "name=apparish-auth");
		await home(page);
		await page.goto(`/#/approval/${encodeURIComponent(id)}`);
		await page.locator(".prompt-inline .approval-card").first().waitFor();
		await page.waitForTimeout(1500);
		await shot(page, "04-approval");
	});

	test("machine scope", async ({ page }) => {
		await home(page);
		await page.goto("/#/n/m%3Astudio");
		await page.waitForTimeout(1500);
		await shot(page, "05-machine-scope");
	});

	test("needs you", async ({ page }) => {
		await home(page);
		await page.goto("/#/needs");
		await page.waitForTimeout(1200);
		await shot(page, "06-needs-you");
	});

	test("broadcast", async ({ page }) => {
		await home(page);
		await page.goto("/#/broadcast?s=*");
		await page.getByTestId("match-count").waitFor();
		await page.waitForTimeout(1500);
		await shot(page, "07-broadcast");
		// Narrowing it: the who panel, then a sentence with tokens.
		await page.getByRole("button", { name: "Narrow it down" }).click();
		await page.waitForTimeout(500);
		await shot(page, "07b-broadcast-who");
		await page
			.locator('.fchip[data-facet="harness"][data-value="claude"]')
			.click();
		await page.locator('.fchip[data-facet="machine"]').first().click();
		await page.keyboard.press("Escape");
		await page.waitForTimeout(1200);
		await shot(page, "07c-broadcast-sentence");
	});

	test("palette", async ({ page }) => {
		await home(page);
		// The boot guard's one automatic reload is spent: the inline Retry.
		await page.evaluate(() =>
			sessionStorage.setItem("pulsar:boot-retry", String(Date.now())),
		);
		await page.keyboard.press("ControlOrMeta+k");
		await page.waitForTimeout(600);
		await shot(page, "08-palette");
		await page.keyboard.type("auth");
		await page.waitForTimeout(900);
		await shot(page, "08b-palette-query");
	});

	test("settings", async ({ page }) => {
		await home(page);
		await page.getByRole("button", { name: "Settings" }).first().click();
		await page.waitForTimeout(1200);
		await shot(page, "10-settings");
	});

	test("qr", async ({ page }) => {
		await home(page);
		await page.getByRole("button", { name: /phone/i }).first().click();
		await page.waitForTimeout(1000);
		await shot(page, "11-qr");
	});

	test("help", async ({ page }) => {
		await home(page);
		await page.keyboard.press("?");
		await page.waitForTimeout(800);
		await shot(page, "12-help");
	});

	test("loading", async ({ page }) => {
		// Hold the tree's first page so the skeleton shows.
		await page.route("**/api/v1/tree**", () => {});
		await page.goto("/");
		await page.waitForTimeout(1200);
		await shot(page, "13-loading");
	});

	test("boot loading", async ({ page }) => {
		// Hold the app's entry module: the static boot shell stays up.
		await page.route("**/_app/index.astro_*.js", () => {});
		await page.goto("/", { waitUntil: "commit" });
		await page.locator(".boot-shell").waitFor();
		await page.waitForTimeout(600);
		await shot(page, "13c-boot");
		await page.locator("#boot-slow").waitFor({ timeout: 10_000 });
		await shot(page, "13d-boot-slow");
	});

	test("boot failed", async ({ page }) => {
		// The entry never downloads: one automatic reload, then the error screen.
		await page.route("**/_app/index.astro_*.js", (r) => r.abort("failed"));
		await page.goto("/");
		await page.locator("#boot-error").waitFor({ timeout: 15_000 });
		await page.waitForTimeout(400);
		await shot(page, "13e-boot-failed");
		await page.locator(".st-more summary").first().click();
		await page.waitForTimeout(300);
		await shot(page, "13e-boot-failed-open");
	});

	test("chunk loading", async ({ page }) => {
		// A route chunk still downloading: the route-level fallback.
		await page.route("**/_app/Screens.*.js", () => {});
		await page.goto("/#/needs");
		await page.locator(".st-wait").waitFor();
		await page.waitForTimeout(900);
		await shot(page, "13g-chunk-loading");
	});

	test("chunk failed, whole app", async ({ page }) => {
		await page.route("**/_app/DesktopApp.*.js", (r) => r.abort("failed"));
		await page.goto("/");
		await page.getByRole("alert").first().waitFor({ timeout: 15_000 });
		await page.waitForTimeout(600);
		await shot(page, "13h-app-chunk-failed");
	});

	test("chunk failed, layer", async ({ page }) => {
		await page.route("**/_app/Palette.*.js", (r) => r.abort("failed"));
		await home(page);
		// The boot guard's one automatic reload is spent: the inline Retry.
		await page.evaluate(() =>
			sessionStorage.setItem("pulsar:boot-retry", String(Date.now())),
		);
		await page.keyboard.press("ControlOrMeta+k");
		await page.getByRole("alert").first().waitFor({ timeout: 15_000 });
		await page.waitForTimeout(600);
		await shot(page, "13i-layer-chunk-failed");
	});

	test("chunk failed", async ({ page }) => {
		// A lazy route chunk fails in a running app: the inline Retry.
		await page.route("**/_app/Screens.*.js", (r) => r.abort("failed"));
		await page.goto("/#/needs");
		await page.getByRole("alert").first().waitFor({ timeout: 15_000 });
		await page.waitForTimeout(600);
		await shot(page, "13f-chunk-failed");
	});

	test("offline", async ({ page }) => {
		await page.route("**/api/v1/**", (r) => r.abort("internetdisconnected"));
		await page.goto("/");
		await page.locator("[data-failure=offline]").waitFor();
		await page.waitForTimeout(400);
		await shot(page, "14-offline");
	});

	test("daemon down", async ({ page }) => {
		await page.route("**/api/v1/**", (r) =>
			r.fulfill({ status: 502, body: "{}", contentType: "application/json" }),
		);
		await page.goto("/");
		await page.locator("[data-failure=daemon-down]").waitFor();
		await page.waitForTimeout(400);
		await shot(page, "14b-daemon-down");
		await page.locator(".st-more summary").first().click();
		await page.waitForTimeout(300);
		await shot(page, "14b-daemon-down-open");
	});

	test("offline, last known", async ({ page }) => {
		await home(page);
		await page.route("**/api/v1/**", (r) => r.abort("internetdisconnected"));
		await page.reload();
		await page.locator("[data-failure=offline]").waitFor();
		await page.waitForTimeout(400);
		await shot(page, "14c-offline-last-known");
	});

	test("filter, empty", async ({ page }) => {
		await home(page);
		await page.locator("#filter").fill("zzzz-nothing");
		await page.waitForTimeout(1200);
		await shot(page, "06c-filter-empty");
	});

	test("first run", async ({ page }) => {
		await page.route("**/api/v1/hello", (r) =>
			r.fulfill({
				json: {
					version: "2.0.0",
					machineId: "m1",
					machine: "studio",
					fedProtocol: [1, 1],
					features: ["tree", "facets", "send", "events"],
					you: { login: "you", node: "studio" },
					machines: 1,
					agents: 0,
					appUrl: "https://studio.example.ts.net/",
					firstRun: true,
				},
			}),
		);
		await page.goto("/");
		await page.locator(".first-run").waitFor();
		await page.waitForTimeout(400);
		await shot(page, "15-first-run");
	});

	test("needs you, empty", async ({ page }) => {
		await page.route("**/api/v1/attention**", (r) =>
			r.fulfill({ json: { items: [] } }),
		);
		await page.route("**/api/v1/events**", (r) => r.abort());
		await home(page);
		await page.goto("/#/needs");
		await page.waitForTimeout(1000);
		await shot(page, "06b-needs-you-empty");
	});

	test("stop confirm", async ({ page, request }) => {
		const res = await request.get(
			"/api/v1/agents?selector=status%3Dbusy&limit=100",
			{ headers: { "X-Pulsar": "1" } },
		);
		const items = (
			(await res.json()) as { items: { id: string; canStop: boolean }[] }
		).items;
		const busy = items.find((a) => a.canStop);
		if (!busy) return;
		await home(page);
		await session(page, busy.id);
		await page.getByRole("button", { name: "Stop", exact: true }).click();
		await page.waitForTimeout(500);
		await shot(page, "16-stop-confirm");
	});

	test("broadcast confirm and results", async ({ page }) => {
		await home(page);
		await page.goto(`/#/broadcast?s=${encodeURIComponent("project=billing")}`);
		await page.getByTestId("match-count").waitFor();
		await page.waitForTimeout(1200);
		await page
			.getByLabel("Broadcast message")
			.fill("rebase on main before pushing");
		await page.getByRole("button", { name: /^Send to \d/ }).click();
		await page
			.getByRole("alertdialog", { name: "Confirm broadcast" })
			.waitFor();
		await page.waitForTimeout(500);
		await shot(page, "17-broadcast-confirm");
		await page
			.getByRole("alertdialog", { name: "Confirm broadcast" })
			.getByRole("button", { name: /^Send to/ })
			.click();
		// Unproven: Prove Human asks first; send without proving.
		const prove = page.getByRole("dialog", { name: "Prove Human" });
		await prove.waitFor();
		await page.waitForTimeout(400);
		await shot(page, "17c-broadcast-prove");
		await prove.getByRole("button", { name: "Send without proving" }).click();
		await page.getByRole("dialog", { name: "Broadcast results" }).waitFor();
		await page.waitForTimeout(3500);
		await shot(page, "18-broadcast-results");
	});

	test("broadcast to everyone: one-click confirm", async ({ page }) => {
		await home(page);
		await page.goto("/#/broadcast?s=*");
		await page.getByTestId("match-count").waitFor();
		await page.waitForTimeout(1000);
		await page.getByLabel("Broadcast message").fill("main is frozen");
		await page.getByRole("button", { name: /^Send to \d/ }).click();
		await page
			.getByRole("alertdialog", { name: "Confirm broadcast" })
			.waitFor();
		await page.waitForTimeout(500);
		await shot(page, "17b-broadcast-everyone");
	});

	test("project scope and inline confirm", async ({ page }) => {
		await home(page);
		await page.goto(`/#/n/${encodeURIComponent("m:studio/p:apparish")}`);
		await page.locator(".scope h1").waitFor();
		await page.waitForTimeout(1200);
		await shot(page, "19-project-scope");
		await page
			.locator(".scope .composer-input")
			.fill("main is frozen until the release is tagged");
		await page.locator(".scope .send-btn").click();
		await page.locator(".confirm-inline").waitFor();
		await page.waitForTimeout(400);
		await shot(page, "19b-inline-confirm");
	});

	test("context menu", async ({ page }) => {
		await home(page);
		await page
			.locator('[data-node="m:studio"] .row-main')
			.click({ button: "right" });
		await page.waitForTimeout(400);
		await shot(page, "20-context-menu");
	});

	test("selection and the ids view", async ({ page }) => {
		await home(page);
		await page.locator('[data-node="m:studio/p:apparish"] .chev').click();
		await page.waitForTimeout(500);
		const agents = page.locator(".tree [data-agent]");
		await agents.nth(0).click({ modifiers: ["ControlOrMeta"] });
		await agents.nth(1).click({ modifiers: ["ControlOrMeta"] });
		await page.waitForTimeout(300);
		await shot(page, "21-selection");
		await page.getByRole("button", { name: /^Message/ }).click();
		await page.waitForTimeout(1200);
		await shot(page, "21b-ids-view");
	});

	test("palette, no match", async ({ page }) => {
		await home(page);
		// The boot guard's one automatic reload is spent: the inline Retry.
		await page.evaluate(() =>
			sessionStorage.setItem("pulsar:boot-retry", String(Date.now())),
		);
		await page.keyboard.press("ControlOrMeta+k");
		await page.keyboard.type("zzqqxx");
		await page.waitForTimeout(900);
		await shot(page, "08c-palette-empty");
	});

	test("settings, lower sections", async ({ page }) => {
		await home(page);
		await page.getByRole("button", { name: "Settings" }).first().click();
		await page.waitForTimeout(600);
		await page.getByRole("button", { name: "Machines" }).click();
		await page.waitForTimeout(800);
		await shot(page, "10b-settings-machines");
	});
	test("prove human", async ({ page, context, request, baseURL }) => {
		await resetPasskeys(request);
		// WebAuthn refuses IP addresses: the virtual authenticator needs localhost.
		await addAuthenticator(page, context);
		await page.goto(`${baseURL!.replace("127.0.0.1", "localhost")}/`);
		await page.locator('[data-node="m:studio"]').waitFor();
		await page.getByRole("button", { name: /^Prove Human/ }).click();
		const sheet = page.getByRole("dialog", { name: "Prove Human" });
		await sheet.waitFor();
		await page.waitForTimeout(500);
		await shot(page, "13-prove");
		await sheet.getByRole("button", { name: /^Prove with/ }).click();
		await sheet.getByText(/Proven as/).waitFor();
		await page.waitForTimeout(500);
		await shot(page, "13b-prove-done");
	});
	for (const kind of [
		"question",
		"question-long",
		"plan",
		"confirm",
		"select",
	] as const)
		test(`interaction card: ${kind}`, async ({ page, request }) => {
			const id = await agentId(request, "name=apparish-auth");
			const post = (data: object) =>
				request.post("/api/v1/__mock/realtime", {
					headers: { "X-Pulsar": "1" },
					data,
				});
			await post({ action: "interaction", id, kind });
			try {
				await home(page);
				await page.goto(`/#/approval/${encodeURIComponent(id)}`);
				await page.locator(".interaction-card").waitFor();
				await page.waitForTimeout(1200);
				await shot(page, `22-ix-${kind}`);
			} finally {
				await post({ action: "restore" });
			}
		});
	for (const tool of ["Edit", "Write"] as const)
		test(`approval card: ${tool}`, async ({ page, request }) => {
			const id = await agentId(request, "name=apparish-auth");
			const post = (data: object) =>
				request.post("/api/v1/__mock/realtime", {
					headers: { "X-Pulsar": "1" },
					data,
				});
			await post({ action: "needs-you", id, tool });
			try {
				await home(page);
				await page.goto(`/#/approval/${encodeURIComponent(id)}`);
				await page.locator(".prompt-inline .approval-card").first().waitFor();
				await page.waitForTimeout(1500);
				await shot(page, `23-approval-${tool.toLowerCase()}`);
			} finally {
				await post({ action: "restore" });
			}
		});
	test("prompt answered inline", async ({
		page,
		context,
		request,
		baseURL,
	}) => {
		await resetPasskeys(request);
		await addAuthenticator(page, context);
		const id = await agentId(request, "name=apparish-auth");
		const post = (data: object) =>
			request.post("/api/v1/__mock/realtime", {
				headers: { "X-Pulsar": "1" },
				data,
			});
		await post({ action: "interaction", id, kind: "confirm" });
		try {
			const base = baseURL!.replace("127.0.0.1", "localhost");
			await page.goto(`${base}/#/approval/${encodeURIComponent(id)}`);
			const card = page.locator(".prompt-inline .interaction-card");
			await card.waitFor();
			await card.getByRole("button", { name: /^Yes/ }).click();
			const prove = page.getByRole("dialog", { name: "Prove Human" });
			await prove.getByRole("button", { name: /^Prove with/ }).click();
			await page.locator(".prompt-outcome").waitFor();
			await page.waitForTimeout(800);
			await shot(page, "24-prompt-answered");
		} finally {
			await post({ action: "restore" });
		}
	});
	test("markdown table and thinking rows", async ({ page, request }) => {
		const id = await agentId(request, "name=codex@apparish");
		await home(page);
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const table = page.locator('[data-streamdown="table-wrapper"]').first();
		await table.waitFor();
		await table.evaluate((el) => el.scrollIntoView({ block: "center" }));
		await page.waitForTimeout(800);
		await shot(page, "25-markdown-table");
		const thought = page.locator(".ds-reason.is-hidden").first();
		if (await thought.count()) {
			await thought.evaluate((el) => el.scrollIntoView({ block: "center" }));
			await thought.locator(".ds-reason-info").click();
			await page.waitForTimeout(500);
			await shot(page, "25b-thinking");
		}
	});
});
