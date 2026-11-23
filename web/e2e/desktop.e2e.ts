import type { AgentsPage, Hello } from "../src/api/types.ts";
import { expectCleanCopy } from "./copy.ts";
import {
	agentId,
	expect,
	localhostBase,
	proveInSheet,
	ready,
	resetPasskeys,
	SHOTS,
	test,
	withPasskey,
} from "./fixtures.ts";

test.describe("desktop", () => {
	test("tree expands and collapses, and stays virtualized", async ({
		page,
	}) => {
		await ready(page);
		const studio = page.locator('[data-node="m:studio"]');
		// The local machine starts expanded; other machines start collapsed.
		await expect(studio).toHaveAttribute("aria-expanded", "true");
		const apparish = page.locator('[data-node="m:studio/p:apparish"]');
		await expect(apparish).toHaveAttribute("aria-expanded", "false");
		await expect(
			page.locator("[data-agent]", { hasText: "apparish-auth" }),
		).toHaveCount(0);

		await apparish.locator(".chev").click();
		await expect(apparish).toHaveAttribute("aria-expanded", "true");
		await expect(
			page.locator(".tree [data-agent]", { hasText: "apparish-auth" }),
		).toBeVisible();

		await apparish.locator(".chev").click();
		await expect(
			page.locator(".tree [data-agent]", { hasText: "apparish-auth" }),
		).toHaveCount(0);

		await studio.locator(".chev").click();
		await expect(studio).toHaveAttribute("aria-expanded", "false");
		await expect(apparish).toHaveCount(0);

		// 200 machines, ~3,000 agents: the DOM holds a window of rows.
		const mbpa = page.locator('[data-node="m:mbp-a"]');
		await page.locator(".tree-desktop").evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await page.waitForTimeout(300);
		const rows = await page.locator(".tree-desktop .vrow").count();
		expect(rows).toBeGreaterThan(10);
		expect(rows).toBeLessThanOrEqual(150);
		await page.locator(".tree-desktop").evaluate((el) => {
			el.scrollTop = 0;
		});
		await page.locator("#filter").fill("mbp-a");
		await expect(mbpa).toBeVisible();
		await mbpa.locator(".chev").click();
		await expect(
			page.locator('[data-node^="m:mbp-a/p:"]').first(),
		).toBeVisible();
	});

	test("agent session streams events, folds tools and thinking", async ({
		page,
	}) => {
		await ready(page);
		await page.locator('[data-node="m:studio/p:apparish"] .chev').click();
		await page
			.locator(".tree [data-agent]", { hasText: "apparish-auth" })
			.click();
		await expect(page.locator(".session-header h1")).toHaveText(
			"apparish-auth",
		);
		await expect(page.locator(".session-header")).toContainText("PR #1402");

		const events = page.locator(".transcript .ev");
		await expect(events.first()).toBeVisible();
		expect(await events.count()).toBeLessThanOrEqual(300);
		await expect(page.locator(".load-earlier")).toBeVisible();

		// New events stream in over SSE.
		const before = await page.locator(".transcript").textContent();
		await expect
			.poll(
				async () =>
					(await page.locator(".transcript").textContent()) !== before,
				{ timeout: 10_000 },
			)
			.toBe(true);
		expect(await events.count()).toBeLessThanOrEqual(300);

		// Reasoning starts collapsed; tools are one line until expanded.
		await expect(page.locator(".ev.thinking").first()).toHaveAttribute(
			"data-state",
			"closed",
		);
		// An Edit whose call is loaded (the first on screen may be a result whose
		// call sits on an older page).
		const edit = page
			.locator('.ev.tool[data-tool="Edit"]', { hasText: /\.ts/ })
			.first();
		await edit.scrollIntoViewIfNeeded();
		await expect(edit.locator(".tool-summary")).toHaveText(/\+\d+ [-−]\d+/);
		await edit.locator("button").first().click();
		await expect(edit.locator(".diff .add").first()).toBeVisible();
		await expect(edit.locator(".diff .del").first()).toBeVisible();
		// Peer messages carry the violet rule and who sent them.
		await expect(page.locator(".ev.peer").first()).toContainText(
			"from codex@apparish",
		);
		// Assistant turns have a Copy button that shows on hover, and the
		// right-click menu offers the same.
		// New turns keep streaming in (every 700 ms in the mock) and the view
		// follows them, so the newest turn can change, or scroll out from
		// under a mouse that hasn't moved: hover again on each check.
		const turn = page.locator(".ds-turn--assistant").last();
		const copy = turn.getByRole("button", { name: "Copy message" });
		await expect(copy).toBeAttached();
		await expect
			.poll(async () => {
				await turn.hover();
				return copy.evaluate((b) => getComputedStyle(b.parentElement!).opacity);
			})
			.toBe("1");
		await expect(copy).toBeVisible();
		await turn.click({ button: "right", position: { x: 40, y: 10 } });
		await expect(
			page.getByRole("menuitem", { name: "Copy message" }),
		).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("menuitem", { name: "Copy message" }),
		).toHaveCount(0);
		await page.screenshot({ path: `${SHOTS}desktop-session.png` });
	});

	test("rich content: highlighted code, mermaid, math, table, images", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const reply = page
			.locator(".ev.msg", { hasText: "The refresh path races" })
			.first();
		await reply.scrollIntoViewIfNeeded();
		// Shiki tokens carry colors.
		await expect(
			reply.locator("pre span[style*='--sdm-c']").first(),
		).toBeVisible({ timeout: 15_000 });
		// Mermaid renders an SVG (its <style> moved to CSSOM for the CSP).
		// Diagrams render once on screen: bring the first one into view.
		await reply
			.locator('[data-streamdown="mermaid-block"]')
			.first()
			.scrollIntoViewIfNeeded();
		await expect(
			reply.locator("svg[aria-roledescription='sequence']"),
		).toBeVisible({ timeout: 15_000 });
		await expect(
			reply.locator("svg[aria-roledescription='sequence'] style"),
		).toHaveCount(0);
		await reply
			.locator('[data-streamdown="mermaid-block"]')
			.nth(1)
			.scrollIntoViewIfNeeded();
		await expect(
			reply.locator("svg[aria-roledescription='flowchart-v2']"),
		).toBeVisible({ timeout: 15_000 });
		// A pie chart (Langium-parsed diagrams load too); an unknown fence
		// language shows as plain text.
		await reply
			.locator('[data-streamdown="mermaid-block"]')
			.nth(2)
			.scrollIntoViewIfNeeded();
		await expect(reply.locator("svg[aria-roledescription='pie']")).toBeVisible({
			timeout: 15_000,
		});
		// Diagrams render when scrolled into view; the mindmap uses cytoscape.
		await page.getByText("And a language Shiki").scrollIntoViewIfNeeded();
		await expect(
			reply.locator("svg[aria-roledescription='mindmap']"),
		).toBeVisible({ timeout: 15_000 });
		await expect(reply).toContainText("IDENTIFICATION DIVISION.");
		// Single-dollar math renders; prices stay text.
		const inline = reply.locator("p", { hasText: "the retry count grows" });
		await expect(inline.locator(".katex")).toHaveCount(1, { timeout: 10_000 });
		await expect(inline).toContainText("costs $5 and $6 per seat");
		// KaTeX and the GFM table.
		await expect(reply.locator(".katex").first()).toBeVisible({
			timeout: 10_000,
		});
		await expect(reply.locator("table")).toContainText(
			"10 concurrent requests",
		);
		// Images: fetched with X-Pulsar into blob: URLs; the [image] placeholder is hidden.
		const userImage = page.locator(".r-user img.transcript-image").first();
		await userImage.scrollIntoViewIfNeeded();
		await expect(userImage).toHaveAttribute("src", /^blob:/);
		expect(
			await userImage.evaluate((img: HTMLImageElement) => img.naturalWidth),
		).toBe(320);
		const toolImage = page.locator(".tool-images img.transcript-image").last();
		await expect(toolImage).toHaveAttribute("src", /^blob:/);
		await expect(page.locator(".transcript")).not.toContainText("[image]");
		await reply.scrollIntoViewIfNeeded();
		await page.screenshot({ path: `${SHOTS}desktop-rich.png` });
	});
	test("stop: confirm, Face ID once, interrupt, toast; hidden when the agent can't be stopped", async ({
		page,
		request,
		context,
	}) => {
		const list = async (selector: string) =>
			(
				(await (
					await request.get(
						`/api/v1/agents?selector=${encodeURIComponent(selector)}&limit=500&sort=name`,
						{ headers: { "X-Pulsar": "1" } },
					)
				).json()) as AgentsPage
			).items;
		const busy = (await list("status=busy")).find(
			(a) => a.canStop && !a.name.startsWith("apparish"),
		)!;
		// Stop needs a passkey session (one Face ID / Touch ID).
		await page.goto(`${localhostBase()}/`);
		await withPasskey(page, request, context);
		await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(busy.id)}`);
		await expect(page.locator(".session-header h1")).toHaveText(busy.name);
		// ⌘. asks first; Cancel leaves the agent alone.
		await page.keyboard.press("ControlOrMeta+.");
		const confirm = page.getByRole("alertdialog", { name: "Confirm stop" });
		await expect(confirm).toBeVisible();
		await confirm.getByRole("button", { name: "Cancel" }).click();
		await expect(confirm).toHaveCount(0);
		await page.getByRole("button", { name: "Stop", exact: true }).click();
		await confirm.getByRole("button", { name: "Stop this turn" }).click();
		// Not proven yet: Prove Human opens, then the Stop goes through by itself.
		await proveInSheet(page);
		await expect(page.locator(".toast")).toHaveText(
			`Stopped ${busy.name}'s turn`,
		);
		// Again: nothing is running now.
		await page.getByRole("button", { name: "Stop", exact: true }).click();
		await confirm.getByRole("button", { name: "Stop this turn" }).click();
		await expect(page.locator(".toast")).toHaveText(
			`${busy.name} wasn't running a turn`,
		);
		// No Stop for an agent the daemon can't reach (a Claude session outside tmux).
		const cant = (await list("harness=claude status=busy")).find(
			(a) => !a.canStop,
		)!;
		await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(cant.id)}`);
		await expect(page.locator(".session-header h1")).toHaveText(cant.name);
		await expect(
			page.getByRole("button", { name: "Stop", exact: true }),
		).toHaveCount(0);
	});

	test("Stop… from the row menu asks to confirm on a fresh load", async ({
		page,
		request,
	}) => {
		const res = await request.get(
			`/api/v1/agents?selector=${encodeURIComponent("machine=studio project=apparish status=busy")}&limit=50&sort=name`,
			{ headers: { "X-Pulsar": "1" } },
		);
		const busy = ((await res.json()) as AgentsPage).items.find(
			(a) => a.canStop,
		)!;
		// Home first: the session chunk has not loaded yet.
		await ready(page);
		await page.locator('[data-node="m:studio/p:apparish"] .chev').click();
		await page
			.locator(".tree [data-agent]", { hasText: busy.name })
			.first()
			.click({ button: "right" });
		await page.getByRole("menuitem", { name: "Stop…" }).click();
		await expect(
			page.getByRole("alertdialog", { name: "Confirm stop" }),
		).toBeVisible();
	});

	test("the palette has no Ask mode; an old #/ask link lands on Home", async ({
		page,
	}) => {
		await ready(page);
		await page.keyboard.press("ControlOrMeta+K");
		const search = page.getByLabel("Search", { exact: true });
		await expect(search).toBeFocused();
		await expect(page.getByRole("radiogroup", { name: "Mode" })).toHaveCount(0);
		await expect(page.getByText("Ask who works on something")).toHaveCount(0);
		// "?" and Tab no longer switch modes: the input stays a search.
		await search.fill("?studio");
		await expect(search).toHaveValue("?studio");
		await search.press("Tab");
		await expect(page.getByLabel("Ask", { exact: true })).toHaveCount(0);
		await page.keyboard.press("Escape");
		await page.goto("/#/ask");
		await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
		await expect(
			page.getByRole("navigation", { name: "Main" }).getByRole("button", {
				name: "Home",
			}),
		).toHaveAttribute("aria-current", "page");
	});

	test("message an agent and see receipts", async ({ page }) => {
		await ready(page);
		await page.locator('[data-node="m:studio/p:apparish"] .chev').click();
		await page
			.locator(".tree [data-agent]", { hasText: "codex@apparish" })
			.first()
			.click();
		await expect(page.locator(".composer-to")).toContainText("on studio");
		await page.getByRole("radio", { name: "Interrupt now" }).click();
		await page.locator(".composer-input").fill("hold refresh() for 10 minutes");
		await page.keyboard.press("ControlOrMeta+Enter");
		// The delivery state sits under the sent bubble, not under the composer.
		await expect(page.locator(".ds-delivery").last()).toHaveText(
			/Sent|Delivered|Read|Replied/,
			{ timeout: 8000 },
		);
		await expect(page.locator(".receipt-line")).toHaveCount(0);
	});

	test("a draft stays with its agent: another agent opens an empty composer", async ({
		page,
	}) => {
		await ready(page);
		await page.locator('[data-node="m:studio/p:apparish"] .chev').click();
		const row = (name: string) =>
			page.locator(".tree [data-agent]", { hasText: name }).first();
		await row("codex@apparish").click();
		await expect(page.locator(".composer-to")).toContainText("codex@apparish");
		await page.locator(".composer-input").fill("for codex only");
		await row("omp@apparish").click();
		await expect(page.locator(".composer-to")).toContainText("omp@apparish");
		await expect(page.locator(".composer-input")).toHaveValue("");
		await expect(page.locator(".send-btn")).toBeDisabled();
	});

	test("pasting text that comes with a file keeps the text", async ({
		page,
	}) => {
		await ready(page);
		await page.locator('[data-node="m:studio/p:apparish"] .chev').click();
		await page
			.locator(".tree [data-agent]", { hasText: "codex@apparish" })
			.first()
			.click();
		// Excel, Numbers and Word copy text plus an image: the paste must not
		// be cancelled (a synthetic paste inserts nothing, so check that).
		const cancelled = await page.locator(".composer-input").evaluate((el) => {
			const dt = new DataTransfer();
			dt.setData("text/plain", "hello");
			dt.items.add(new File(["x"], "cell.png", { type: "image/png" }));
			const e = new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
				cancelable: true,
			});
			el.dispatchEvent(e);
			return e.defaultPrevented;
		});
		expect(cancelled).toBe(false);
	});

	test("machine and project rows open a scoped composer", async ({ page }) => {
		await ready(page);
		await page.locator('[data-node="m:studio"] .row-main').click();
		await expect(page.locator(".scope h1")).toHaveText("Everyone on studio");
		await expect(page.locator(".selector-line")).toHaveText("machine=studio");
		await expect(page.locator(".scope .pane-title")).toContainText(
			"43 agents on 1 machine",
		);

		await page.locator('[data-node="m:studio/p:apparish"] .row-main').click();
		await expect(page.locator(".scope h1")).toHaveText(
			"Everyone in apparish on studio",
		);
		await expect(page.locator(".selector-line")).toHaveText(
			"machine=studio project=apparish",
		);
		// A draft survives a scope change.
		await page.locator(".scope .composer-input").fill("draft");
		await page.getByRole("radio", { name: /On all \d+ machines/ }).click();
		await expect(page.locator(".selector-line")).toHaveText("project=apparish");
		await page.getByRole("radio", { name: "on studio" }).click();
		await expect(page.locator(".scope .composer-input")).toHaveValue("draft");

		// 8 agents on one machine: inline confirmation, then receipts.
		await page
			.locator(".scope .composer-input")
			.fill("main is frozen until the release is tagged");
		await page.locator(".scope .send-btn").click();
		await expect(page.locator(".confirm-inline")).toContainText(
			"Send to 8 agents on studio?",
		);
		await page.screenshot({ path: `${SHOTS}desktop-scope.png` });
		await page.getByRole("button", { name: "Confirm send to 8" }).click();
		await expect(page.locator(".receipts .receipt-summary")).toContainText(
			"delivered",
			{ timeout: 8000 },
		);
	});

	test("broadcast builder: the sentence, facets, the audience map, confirm, results", async ({
		page,
		request,
	}) => {
		const facet = await request.get(
			"/api/v1/facets?selector=project%3Dapparish&facet=machine&top=1",
			{ headers: { "X-Pulsar": "1" } },
		);
		const other = ((await facet.json()) as { values: { value: string }[] })
			.values[0]!.value;
		await ready(page);
		await page.locator(".broadcast-btn").click();
		const count = page.getByTestId("match-count");
		await expect(count).toHaveText(/^3,\d{3} agents on 200 machines$/);
		const sentence = page.locator(".bc-sentence");
		await expect(sentence).toHaveText(/^Send to everyone/);
		// At 200 machines the map shows the busiest and folds the rest.
		await expect(page.locator(".bc-card:not(.is-more)")).toHaveCount(8);
		await expect(page.locator(".bc-card.is-more")).toContainText(
			"192 more machines",
		);
		// The exact selector is one click away.
		await expect(page.locator(".bc-sel code")).toHaveText("*");
		await page.getByRole("button", { name: "Edit selector" }).click();
		await expect(page.getByLabel("Selector")).toHaveValue("*");
		await page.getByRole("button", { name: "Done" }).click();

		// Narrow it down: the who panel's facets build the sentence.
		await page.getByRole("button", { name: "Narrow it down" }).click();
		await page
			.locator('.fchip[data-facet="project"][data-value="apparish"]')
			.click();
		await expect(sentence).toContainText("all agents in apparish");
		await expect(count).not.toHaveText(/3,\d{3}/);
		// studio isn't in the top 8 machines for apparish: search within the facet.
		await page.getByLabel("Search machine").fill("stud");
		await page
			.locator('.fchip[data-facet="machine"][data-value="studio"]')
			.click();
		await expect(count).toHaveText("8 agents on 1 machine");
		await expect(sentence).toContainText("in apparish on studio");
		await page.getByLabel("Search machine").fill("");
		await page.keyboard.press("Escape");
		await expect(page.locator("#bc-who")).toHaveCount(0);
		// Escape closed the panel, not the broadcast.
		await expect(count).toBeVisible();

		// The selector round-trips: typing one rebuilds the sentence.
		await page.getByRole("button", { name: "Edit selector" }).click();
		await page
			.getByLabel("Selector")
			.fill(`project=apparish machine=studio|${other}`);
		await expect(sentence).toContainText(`on studio or ${other}`);
		await expect(count).toHaveText(/on 2 machines/);
		await expect(page.getByTestId("validity")).toHaveText(/Valid, \d+/);
		await page.getByLabel("Selector").blur();
		// A token removes its part of the audience.
		await page.getByRole("button", { name: "Remove machine" }).click();
		await expect(sentence).not.toContainText("on studio");
		await page
			.getByLabel("Selector")
			.fill(`project=apparish machine=studio|${other}`);
		await expect(count).toHaveText(/on 2 machines/);

		// The map marks what a send does; "Don't wake" is the builder default.
		await expect(
			page.getByRole("radio", { name: "Don't wake" }),
		).toHaveAttribute("aria-checked", "true");
		await expect(page.locator(".bc-card .bc-face").first()).toBeVisible();
		await expect(page.locator(".bc-aud-head .bc-legend")).toContainText(
			"to inbox",
		);
		await page.getByRole("radio", { name: "Next turn" }).click();
		await expect(page.locator(".bc-hint")).toContainText("wakes idle agents");
		await page.getByRole("radio", { name: "Don't wake" }).click();
		await page.screenshot({ path: `${SHOTS}desktop-builder.png` });

		// Send with nothing written: it says so and focuses the message.
		await page.getByRole("button", { name: /^Send to \d+/ }).click();
		await expect(page.locator(".bc-error")).toHaveText(
			"Write a message first.",
		);
		await expect(page.getByLabel("Broadcast message")).toBeFocused();

		await page
			.getByLabel("Broadcast message")
			.fill("rebase on main before pushing");
		await page.getByRole("button", { name: /^Send to \d+/ }).click();
		const dialog = page.getByRole("alertdialog", { name: "Confirm broadcast" });
		await expect(dialog).toContainText("on 2 machines");
		await expect(dialog.locator(".breakdown")).toContainText("studio");
		await dialog.getByRole("button", { name: /^Send to/ }).click();
		await expect(
			page.getByRole("dialog", { name: "Broadcast results" }),
		).toBeVisible();
		// The results board: the same map, avatars lighting up per receipt.
		await expect(page.locator(".bc-results .bc-face").first()).toBeVisible();
		await expect(
			page.locator('.bc-results .bc-face:not([data-state="queued"])').first(),
		).toBeVisible({ timeout: 8000 });
		await expect(page.locator(".receipt-summary")).toContainText("delivered", {
			timeout: 8000,
		});
		await expect(page.locator(".replies li").first()).toBeVisible({
			timeout: 15_000,
		});
		await page.screenshot({ path: `${SHOTS}desktop-results.png` });
	});

	test("broadcast from the keyboard: open, write, send; nothing matches; reduced motion", async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await ready(page);
		await page.keyboard.press("ControlOrMeta+Shift+B");
		const body = page.getByLabel("Broadcast message");
		// The message field has focus: write and send without the mouse. (The
		// builder's chunk loads on first open: slow machines.)
		await expect(body).toBeFocused({ timeout: 15_000 });
		await page.keyboard.type("main is frozen");
		await page.keyboard.press("ControlOrMeta+Enter");
		const dialog = page.getByRole("alertdialog", { name: "Confirm broadcast" });
		await expect(dialog).toContainText("This is everyone in the pool.");
		await dialog.getByRole("button", { name: "Cancel" }).click();
		// Motion follows the setting: the map's cards don't animate in.
		const dur = await page
			.locator(".bc-card")
			.first()
			.evaluate((el) => getComputedStyle(el).animationDuration);
		expect(dur).toBe("0s");
		// Nothing matches: the map says so and Send is off.
		await page.getByRole("button", { name: "Edit selector" }).click();
		await page.getByLabel("Selector").fill("machine=no-such-machine");
		await expect(page.getByTestId("match-count")).toHaveText(
			"0 agents on 0 machines",
		);
		await expect(page.locator(".bc-empty")).toContainText("No agents match");
		await expect(page.getByRole("button", { name: /^Send to/ })).toBeDisabled();
	});

	test("everyone confirms in one click, with the breakdown (no type-the-count)", async ({
		page,
	}) => {
		await ready(page);
		await page.keyboard.press("ControlOrMeta+Shift+B");
		await expect(page.getByTestId("match-count")).toHaveText(/^3,\d{3} agents/);
		await page.getByLabel("Broadcast message").fill("main is frozen");
		await page.getByRole("button", { name: /^Send to \d/ }).click();
		const dialog = page.getByRole("alertdialog", { name: "Confirm broadcast" });
		await expect(dialog).toContainText("This is everyone in the pool.");
		await expect(dialog.locator(".breakdown tr").first()).toBeVisible();
		await expect(dialog.getByRole("textbox")).toHaveCount(0);
		await expect(
			dialog.getByRole("button", { name: /^Send to/ }),
		).toBeEnabled();
		await dialog.getByRole("button", { name: "Cancel" }).click();
	});

	test("hostile markdown, HTML, links and images render inert", async ({
		page,
		request,
		errors,
	}) => {
		const id = await agentId(request, "fixture=xss");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await expect(page.locator(".transcript .ev").first()).toBeVisible();
		for (const head of await page
			.locator(".transcript .ev.tool button[data-state]")
			.all())
			await head.click();
		const t = page.locator(".transcript");
		await expect(t).toContainText("please render me as text");
		await expect(t).toContainText("peer says hi");
		await expect(t).toContainText('<svg onload="window.__xss=18"></svg>');
		await expect(page.locator(".session-header h1")).toHaveText(
			'xss<img src=x onerror="window.__xss=1">',
		);
		// Sanitized: no scripts, frames, styles, forms or event handlers.
		expect(
			await t
				.locator("script, iframe, style, form, marquee, svg[onload]")
				.count(),
		).toBe(0);
		expect(
			await page
				.locator("[onerror], [onload], [onclick], [onmouseover]")
				.count(),
		).toBe(0);
		// http(s) links render as real links: new tab, no opener, no referrer.
		const spec = t.getByRole("link", { name: "the spec" });
		await expect(spec).toHaveAttribute("href", "https://example.com/spec?x=1");
		await expect(spec).toHaveAttribute("target", "_blank");
		await expect(spec).toHaveAttribute("rel", "noopener noreferrer");
		await expect(t).not.toContainText("the spec [blocked]");
		// File paths are file references, never links into the app's origin.
		expect(
			await t
				.locator(
					'a[href*="/Users/"], a[href*="notes.md"], a[href^="file:"], a[href="#usage"]',
				)
				.count(),
		).toBe(0);
		const ref = t.getByRole("button", { name: "compare page" });
		await expect(ref).toHaveAttribute(
			"title",
			"Copy /Users/me/demo/.qa/compare.html",
		);
		await expect(t.getByRole("button", { name: "a file url" })).toHaveAttribute(
			"title",
			"Copy /tmp/a b.txt",
		);
		await expect(t.getByText("a section", { exact: true })).toBeVisible();
		await page.evaluate(() => {
			(window as { __copied?: string }).__copied = "";
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async (s: string) => {
						(window as { __copied?: string }).__copied = s;
					},
				},
			});
		});
		const before = page.url();
		await ref.click();
		await expect(page.getByText("Path copied")).toBeVisible();
		expect(
			await page.evaluate(() => (window as { __copied?: string }).__copied),
		).toBe("/Users/me/demo/.qa/compare.html");
		expect(page.url()).toBe(before);
		// Links only to http(s)/mailto.
		expect(
			await page
				.locator('a[href^="javascript"], a[href^="data:"], a[href^="vbscript"]')
				.count(),
		).toBe(0);
		// No tracking pixels: images load only from this origin's API, blob: or data:.
		expect(await page.locator('img[src*="evil.example"]').count()).toBe(0);
		expect(
			await t
				.locator("img")
				.evaluateAll(
					(imgs) =>
						imgs.filter(
							(i) =>
								!/^(blob:|data:image\/)/.test(
									(i as HTMLImageElement).getAttribute("src") ?? "",
								),
						).length,
				),
		).toBe(0);
		await expect(t).toContainText("[Image blocked: px]");
		// A disallowed image type shows a placeholder.
		await expect(
			t.getByRole("img", { name: "Image unavailable" }).first(),
		).toBeVisible();
		// Markdown still renders.
		await expect(
			t.locator('[data-streamdown="strong"]', { hasText: "bold" }).first(),
		).toBeVisible();
		expect(
			await page.evaluate(
				() => (window as unknown as { __xss?: number }).__xss,
			),
		).toBeUndefined();
		// The 415 for the disallowed image logs a failed load; that's expected here.
		errors.splice(
			0,
			errors.length,
			...errors.filter((e) => !/status of 415/.test(e)),
		);
	});
	test("approval card shows exact arguments and decides with a passkey", async ({
		page,
		request,
		context,
	}) => {
		await resetPasskeys(request);
		// A virtual platform authenticator stands in for Touch ID.
		const cdp = await context.newCDPSession(page);
		await cdp.send("WebAuthn.enable");
		const { authenticatorId } = await cdp.send(
			"WebAuthn.addVirtualAuthenticator",
			{
				options: {
					protocol: "ctap2",
					transport: "internal",
					hasUserVerification: true,
					isUserVerified: true,
					hasResidentKey: true,
				},
			},
		);
		const id = await agentId(request, "name=apparish-auth");
		// WebAuthn needs a host name, not an IP: the relying party is `localhost`.
		const base = test
			.info()
			.project.use.baseURL!.replace("127.0.0.1", "localhost");
		await page.goto(`${base}/#/approval/${encodeURIComponent(id)}`);
		const card = page.locator(".approval-card");
		await expect(card).toContainText("apparish-auth on studio wants to run");
		await expect(
			card.locator(".mk-ctl", { hasText: "<U+202E>" }),
		).toBeVisible();
		await expect(
			card.locator(".mk-ctl", { hasText: "<U+200B>" }),
		).toBeVisible();
		// Bash: the description leads, the command is highlighted, and the
		// markers above sit inside the highlighted command.
		await expect(card.locator(".ds-ap-lead")).toContainText(
			"Clean and rebuild",
		);
		await expect(
			card.locator(".ds-ap-code .mk-ctl", { hasText: "<U+202E>" }),
		).toBeVisible();
		await expect(card.locator(".ds-ap-code")).toContainText("bun build");
		// The project, not the full path; the path and input hash on hover.
		await expect(card.locator(".ds-ap-meta")).toContainText("apparish");
		await expect(
			card.locator('[title^="Input sha256:9f2c41d07ab3e85c"]'),
		).toHaveCount(1);
		await expect(card.locator(".countdown")).toHaveText(/Expires \d+:\d\d/);
		await expect(card.locator(".session-rules")).toHaveText(
			// Rules render exactly, like arguments (spaces as ·).
			"For session: Bash(bun·build·*)",
		);
		// No passkey yet: Prove Human opens inline; one passkey check makes one
		// here (no code, any device of the operator's), then the answer goes on.
		await card
			.getByRole("button", { name: /^Allow once( · Face ID)?$/ })
			.click();
		const prove = page.getByRole("dialog", { name: "Prove Human" });
		await expect(prove).toContainText("To answer this prompt");
		await expect(prove).toContainText("Windows Hello");
		await expect(prove).not.toContainText("pulsar passkeys add");
		await prove.getByRole("button", { name: "Prove with passkey" }).click();
		// The sheet closes and the answer goes on by itself (no second click).
		await expect(prove).toHaveCount(0);
		// Every open tab hears about the new passkey.
		await expect(page.locator(".toast")).toContainText("New passkey");
		// Proving started the session: the answer went with it (one check in all).
		await expect(page.locator(".prompt-outcome")).toContainText(
			/Allowed once by You · passkey session on Mac \(studio\) · \d/,
		);
		// The passkey was made on this authenticator, with user verification.
		const { credentials } = await cdp.send("WebAuthn.getCredentials", {
			authenticatorId,
		});
		expect(credentials.length).toBe(1);
		expect(credentials[0]!.rpId).toBe("localhost");

		// The card is inline: Settings opens over the session.
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		let settings = page.getByRole("dialog", { name: "Settings" });
		await expect(settings.locator("#set-keys ~ ul li")).toHaveCount(1);
		// Registering proved presence: this browser is signed in already.
		await expect(settings.locator("#set-sessions ~ ul li")).toContainText(
			"on studio",
		);
		// A reload forgets the proof on a computer. Removing a device then opens
		// Prove Human, and the removal goes on by itself; it's announced too.
		await page.reload();
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		settings = page.getByRole("dialog", { name: "Settings" });
		await settings.getByRole("button", { name: /^Remove passkey/ }).click();
		await settings
			.getByRole("button", { name: /^Confirm: remove passkey/ })
			.click();
		await expect(
			page.getByRole("dialog", { name: "Prove Human" }),
		).toContainText("To remove a device");
		await proveInSheet(page);
		await expect(page.locator(".toast")).toContainText("removed");
		await expect(settings).toContainText("No device has proven you're human");
	});

	test("keyboard: help, palette, j/k and Enter", async ({ page }) => {
		await ready(page);
		const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
		await page.keyboard.press("?");
		await expect(help).toBeVisible();
		await page.keyboard.press("Escape");
		await page.keyboard.press("ControlOrMeta+k");
		await page
			.getByRole("dialog", { name: "Search the pool" })
			.getByLabel("Search")
			.fill("mbp");
		await expect(page.locator(".palette-list .row").first()).toBeVisible();
		// Enter that confirms an IME conversion opens nothing.
		await page
			.getByRole("dialog", { name: "Search the pool" })
			.getByLabel("Search")
			.dispatchEvent("keydown", { key: "Enter", isComposing: true });
		await expect(
			page.getByRole("dialog", { name: "Search the pool" }),
		).toBeVisible();
		await page.keyboard.press("Escape");
		await page.keyboard.press("j");
		await expect(page.locator(".tree .focused")).toHaveCount(1);
		await page.keyboard.press("Enter");
		await expect(
			page.locator(".session-header h1, .scope h1").first(),
		).toBeVisible();
		await page.keyboard.press("n");
		await expect(page.locator(".session-header h1")).toBeVisible();
	});

	test("keys pressed before the shortcuts load are not lost", async ({
		page,
	}) => {
		// Hold the shortcuts' chunk: the tree paints first (from the last-screen
		// snapshot), and a key pressed then used to land on nothing.
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		await page.route(/\/_app\/desktopKeys\.[^/]+\.js$/, async (route) => {
			await held;
			await route.continue();
		});
		await page.goto("/");
		await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
		await page.keyboard.press("j");
		await page.keyboard.press("ControlOrMeta+Shift+B");
		// Not loaded yet: nothing happened.
		await expect(page.locator(".tree .focused")).toHaveCount(0);
		await expect(page).not.toHaveURL(/#\/broadcast/);
		release();
		// Once loaded, both keys are handled, in order.
		await expect(page.locator(".tree .focused")).toHaveCount(1);
		await expect(page).toHaveURL(/#\/broadcast/);
		await expect(page.getByTestId("match-count")).toHaveText(/^3,\d{3} agents/);
	});

	test("tree keys leave a focused button alone; Escape closes the row menu", async ({
		page,
	}) => {
		await ready(page);
		await page.keyboard.press("j");
		await expect(page.locator(".tree .focused")).toHaveCount(1);
		const url = page.url();
		// Enter on a focused button presses that button, and only that.
		await page.getByRole("button", { name: "Settings", exact: true }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
		await page.keyboard.press("Escape");
		expect(page.url()).toBe(url);

		await page.locator('[data-node="m:studio"]').click({ button: "right" });
		await expect(page.locator(".context-menu")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.locator(".context-menu")).toHaveCount(0);
	});

	test("Escape closes a dialog without leaving the session; shortcuts wait behind it", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await expect(page.locator(".session-header h1")).toHaveText(
			"apparish-auth",
		);
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = page.getByRole("dialog", { name: "Settings" });
		await expect(settings).toBeVisible();
		// "?" and "n" do nothing while a dialog is open.
		await page.keyboard.press("?");
		await page.keyboard.press("n");
		await expect(
			page.getByRole("dialog", { name: "Keyboard shortcuts" }),
		).toHaveCount(0);
		await page.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);
		await expect(page).toHaveURL(new RegExp(`#/a/${encodeURIComponent(id)}$`));
		await expect(page.locator(".session-header h1")).toHaveText(
			"apparish-auth",
		);
	});

	test("an approval link opens the session at its inline card, focused (no dialog)", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/approval/${encodeURIComponent(id)}`);
		const card = page.locator(".prompt-inline .approval-card");
		await expect(card).toBeInViewport();
		await expect(page.locator(".session-header h1")).toHaveText(
			"apparish-auth",
		);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		// The first control has focus (here: the only enabled one is in the card).
		await expect
			.poll(() =>
				page.evaluate(
					() => !!document.activeElement?.closest(".prompt-inline"),
				),
			)
			.toBe(true);
	});

	test("the session header links the repo, branch and PR out; plain text without a remote", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const meta = page.locator(".session-header .d-sh-meta");
		const repo = "https://github.com/acme/apparish";
		const links = [
			["PR #1402", `${repo}/pull/1402`],
			["fix-1378", `${repo}/tree/fix-1378`],
			["apparish", repo],
		] as const;
		for (const [name, href] of links) {
			const a = meta.getByRole("link", { name, exact: true });
			await expect(a).toHaveAttribute("href", href);
			await expect(a).toHaveAttribute("target", "_blank");
			await expect(a).toHaveAttribute("rel", "noopener noreferrer");
		}
		// Calm until hovered: header color, no underline.
		const pr = meta.getByRole("link", { name: "PR #1402" });
		await expect(pr).toHaveCSS("text-decoration-line", "none");
		await expect(pr).toHaveCSS("cursor", "pointer");
		await pr.hover();
		await expect(pr).toHaveCSS("text-decoration-line", "underline");
		// Keyboard reaches it.
		await pr.focus();
		await expect(pr).toBeFocused();

		// The agent's own PRs in its prose link out too; code stays as written.
		const prose = page.locator(".transcript .ds-prose", { hasText: "#1402" });
		await expect(
			prose.first().getByRole("link", { name: "#1402" }).first(),
		).toHaveAttribute("href", `${repo}/pull/1402`);
		await expect(
			prose.first().locator("code", { hasText: "#1402" }).locator("a"),
		).toHaveCount(0);

		// No remote (the mock's ember projects have none): the same line, as text.
		const bare = await agentId(request, "project=ember");
		await page.goto(`/#/a/${encodeURIComponent(bare)}`);
		await expect(meta).toContainText("ember");
		await expect(meta.getByRole("link")).toHaveCount(0);
	});

	test("open on phone shows a QR code", async ({ page }) => {
		await ready(page);
		await page.getByRole("button", { name: "Open on phone" }).click();
		const modal = page.getByRole("dialog", { name: "Open on phone" });
		await expect(modal.locator("svg.qr path")).toHaveAttribute("d", /M\d/);
		await expect(modal).toContainText("https://studio.tail1234.ts.net:7337/");
	});

	test("one tree, machines → projects: no grouping switcher, filter finds projects", async ({
		page,
	}) => {
		await ready(page);
		await expect(
			page.getByRole("radiogroup", { name: "Group by" }),
		).toHaveCount(0);
		await expect(page.getByRole("radio", { name: "Projects" })).toHaveCount(0);
		// The section header takes the switcher's row: same height, no gap.
		const head = page.locator(".d-section", { hasText: /^Machines$/ });
		await expect(head).toBeVisible();
		await page.locator("#filter").fill("apparish");
		await expect(
			page.locator('[data-node="m:studio/p:apparish"]'),
		).toBeVisible();
	});

	test("failure screens: off tailnet, daemon down, wrong account, first run", async ({
		page,
		errors,
	}) => {
		await page.route("**/api/v1/**", (r) => r.abort("internetdisconnected"));
		await page.goto("/");
		await expect(page.locator("[data-failure=offline] h1")).toHaveText(
			"Can't reach your pool",
		);
		await page.screenshot({ path: `${SHOTS}desktop-offline.png` });

		await page.unroute("**/api/v1/**");
		await page.route("**/api/v1/**", (r) =>
			r.fulfill({ status: 502, body: "{}", contentType: "application/json" }),
		);
		await page.getByRole("button", { name: "Retry" }).click();
		await expect(page.locator("[data-failure=daemon-down] h1")).toHaveText(
			"Pulsar isn't running on that machine",
		);

		await page.unroute("**/api/v1/**");
		await page.route("**/api/v1/**", (r) =>
			r.fulfill({
				status: 403,
				body: '{"error":"not the pool owner"}',
				contentType: "application/json",
			}),
		);
		await page.getByRole("button", { name: "Retry" }).click();
		await expect(page.locator("[data-failure=forbidden] h1")).toHaveText(
			"Wrong Tailscale account",
		);

		await page.unroute("**/api/v1/**");
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
				} satisfies Hello,
			}),
		);
		await page.goto("/");
		await expect(page.locator(".first-run h1")).toHaveText("Welcome to Pulsar");
		// Failed fetches log "Failed to load resource"; that's the point of this test.
		errors.splice(
			0,
			errors.length,
			...errors.filter(
				(e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e),
			),
		);
	});

	test("main view screenshot", async ({ page }) => {
		await ready(page);
		await page.locator('[data-node="m:studio/p:apparish"] .chev').click();
		await page
			.locator(".tree [data-agent]", { hasText: "codex@apparish" })
			.first()
			.click();
		await expect(page.locator(".transcript .ev").first()).toBeVisible();
		await page.waitForTimeout(1500);
		await page.screenshot({ path: `${SHOTS}desktop-main.png` });
	});
});

