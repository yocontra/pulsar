import type { APIRequestContext, Page } from "@playwright/test";
import {
	agentId,
	expect,
	localhostBase,
	proveInSheet,
	test,
	withPasskey,
} from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

/**
 * Desktop git actions in the session header (web/src/features/git): the
 * split button's quick action and menu, disabled reasons, the commit
 * dialog, progress in place, the PR card with "Ask … to fix", and the
 * acting proof (web/mock/git.ts). apparish-auth (needs you) has 7 changed
 * files and PR #1402; codex@apparish (busy) is clean with 2 commits to push.
 */

const H = { "X-Pulsar": "1" };
/** The fixed fixtures (random agents may share a name). */
const SELECT: Record<string, string> = {
	"codex@apparish": "name=codex@apparish branch=feat/billing",
};

async function mock(request: APIRequestContext, path: string, body: object) {
	const res = await request.post(`/api/v1/__mock/${path}`, {
		headers: H,
		data: body,
	});
	expect(res.ok()).toBe(true);
}

async function open(
	page: Page,
	request: APIRequestContext,
	context: import("@playwright/test").BrowserContext,
	name: string,
) {
	const id = await agentId(request, SELECT[name] ?? `name=${name}`);
	await page.goto(`${localhostBase()}/`);
	await withPasskey(page, request, context);
	await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(id)}`);
	await expect(page.locator(".session-header h1")).toHaveText(name);
	return id;
}

const split = (page: Page) => page.getByRole("group", { name: "Git actions" });
const status = (page: Page) => page.locator(".g-progress");

/** Drops the expected 409 console errors of a refused action. */
function allow409(errors: string[]) {
	errors.splice(
		0,
		errors.length,
		...errors.filter((e) => !/status of 409/.test(e)),
	);
}

test.describe("git actions", () => {
	test.afterEach(async ({ request }) => {
		await mock(request, "realtime", { action: "restore" });
	});

	test("commit & push: the dialog, Edit, draft, the busy confirm, Prove Human, progress", async ({
		page,
		request,
		context,
	}) => {
		await open(page, request, context, "apparish-auth");
		const head = page.locator(".session-header");
		await expect(head.locator(".g-head-stat")).toContainText("+");
		await expect(head.getByRole("button", { name: /^PR #1402/ })).toBeVisible();
		// A PR is open already: the quick action commits and pushes.
		const main = split(page).getByRole("button", { name: "Commit & push" });
		await main.click();
		const dialog = page.getByRole("dialog", { name: "Commit changes" });
		await expect(dialog).toBeVisible();
		await expect(dialog.locator(".g-branch")).toHaveText("fix-1378");
		await expect(dialog.locator(".g-file")).toHaveCount(7);
		await expect(dialog.locator(".g-files-title")).toHaveText("7 files");
		// No message yet: Commit is off and says why.
		const commit = dialog.getByRole("button", { name: "Commit", exact: true });
		await expect(commit).toBeDisabled();
		await expect(commit).toHaveAttribute("title", "Write a commit message.");
		// Edit: leave one file out.
		await dialog.getByRole("button", { name: "Edit" }).click();
		await dialog.getByRole("checkbox", { name: "NOTES.md" }).uncheck();
		await expect(dialog.locator(".g-files-title")).toHaveText("6 of 7 files");
		await expect(
			dialog.locator(".g-file.excluded", { hasText: "NOTES.md" }),
		).toContainText("Excluded");
		await expect(
			dialog.getByRole("checkbox", { name: "Select all files" }),
		).toHaveJSProperty("indeterminate", true);
		await dialog.getByRole("button", { name: "Draft from changes" }).click();
		await expect(dialog.getByLabel("Commit message")).toHaveValue(/^Update /);
		expect(await contrastFailures(page, ".g-commit *")).toEqual([]);
		await commit.click();
		// The agent waits on an approval (mid-turn): confirm first.
		const busy = page.getByRole("alertdialog", {
			name: "apparish-auth is working",
		});
		await expect(busy).toBeVisible();
		await busy.getByRole("button", { name: "Commit anyway" }).click();
		await proveInSheet(page);
		await expect(status(page)).toHaveText("Pushed to origin/fix-1378");
		await expect(status(page)).toHaveAttribute("role", "status");
		// What was left out is still there.
		await expect(page.getByRole("button", { name: /^Changes/ })).toContainText(
			"1",
		);
		// Back to the button once the result has shown.
		await expect(split(page)).toBeVisible({ timeout: 10_000 });
		await expect(
			split(page).getByRole("button", { name: "Commit & push" }),
		).toBeVisible();
	});

	test("push & create PR on a working agent; the PR chip appears", async ({
		page,
		request,
		context,
	}) => {
		await open(page, request, context, "codex@apparish");
		await split(page).getByRole("button", { name: "Push & create PR" }).click();
		const busy = page.getByRole("alertdialog", {
			name: "codex@apparish is working",
		});
		await busy.getByRole("button", { name: "Push anyway" }).click();
		await proveInSheet(page);
		const done = status(page).getByRole("link", { name: "Created PR #1500" });
		await expect(done).toBeVisible();
		await expect(
			page
				.locator(".session-header")
				.getByRole("button", { name: /^PR #1500/ }),
		).toBeVisible();
	});

	test("More Git Actions is disabled until a menu action is available", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, SELECT["codex@apparish"]!);
		let conflicted = 1;
		await page.route("**/git/status", async (route) => {
			const response = await route.fetch();
			await route.fulfill({
				response,
				json: {
					...(await response.json()),
					conflicted,
					behind: 0,
					ahead: 1,
					pr: null,
				},
			});
		});
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const menu = split(page).getByRole("button", { name: "More git actions" });
		await expect(menu).toBeDisabled();
		await menu.click({ force: true });
		await expect(page.getByRole("menu")).toBeHidden();
		conflicted = 0;
		await page.reload();
		await expect(menu).toBeEnabled();
		await menu.click();
		await expect(page.getByRole("menuitem", { name: /^Push/ })).toBeEnabled();
	});

	test("disabled reasons: tooltip on the quick action, notes in the menu", async ({
		page,
		request,
		context,
	}) => {
		await mock(request, "git", {
			agent: "codex@apparish",
			set: { behind: 3, ahead: 0 },
		});
		await open(page, request, context, "codex@apparish");
		const main = split(page).getByRole("button", { name: "Push" });
		await expect(main).toHaveAttribute("aria-disabled", "true");
		await main.hover();
		await expect(page.getByRole("tooltip")).toHaveText(
			"Branch is behind upstream. Pull or rebase before pushing.",
		);
		// A click does nothing (aria-disabled keeps the tooltip reachable).
		await main.click({ force: true });
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await split(page).getByRole("button", { name: "More git actions" }).click();
		const menu = page.getByRole("menu");
		await expect(menu.getByRole("menuitem", { name: /^Commit/ })).toContainText(
			"Worktree is clean. Make changes before committing.",
		);
		await expect(
			menu.getByRole("menuitem", { name: /^Commit/ }),
		).toHaveAttribute("aria-disabled", "true");
		await expect(menu.getByRole("menuitem", { name: /^Push/ })).toContainText(
			"Branch is behind upstream. Pull or rebase before pushing.",
		);
		await page.keyboard.press("Escape");
		// gh logged out on the agent's machine.
		await mock(request, "git", {
			agent: "codex@apparish",
			set: { behind: 0, ahead: 1, gh: "logged_out" },
		});
		await page.reload();
		await expect(
			split(page).getByRole("button", { name: "Push", exact: true }),
		).toBeVisible();
		await split(page).getByRole("button", { name: "More git actions" }).click();
		await expect(
			page.getByRole("menu").getByRole("menuitem", { name: /^Create PR/ }),
		).toContainText("gh isn't logged in on studio. Run gh auth login there.");
	});

	test("the default branch asks first; a failed push toasts git's words", async ({
		page,
		request,
		context,
		errors,
	}) => {
		const id = await agentId(request, "name=omp-blocks");
		await mock(request, "realtime", {
			action: "changes",
			id,
			path: "README.md",
			line: "more",
		});
		await mock(request, "git", {
			agent: "omp-blocks",
			set: { branch: "main", upstream: "origin/main", pr: null },
			fail: {
				op: "push",
				code: "git_failed",
				message: "Push rejected: protected branch (pre-receive hook declined)",
			},
		});
		await open(page, request, context, "omp-blocks");
		// On the default branch there is no PR to make: commit and push.
		await split(page).getByRole("button", { name: "Commit & push" }).click();
		const dialog = page.getByRole("dialog", { name: "Commit changes" });
		await expect(dialog.locator(".g-chip.warn")).toHaveText("Default branch");
		await dialog.getByLabel("Commit message").fill("Update the readme");
		await dialog.getByRole("button", { name: "Commit", exact: true }).click();
		await expect(dialog.getByRole("alert")).toContainText(
			"Run on the default branch?",
		);
		await dialog.getByRole("button", { name: "Commit to main" }).click();
		await proveInSheet(page);
		const toast = page.locator("[data-sonner-toast]");
		await expect(toast).toContainText("Action failed");
		await expect(toast).toContainText(
			"Push rejected: protected branch (pre-receive hook declined)",
		);
		// The commit went through; the push can be tried again.
		await expect(
			split(page).getByRole("button", { name: "Push", exact: true }),
		).toBeVisible();
		allow409(errors);
	});

	test("PR card: checks, review comments, Ask to fix sends the text", async ({
		page,
		request,
		context,
	}) => {
		await open(page, request, context, "apparish-auth");
		await page
			.locator(".session-header")
			.getByRole("button", { name: /^PR #1402/ })
			.click();
		const card = page.getByRole("dialog", { name: "Pull request" });
		await expect(card).toContainText("Fix the token refresh race");
		await expect(card).toContainText("Changes requested");
		const checks = card.getByRole("region", { name: "Checks" });
		await expect(checks).toContainText("1 failing");
		await expect(checks.locator(".g-check")).toHaveCount(3);
		await expect(
			card
				.getByRole("region", { name: "Review comments" })
				.locator(".g-comment"),
		).toHaveCount(2);
		await expect(card).toContainText("src/auth/refresh.ts:42");
		expect(await contrastFailures(page, ".g-pop *")).toEqual([]);
		await card
			.getByRole("button", { name: "Ask apparish-auth to fix" })
			.click();
		const ask = page.getByRole("dialog", { name: "Ask apparish-auth to fix" });
		const text = ask.getByLabel("Message");
		await expect(text).toHaveValue(/^Please fix PR #1402/);
		await expect(text).toHaveValue(
			/- test \(ubuntu\) \(https:\/\/ci\.example\/1\)/,
		);
		await expect(text).toHaveValue(
			/reviewer on src\/auth\/refresh\.ts:42: Use the mutex here too\./,
		);
		await ask.getByRole("button", { name: "Send to apparish-auth" }).click();
		await expect(page.locator("[data-sonner-toast]")).toContainText(
			"Asked apparish-auth to fix",
		);
		await expect(ask).toHaveCount(0);
	});

	test("an agent with no repo shows no git actions", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=omp@apparish");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await expect(page.locator(".session-header h1")).toHaveText("omp@apparish");
		// The header has loaded its actions (Stop or the model).
		await expect(page.locator(".d-sh-model")).toBeVisible();
		await expect(split(page)).toHaveCount(0);
		await expect(
			page.locator(".d-sh-branch, .d-sh-pr, a.d-sh-repo, .cv-toggle"),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Files", exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("Wakes it if idle", { exact: true }),
		).toHaveCount(0);
	});

	test("on another machine each step is one passkey check for exactly its params", async ({
		page,
		request,
		context,
		errors,
	}) => {
		const id = await agentId(request, SELECT["codex@apparish"]!);
		const hello = (await (
			await request.get("/api/v1/hello", { headers: H })
		).json()) as { machineId: string };
		await page.addInitScript(() => {
			(window as { __pulsarE2E?: object }).__pulsarE2E = {};
		});
		await page.goto(`${localhostBase()}/`);
		await withPasskey(page, request, context);
		const address = `${hello.machineId}/${id}`;
		const act = (what: string, params: object) =>
			page.evaluate(
				async ({ address, what, params }) => {
					const h = (
						window as unknown as {
							__pulsarE2E: {
								api: {
									gitAct: (a: string, w: string, p: object) => Promise<unknown>;
								};
							};
						}
					).__pulsarE2E;
					try {
						return await h.api.gitAct(address, what, params);
					} catch (e) {
						return { code: (e as { code?: string }).code ?? "error" };
					}
				},
				{ address, what, params },
			);
		// No Prove Human sheet: the "home node" checks its own challenge.
		expect(await act("push", { confirmBusy: true })).toMatchObject({
			pushed: true,
			upstream: "origin/feat/billing",
		});
		expect(await act("pr", {})).toMatchObject({
			created: true,
			pr: { number: 1500 },
		});
		// The busy guard holds without the confirm in the signed params.
		await mock(request, "git", { agent: "codex@apparish", set: { ahead: 1 } });
		expect(await act("push", {})).toEqual({ code: "confirm_busy" });
		allow409(errors);
	});
});
