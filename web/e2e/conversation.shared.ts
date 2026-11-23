import { expectCleanCopy } from "./copy.ts";
import { agentId, expect, test } from "./fixtures.ts";

/**
 * The shared conversation (src/session/Transcript.tsx) on one platform:
 * copy, authorship, sans labels with mono targets, highlighted Bash, and a
 * skeleton that leaves the column where the loaded transcript puts it.
 */
export function conversationSuite(platform: "desktop" | "phone") {
	test.describe(`conversation (${platform})`, () => {
		// A failed test leaves no held request behind in the worker's mock.
		test.afterEach(async ({ request }) => {
			await request.post("/api/v1/__mock/faults", {
				headers: { "X-Pulsar": "1" },
				data: {},
			});
		});

		test("reads like a chat: authorship, sans labels, highlighted Bash, clean copy", async ({
			page,
			request,
		}) => {
			const id = await agentId(request, "name=apparish-auth");
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			const conv = page.locator(".ds-conv").first();
			await expect(conv.locator(".ev").first()).toBeVisible();
			await expect(conv).toHaveClass(
				platform === "phone" ? /ds-conv--phone/ : /ds-conv--desktop/,
			);
			// Authorship in words people use.
			await expect(conv.locator(".r-user .ds-author-name").first()).toHaveText(
				"You",
			);
			await expect(conv.locator(".ev.peer .ds-author-via").first()).toHaveText(
				"Another agent",
			);
			// Tool cards: a sans verb, then a mono target.
			// A card whose call is loaded: the first one on screen can be a bare
			// result whose call sits on an older page (no command to show).
			const card = conv
				.locator('.ev.tool[data-tool="Bash"]:has(.ds-tool-cmd)')
				.first();
			await expect(card.locator(".ds-tool-verb")).toBeVisible();
			await card.scrollIntoViewIfNeeded();
			const fonts = await card.evaluate((el) => ({
				verb: getComputedStyle(el.querySelector(".ds-tool-verb")!).fontFamily,
				cmd: getComputedStyle(el.querySelector(".ds-tool-cmd")!).fontFamily,
			}));
			expect(fonts.verb).not.toMatch(/mono/i);
			expect(fonts.cmd).toMatch(/mono/i);
			// Bash is highlighted in the collapsed summary (theme CSS variables).
			await expect(
				card.locator(".ds-tool-cmd span[style*='--ds-syn']").first(),
			).toBeAttached({ timeout: 15_000 });
			// The app's own words (author lines, tool verbs and results,
			// reasoning labels), not what the agents wrote.
			await expectCleanCopy(
				page,
				`${platform} transcript`,
				".ds-conv :is(.ds-author, .ds-tool-verb, .ds-tool-meta, .ds-reason-head, .ds-divider, .ds-working, .ds-system)",
			);
		});

		test("the skeleton holds the column where the transcript lands", async ({
			page,
			request,
		}) => {
			const id = await agentId(request, "name=codex@apparish");
			await page.goto("/");
			await expect(page.locator("#app [data-node]").first()).toBeVisible();
			// The mock holds the session's transcript until released: the
			// skeleton shows for as long as that request surely waits. (Only
			// the transcript: holding the event stream too left the app with no
			// stream when it reconnected, and the session never opened.)
			const H = { "X-Pulsar": "1" };
			const faults = (data: object) =>
				request.post("/api/v1/__mock/faults", { headers: H, data });
			expect(
				(
					await faults({
						rules: [
							{ method: "GET", path: `/agents/${id}/transcript`, hold: "t" },
						],
					})
				).ok(),
			).toBe(true);
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			const skel = page.locator(".transcript-skel");
			await expect(skel).toBeVisible();
			await expect
				.poll(async () => {
					const r = await request.get("/api/v1/__mock/held?hold=t", {
						headers: H,
					});
					return ((await r.json()) as { waiting: number }).waiting;
				})
				.toBeGreaterThan(0);
			const box = () =>
				page
					.locator(".ds-column")
					.first()
					.evaluate((el) => {
						const r = el.getBoundingClientRect();
						return { x: Math.round(r.x), w: Math.round(r.width) };
					});
			const before = await box();
			// Clearing the rules lets the held request go.
			expect((await faults({})).ok()).toBe(true);
			await expect(skel).toHaveCount(0);
			expect(await box()).toEqual(before);
		});
	});
}