test("mock /send follows the daemon's 409 confirm/stale_token contract", async ({
	request,
}) => {
	const headers = { "X-Pulsar": "1" };
	const body = {
		to: "project=apparish",
		body: "hi",
		priority: "fyi",
		expectReply: false,
	};
	const first = await request.post("/api/v1/send", { headers, data: body });
	expect(first.status()).toBe(409);
	const conflict = await first.json();
	expect(conflict.error.code).toBe("confirm");
	expect(conflict.count).toBeGreaterThan(25);
	expect(conflict.totals).toBeTruthy();
	const ok = await request.post("/api/v1/send", {
		headers,
		data: { ...body, resolveToken: conflict.resolveToken },
	});
	expect(ok.status()).toBe(200);
	expect((await ok.json()).message.id).toMatch(/^m_/);
	const again = await request.post("/api/v1/send", {
		headers,
		data: { ...body, resolveToken: conflict.resolveToken },
	});
	expect(again.status()).toBe(409);
	expect((await again.json()).error.code).toBe("stale_token");
});

test.describe("desktop extras", () => {
	test("pushed messages: the operator's own turn, the app's, an agent's, no frame text", async ({
		page,
		request,
	}) => {
		// The fixture on studio: other machines run agents with the same name.
		const id = await agentId(request, "name=omp@apparish machine=studio");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const t = page.locator(".transcript");
		// Framed by the daemon's formatPush, read back by the pi/omp parser.
		const op = t.locator('[data-pulsar-id="m_op1"]');
		await expect(op).toHaveCount(1);
		await expect(op).toHaveClass(/ds-turn--user/);
		await expect(op.locator(".ds-author-name")).toHaveText("Ada Lovelace");
		await expect(op.locator(".ds-author-via")).toHaveText(
			"via Pulsar on studio",
		);
		await expect(op.locator(".ds-author-via")).toHaveAttribute(
			"title",
			"Pulsar message m_op1",
		);
		await expect(op.locator(".ds-bubble")).toHaveText(
			"tighten the refresh lock and add a test",
		);
		const app = t.locator('[data-pulsar-id="m_app1"]');
		await expect(app).toHaveClass(/ds-turn--peer/);
		await expect(app.locator(".ds-author-name")).toHaveText(
			"From the Pulsar app (not verified)",
		);
		await expect(app).toContainText("is the deploy done?");
		const agent = t.locator('[data-pulsar-id="m_ag1"]');
		await expect(agent.locator(".ds-author-name")).toHaveText("codex@apparish");
		await expect(agent.locator(".ds-author-via")).toHaveText("Another agent");
		await expect(agent).toContainText("rebased main, go ahead");
		for (const frame of [
			"[human operator",
			"[pulsar]",
			"respond m_",
			"— via Pulsar",
		])
			await expect(t).not.toContainText(frame);
	});

	test("load earlier keeps at most 300 events and streaming resumes", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=omp@apparish");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const events = page.locator(".transcript .ev");
		await expect(events.first()).toBeVisible();
		const earlier = page.locator(".load-earlier");
		for (let i = 0; i < 4 && (await earlier.isVisible()); i++) {
			await earlier.click();
			await page.waitForTimeout(300);
			expect(await events.count()).toBeLessThanOrEqual(300);
		}
		// Reached the start of the session: the first user message is there.
		await expect(earlier).toBeHidden({ timeout: 10_000 });
		expect(await events.count()).toBeLessThanOrEqual(300);
		// Back to the latest; live events keep arriving.
		const latest = page.locator(".new-pill");
		if (await latest.isVisible()) await latest.click();
		const before = await page.locator(".transcript").textContent();
		await expect
			.poll(
				async () =>
					(await page.locator(".transcript").textContent()) !== before,
				{ timeout: 10_000 },
			)
			.toBe(true);
		expect(await events.count()).toBeLessThanOrEqual(300);
	});

	test("dark mode screenshot", async ({ page, request, errors }) => {
		await page.emulateMedia({ colorScheme: "dark" });
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const reply = page
			.locator(".ev.msg", { hasText: "The refresh path races" })
			.first();
		await reply.scrollIntoViewIfNeeded();
		await expect(
			reply.locator("pre span[style*='--sdm-c']").first(),
		).toBeVisible({ timeout: 15_000 });
		// The code block re-renders when tokens arrive; retry the scroll.
		for (let i = 0; i < 5; i++) {
			try {
				await page
					.locator("pre", { hasText: "getSession" })
					.first()
					.scrollIntoViewIfNeeded({ timeout: 2000 });
				break;
			} catch {
				await page.waitForTimeout(300);
			}
		}
		await page.screenshot({ path: `${SHOTS}desktop-dark.png` });
		// Mermaid on screen: Streamdown's blocked size attribute (see the rich test).
		errors.splice(
			0,
			errors.length,
			...errors.filter((e) => !/Applying inline style violates/.test(e)),
		);
	});
});

