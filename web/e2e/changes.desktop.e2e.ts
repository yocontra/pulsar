import type { APIRequestContext, Page } from "@playwright/test";
import { agentId, expect, test } from "./fixtures.ts";
import {
	reviewChildLines,
	reviewDiffLines,
	reviewFileLines,
} from "./line-review.shared.ts";
import { contrastFailures, expectPointerCursors } from "./ui-audit.ts";

/**
 * The desktop changes panel (web/src/changes): what an agent's worktree has
 * dirty, beside the conversation. The mock gives apparish-auth a dirty
 * worktree (every status, a binary and a too-large file), codex@apparish a
 * clean one and omp@apparish none (web/mock/changes.ts).
 */

async function mock(request: APIRequestContext, body: object) {
	const res = await request.post("/api/v1/__mock/realtime", {
		headers: { "X-Pulsar": "1" },
		data: body,
	});
	expect(res.ok()).toBe(true);
}

async function openSession(page: Page, id: string) {
	await page.goto(`/#/a/${encodeURIComponent(id)}`);
	await expect(page.locator(".d-session-head h1")).toBeVisible();
}

const panel = (page: Page) =>
	page.getByRole("complementary", { name: "Changes" });

test.describe("changes panel", () => {
	test.afterAll(async ({ request }) => {
		await mock(request, { action: "restore" });
	});

	test("toggle, files, diffs, placeholders and modes", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		// Older peers send a worktree count without the session history flag.
		await page.route(
			/\/api\/v1\/agents\/[^/]+\/changes\?mode=worktree$/,
			async (route) => {
				const response = await route.fetch();
				const summary = await response.json();
				delete summary.hasChanges;
				await route.fulfill({ response, json: summary });
			},
		);
		await openSession(page, id);
		// 1440 px wide, no stored choice: closed.
		await expect(panel(page)).toHaveCount(0);
		const toggle = page.getByRole("button", { name: /^Changes/ });
		await expect(toggle).toContainText("7");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		const p = panel(page);
		await expect(p.locator(".cv-file")).toHaveCount(7);
		await expect(p.locator(".cv-branch")).toContainText("fix-1378");
		// The first file is selected; its diff is the transcript's renderer.
		await expect(p.locator(".cv-file.current")).toContainText("refresh.ts");
		await expect(p.locator(".cv-diff .ds-diff-row.add").first()).toContainText(
			"const lock = new Mutex();",
		);
		await expect(p.locator(".ds-diff-hunk").first()).toContainText("@@ -1,9");

		await p.locator(".cv-file", { hasText: "mutex.ts" }).click();
		await expect(p.locator(".cv-notes")).toContainText(
			"Renamed from src/util/lock.ts",
		);
		await p.locator(".cv-file", { hasText: "logo.png" }).click();
		await expect(p.locator(".cv-placeholder")).toContainText("Binary file");
		await p.locator(".cv-file", { hasText: "recording.json" }).click();
		await expect(p.locator(".cv-placeholder")).toContainText("over 512 KB");

		// ] / [ step through files.
		await p.locator(".cv-file.current").focus();
		await page.keyboard.press("BracketLeft");
		await expect(p.locator(".cv-file.current")).toContainText("logo.png");
		await page.keyboard.press("BracketRight");
		await expect(p.locator(".cv-file.current")).toContainText("recording.json");
		await p.getByRole("button", { name: "Previous file" }).click();
		await expect(p.locator(".cv-file.current")).toContainText("logo.png");

		// Branch vs base adds what the branch committed.
		await p.getByRole("radio", { name: /Branch vs base/ }).click();
		await expect(p.locator(".cv-file")).toHaveCount(8);
		await expect(
			p.locator(".cv-file", { hasText: "CHANGELOG.md" }),
		).toBeVisible();
		await p.getByRole("radio", { name: "Working tree" }).click();
		await expect(p.locator(".cv-file")).toHaveCount(7);

		// Expand all: every file gets a section.
		await p.getByRole("button", { name: "Expand all" }).click();
		await expect(p.locator(".cv-section")).toHaveCount(7);
		await expect(
			p
				.locator(
					'.cv-section[data-path="test/refresh.test.ts"] .ds-diff-row.add',
				)
				.first(),
		).toBeVisible();
		await p.getByRole("button", { name: "Collapse" }).click();
		await expect(p.locator(".cv-section")).toHaveCount(0);

		await expectPointerCursors(page, "changes panel");
		expect(await contrastFailures(page, ".cv-panel *")).toEqual([]);

		// Closing is remembered on this device.
		await p.getByRole("button", { name: "Close changes" }).click();
		await expect(panel(page)).toHaveCount(0);
		await page.reload();
		await expect(page.locator(".d-session-head h1")).toBeVisible();
		await expect(panel(page)).toHaveCount(0);
	});

	test("the keyboard shortcut toggles it, and the choice persists", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await openSession(page, id);
		await expect(page.getByRole("button", { name: /^Changes/ })).toBeVisible();
		await page.keyboard.press("ControlOrMeta+Backslash");
		await expect(panel(page)).toBeVisible();
		await page.reload();
		await expect(panel(page)).toBeVisible();
		await page.keyboard.press("ControlOrMeta+Backslash");
		await expect(panel(page)).toHaveCount(0);
	});

	test("clean and non-Git sessions hide the controls and automatic panel", async ({
		page,
		request,
	}) => {
		await page.addInitScript(() =>
			localStorage.setItem("pulsar.changes.open", "1"),
		);
		for (const name of ["codex@apparish", "omp@apparish"]) {
			const id = await agentId(request, `name=${name}`);
			const read = page.waitForResponse((response) =>
				response
					.url()
					.includes(`/agents/${encodeURIComponent(id)}/changes?mode=worktree`),
			);
			await openSession(page, id);
			await read;
			await expect(page.getByRole("button", { name: /^Changes/ })).toHaveCount(
				0,
			);
			await expect(panel(page)).toHaveCount(0);
			await page.keyboard.press("ControlOrMeta+Backslash");
			expect(
				await page.evaluate(() => localStorage.getItem("pulsar.changes.open")),
			).toBe("1");
		}
	});

	test("incomplete history allows manual Changes access without auto-opening", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await page.addInitScript(() =>
			localStorage.setItem("pulsar.changes.open", "1"),
		);
		await page.route(
			/\/api\/v1\/agents\/[^/]+\/changes\?mode=worktree$/,
			async (route) => {
				const response = await route.fetch();
				await route.fulfill({
					response,
					json: {
						...(await response.json()),
						hasChanges: false,
						changesHistoryIncomplete: true,
					},
				});
			},
		);
		await openSession(page, id);
		const toggle = page.getByRole("button", { name: "Changes", exact: true });
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(panel(page)).toHaveCount(0);
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await expect(panel(page)).toContainText("No changes in");
		await page.keyboard.press("ControlOrMeta+Backslash");
		await expect(panel(page)).toHaveCount(0);
		await page.keyboard.press("ControlOrMeta+Backslash");
		await expect(panel(page)).toBeVisible();
		await page.reload();
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(panel(page)).toHaveCount(0);
	});

	test("polling reveals Changes when a clean session gains its first edit", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await page.clock.install();
		const peek = page.waitForResponse((response) =>
			response
				.url()
				.includes(`/agents/${encodeURIComponent(id)}/changes?mode=worktree`),
		);
		await openSession(page, id);
		await peek;
		const toggle = page.getByRole("button", { name: /^Changes/ });
		await expect(toggle).toHaveCount(0);
		try {
			await mock(request, {
				action: "changes",
				id,
				path: "src/first-edit.ts",
				line: "first edit",
			});
			await page.clock.fastForward(16_000);
			await expect(toggle).toContainText("1");
			await toggle.click();
			await expect(panel(page).locator(".cv-file")).toContainText(
				"first-edit.ts",
			);
		} finally {
			await mock(request, { action: "restore" });
		}
	});

	test("updates live without losing the reader's place", async ({
		page,
		request,
	}) => {
		await page.addInitScript(() =>
			localStorage.setItem("pulsar.changes.open", "1"),
		);
		const id = await agentId(request, "name=apparish-auth");
		await openSession(page, id);
		const p = panel(page);
		await expect(p.locator(".cv-diff .ds-diff-row").first()).toBeVisible();
		// Let the subscription (debounced) land before the change.
		await page.waitForTimeout(800);
		const body = p.locator(".cv-body");
		// Scrolled to the end of the diff: an edit must not move the reader.
		const at = await body.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
			return el.scrollTop;
		});
		const line = `live edit ${Date.now().toString(36)}`;
		await mock(request, {
			action: "changes",
			id,
			path: "src/auth/refresh.ts",
			line,
		});
		await expect(p.locator(".cv-diff .ds-diff-row.add").last()).toContainText(
			line,
			{ timeout: 2000 },
		);
		expect(await body.evaluate((el) => el.scrollTop)).toBe(at);
		await expect(page.getByRole("button", { name: /^Changes/ })).toContainText(
			"7",
		);
		// A new file appears in the list.
		await mock(request, { action: "changes", id, path: "src/new.ts", line });
		await expect(p.locator(".cv-file", { hasText: "new.ts" })).toBeVisible({
			timeout: 2000,
		});
	});

	test("#/changes/<id>?f= opens the panel on that file", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/changes/${encodeURIComponent(id)}?f=NOTES.md`);
		const p = panel(page);
		await expect(p.locator(".cv-file.current")).toContainText("NOTES.md", {
			timeout: 15_000,
		});
		await expect(p.locator(".cv-diff .ds-diff-row.add").first()).toContainText(
			"# fix-1378",
		);
	});

	test("a wide window opens it on its own, side by side", async ({
		page,
		request,
	}) => {
		await page.setViewportSize({ width: 2200, height: 1000 });
		const id = await agentId(request, "name=apparish-auth");
		await openSession(page, id);
		const p = panel(page);
		await expect(p).toBeVisible();
		// Wide enough for the split layout once the panel is widened.
		const handle = page.getByRole("separator", {
			name: "Resize changes panel",
		});
		await handle.focus();
		await page.keyboard.press("Home");
		// A new file has nothing on the left: pick a modified one.
		await p.locator(".cv-file", { hasText: "refresh.ts" }).first().click();
		await expect(p.locator(".cv-diff.split")).toBeVisible();
	});
});

test("quote a renamed diff range in the existing agent draft", async ({
	page,
}) => reviewDiffLines(page, false));
test("quote source lines from a directly opened file", async ({ page }) =>
	reviewFileLines(page));

test("quote a workspace file in the subagent that opened it", async ({
	page,
}) => reviewChildLines(page));
