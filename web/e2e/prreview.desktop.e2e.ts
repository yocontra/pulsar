import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
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
 * Desktop PR review (web/src/features/prreview): the PR card's "Review"
 * opens `#/pr/<agent>` with Summary / Files / Checks; threads sit at their
 * lines; a line comment, a reply, a resolve and a review each run as an
 * acting op (web/mock/prreview.ts). apparish-auth has PR #1402 with an
 * open thread, a resolved one and an outdated one.
 */

const H = { "X-Pulsar": "1" };

async function mock(request: APIRequestContext, path: string, body: object) {
	const res = await request.post(`/api/v1/__mock/${path}`, {
		headers: H,
		data: body,
	});
	expect(res.ok()).toBe(true);
}

async function openReview(
	page: Page,
	request: APIRequestContext,
	context: BrowserContext,
) {
	const id = await agentId(request, "name=apparish-auth");
	await page.goto(`${localhostBase()}/`);
	await withPasskey(page, request, context);
	await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(id)}`);
	await page
		.locator(".session-header")
		.getByRole("button", { name: /^PR #1402/ })
		.click();
	await page
		.getByRole("dialog", { name: "Pull request" })
		.getByRole("button", { name: "Review" })
		.click();
	const main = page.getByRole("main", { name: "Pull request review" });
	await expect(main.locator(".prv-title h2")).toContainText(
		"Fix the token refresh race",
	);
	return { id, main };
}

/** The toast that says `text` (newer toasts stack above older ones). */
const toast = (page: Page, text: string) =>
	page.locator("[data-sonner-toast]", { hasText: text }).first();

test.describe("PR review", () => {
	test.afterEach(async ({ request }) => {
		await mock(request, "realtime", { action: "restore" });
	});

	test("summary, checks, files with threads; comment, reply, resolve, review", async ({
		page,
		request,
		context,
	}) => {
		const { id, main } = await openReview(page, request, context);
		expect(page.url()).toContain(`#/pr/${encodeURIComponent(id)}`);
		// Summary: the description and the reviews, as plain text.
		const tabs = main.getByRole("tablist", { name: "Review" });
		await expect(tabs.getByRole("tab", { name: /Summary/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(
			main.getByRole("region", { name: "Description" }),
		).toContainText("Two refreshes that start together raced");
		await expect(main.getByRole("region", { name: "Reviews" })).toContainText(
			"The retry path still races",
		);
		await expect(main.locator(".prv-stats")).toContainText("2 open threads");
		expect(await contrastFailures(page, ".prv-page *")).toEqual([]);
		// Checks: failing first.
		await tabs.getByRole("tab", { name: /Checks/ }).click();
		await expect(tabs.getByRole("tab", { name: /Checks/ })).toContainText(
			"1 failing",
		);
		await expect(main.locator(".g-check").first()).toHaveClass(/fail/);
		await expect(main.locator(".g-check")).toHaveCount(3);
		// Files: the list, every diff with line numbers, threads at their lines.
		await tabs.getByRole("tab", { name: /Files/ }).click();
		await expect(
			main.getByRole("list", { name: "Changed files" }).locator("li"),
		).toHaveCount(3);
		const refresh = main.getByRole("region", { name: "src/auth/refresh.ts" });
		const open = refresh
			.locator(".prv-at-line")
			.getByRole("region", { name: "Thread by reviewer", exact: true });
		await expect(open).toContainText("Use the mutex here too.");
		// The outdated thread sits above the diff and says where it was.
		const old = refresh.locator(".prv-loose");
		await expect(old).toContainText("Outdated");
		await expect(old).toContainText("was line 30");
		// The resolved thread is folded.
		const tests = main.getByRole("region", { name: "test/refresh.test.ts" });
		const done = tests.getByRole("region", {
			name: "Thread by reviewer, resolved",
		});
		await expect(done).not.toContainText("Assert the token too.");
		await done.getByRole("button", { name: "Show 2 comments" }).click();
		await expect(done).toContainText("Done in the next commit.");
		await expect(
			main.getByRole("region", { name: "docs/flow.png" }),
		).toContainText("Binary file, not shown.");
		// The diff's colors are the shared highlighter's; check what this page adds.
		expect(
			await contrastFailures(
				page,
				".prv-files-nav *, .prv-file-head *, .prv-thread *, .ds-diff-ln",
			),
		).toEqual([]);

		// A comment on line 41 (new side): the gutter button, then the box.
		const row = refresh
			.locator(".ds-diff-cell.add", { hasText: "method" })
			.first();
		await row.hover();
		await row.getByRole("button", { name: "Comment on line 41" }).click();
		const box = refresh.getByRole("textbox", { name: "New comment" });
		await box.fill("Keep the method on one line.");
		await refresh.getByRole("button", { name: "Comment", exact: true }).click();
		await proveInSheet(page);
		await expect(toast(page, "Comment added")).toBeVisible();
		await expect(
			refresh.getByRole("region", { name: "Thread by operator" }),
		).toContainText("Keep the method on one line.");

		// Reply, then resolve the reviewer's thread.
		await open.getByRole("button", { name: "Reply" }).click();
		await open
			.getByRole("textbox", { name: "Reply" })
			.fill("Done: it runs under the lock now.");
		await open.getByRole("button", { name: "Reply", exact: true }).click();
		await expect(toast(page, "Reply added")).toBeVisible();
		await expect(open).toContainText("Done: it runs under the lock now.");
		await open.getByRole("button", { name: "Resolve" }).click();
		await expect(toast(page, "Thread resolved")).toBeVisible();
		await expect(
			refresh
				.getByRole("region", { name: "Thread by reviewer, resolved" })
				.first(),
		).toBeVisible();

		// Submit a review: on your own PR only Comment is offered.
		await main.getByRole("button", { name: "Submit review" }).click();
		const form = page.getByRole("dialog", { name: "Submit review" });
		const approve = form.getByRole("radio", { name: /Approve/ });
		await expect(approve).toBeDisabled();
		await expect(form.locator(".prv-event.off").first()).toHaveAttribute(
			"title",
			"You can't approve or request changes on your own PR.",
		);
		const submit = form.getByRole("button", { name: "Submit review" });
		await expect(submit).toBeDisabled();
		await expect(submit).toHaveAttribute("title", "Write a summary first.");
		await form.getByLabel("Review summary").fill("Looks right to me.");
		expect(await contrastFailures(page, ".prv-pop *")).toEqual([]);
		await submit.click();
		await expect(toast(page, "Review submitted")).toBeVisible();
		await expect(form).toHaveCount(0);
		await tabs.getByRole("tab", { name: /Summary/ }).click();
		await expect(main.getByRole("region", { name: "Reviews" })).toContainText(
			"Looks right to me.",
		);
	});

	test("someone else's PR: request changes; a refused write toasts GitHub's words", async ({
		page,
		request,
		context,
		errors,
	}) => {
		await mock(request, "prreview", {
			agent: "apparish-auth",
			set: { ownPr: false },
			fail: {
				op: "comment",
				message: "Validation Failed: line must be part of the diff",
			},
		});
		const { main } = await openReview(page, request, context);
		await main.getByRole("tab", { name: /Files/ }).click();
		const refresh = main.getByRole("region", { name: "src/auth/refresh.ts" });
		const row = refresh
			.locator(".ds-diff-cell.del", { hasText: "await fetch" })
			.first();
		await row.hover();
		await row.getByRole("button", { name: "Comment on old line 39" }).click();
		await refresh
			.getByRole("textbox", { name: "New comment" })
			.fill("Why move this?");
		await refresh.getByRole("button", { name: "Comment", exact: true }).click();
		await proveInSheet(page);
		await expect(toast(page, "Action failed")).toBeVisible();
		await expect(toast(page, "line must be part of the diff")).toBeVisible();
		// The box stays with the text, to try again.
		await expect(
			refresh.getByRole("textbox", { name: "New comment" }),
		).toHaveValue("Why move this?");
		await main.getByRole("button", { name: "Submit review" }).click();
		const form = page.getByRole("dialog", { name: "Submit review" });
		await form.getByRole("radio", { name: /Request changes/ }).check();
		await form.getByLabel("Review summary").fill("Keep the old order.");
		await form.getByRole("button", { name: "Submit review" }).click();
		await expect(toast(page, "Changes requested")).toBeVisible();
		errors.splice(
			0,
			errors.length,
			...errors.filter((e) => !/status of 409/.test(e)),
		);
	});

	test("on another machine each write is one passkey check for exactly its params", async ({
		page,
		request,
		context,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
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
		expect(
			await act("resolve", {
				number: 1402,
				thread: "PRRT_mock_open",
				resolved: true,
			}),
		).toEqual({ ok: true, resolved: true });
		expect(
			await act("reply", {
				number: 1402,
				thread: "PRRT_mock_open",
				body: "On it.",
			}),
		).toEqual({ ok: true });
		// Reads through the address too.
		const r = await request.get(
			`/api/v1/agents/${encodeURIComponent(address)}/git/review`,
			{ headers: H },
		);
		const review = (await r.json()) as {
			threads: {
				id: string;
				resolved: boolean;
				comments: { body: string }[];
			}[];
		};
		const t = review.threads.find((x) => x.id === "PRRT_mock_open")!;
		expect(t.resolved).toBe(true);
		expect(t.comments.at(-1)?.body).toBe("On it.");
	});
});