test.describe("service worker", () => {
	test.use({ serviceWorkers: "allow" });
	test("caches the static shell only, never API responses", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
		await page.evaluate(() => navigator.serviceWorker.ready);
		// A second load goes through the worker.
		await page.reload();
		await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
		const cached = await page.evaluate(async () => {
			const urls: string[] = [];
			for (const name of await caches.keys()) {
				const c = await caches.open(name);
				for (const r of await c.keys()) urls.push(new URL(r.url).pathname);
			}
			return urls;
		});
		expect(cached.length).toBeGreaterThan(0);
		expect(cached.filter((u) => u.startsWith("/api/"))).toEqual([]);
	});
});

test.describe("Prove Human", () => {
	test.use({ proveSends: true });

	test("an unproven send opens Prove Human; Send without proving still sends, once per tab", async ({
		page,
		request,
	}) => {
		await resetPasskeys(request);
		await ready(page);
		await page.locator('[data-node="m:studio/p:apparish"] .chev').click();
		await page
			.locator(".tree [data-agent]", { hasText: "codex@apparish" })
			.first()
			.click();
		await page.locator(".composer-input").fill("rebase on main");
		await page.keyboard.press("ControlOrMeta+Enter");
		const sheet = page.getByRole("dialog", { name: "Prove Human" });
		await expect(sheet).toContainText("human operator");
		await expect(sheet).toContainText("not verified as your operator");
		await expectCleanCopy(page, "Prove Human (send)", ".prove-sheet");
		await sheet.getByRole("button", { name: "Send without proving" }).click();
		await expect(sheet).toHaveCount(0);
		await expect(page.locator(".ds-delivery").last()).toBeVisible({
			timeout: 8000,
		});
		// The choice holds for this tab.
		await page.locator(".composer-input").fill("and run the tests");
		await page.keyboard.press("ControlOrMeta+Enter");
		// Unproven: the optimistic bubble, then the app's own (not verified) turn.
		await expect(
			page
				.locator(".ds-turn--user, .ds-turn--peer.is-app", {
					hasText: "and run the tests",
				})
				.last(),
		).toBeVisible();
		await expect(sheet).toHaveCount(0);
	});
});

