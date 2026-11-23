import type { Page } from "@playwright/test";
import {
	agentId,
	expect,
	localhostBase,
	test,
	withPasskey,
} from "./fixtures.ts";
import { liveSuite, realtime } from "./live.shared.ts";

// Chromium (desktop layout).
liveSuite("desktop");

/** The session header's git split button. */
const split = (page: Page) => page.getByRole("group", { name: "Git actions" });

/** Resolves once the app's subscription watches the agent's git status. */
const gitWatched = (page: Page, id: string) =>
	page.waitForResponse((r) => {
		const req = r.request();
		if (req.method() !== "PUT" || !r.url().includes("/subscriptions/"))
			return false;
		const git = (JSON.parse(req.postData() ?? "{}") as { git?: string[] }).git;
		return r.ok() && !!git?.includes(id);
	});

test.describe("git stays live", () => {
	test("git status updates on a git notice for the watched agent", async ({
		page,
		request,
		context,
	}) => {
		const id = await agentId(
			request,
			"name=codex@apparish branch=feat/billing",
		);
		await page.goto(`${localhostBase()}/`);
		await withPasskey(page, request, context);
		const watched = gitWatched(page, id);
		await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(id)}`);
		await expect(
			split(page).getByRole("button", { name: "Push & create PR" }),
		).toBeVisible();
		await watched;
		// The branch fell behind upstream (the daemon's worktree watch saw it).
		await realtime(request, {
			action: "git",
			id,
			set: { behind: 3, ahead: 0 },
		});
		const push = split(page).getByRole("button", { name: "Push" });
		// Well inside the 15 s fallback poll: the notice did it.
		await expect(push).toHaveAttribute("aria-disabled", "true", {
			timeout: 5000,
		});
	});

	test("the open PR card reads again on a git notice", async ({
		page,
		request,
		context,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`${localhostBase()}/`);
		await withPasskey(page, request, context);
		await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(id)}`);
		await page
			.locator(".session-header")
			.getByRole("button", { name: /^PR #1402/ })
			.click();
		const card = page.getByRole("dialog", { name: "Pull request" });
		await expect(card).toBeVisible();
		// Bounded well inside the card's 30 s GitHub poll.
		const reread = page.waitForRequest(
			(r) => r.url().includes(`/agents/${encodeURIComponent(id)}/git/pr`),
			{ timeout: 5000 },
		);
		// A branch or PR change goes to every stream.
		await realtime(request, { action: "git", id, all: true });
		await reread;
	});

	test("the open file viewer reads again when the agent's worktree moves", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		const watched = gitWatched(page, id);
		await page.goto(
			`${localhostBase()}/#/file/${encodeURIComponent(id)}?path=src`,
		);
		await expect(page.getByRole("main", { name: "Files" })).toBeVisible();
		await watched;
		// Bounded well inside the viewer's 30 s fallback poll.
		const reread = page.waitForRequest(
			(r) => r.url().includes(`/agents/${encodeURIComponent(id)}/files/`),
			{ timeout: 5000 },
		);
		await realtime(request, {
			action: "changes",
			id,
			path: "src/auth/refresh.ts",
			line: "// edited",
		});
		await reread;
	});
});