test.describe("Prove Human: approval alerts", () => {
	test("turning on approval alerts unproven opens Prove Human, then turns them on", async ({
		page,
		request,
		context,
	}) => {
		// A browser that can take push (stubbed: the tests block service workers).
		await page.addInitScript(() => {
			let sub: unknown = null;
			const fake = {
				endpoint: "https://fcm.googleapis.com/fcm/send/test",
				toJSON: () => ({
					endpoint: "https://fcm.googleapis.com/fcm/send/test",
					keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
				}),
				unsubscribe: async () => {
					sub = null;
					return true;
				},
			};
			const reg = {
				pushManager: {
					getSubscription: async () => sub,
					subscribe: async () => {
						sub = fake;
						return fake;
					},
				},
			};
			Object.assign(window, { PushManager: () => {} });
			Object.defineProperty(window, "Notification", {
				value: {
					permission: "default",
					requestPermission: async () => "granted",
				},
			});
			navigator.serviceWorker.getRegistration = (async () =>
				reg) as unknown as typeof navigator.serviceWorker.getRegistration;
		});
		await page.goto(`${localhostBase()}/`);
		await withPasskey(page, request, context);
		await page.reload();
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = page.getByRole("dialog", { name: "Settings" });
		const alerts = settings.getByRole("switch", { name: "Approval alerts" });
		await expect(alerts).not.toBeChecked();
		await alerts.click();
		const prove = page.getByRole("dialog", { name: "Prove Human" });
		await expect(prove).toContainText("To turn on approval alerts");
		await proveInSheet(page);
		await expect(alerts).toBeChecked();
	});
});
