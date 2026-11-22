import {
	copies,
	expectCopyOutside,
	expectRefs,
	fileUrl,
	openGallery,
	recordCopies,
	ref,
} from "./files.shared.ts";
import { agentId, expect, test } from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

/** The desktop file viewer: the main pane, a folder tree beside the file. */

test.describe("file viewer", () => {
	test.beforeEach(async ({ page }) => {
		await recordCopies(page);
	});

	test("file references in a transcript: open inside, copy outside", async ({
		page,
	}) => {
		const id = await openGallery(page);
		await expectRefs(page);
		await expectCopyOutside(page);

		await ref(page, "QA report").click();
		await expect(page).toHaveURL(fileUrl(id, "out/qa/report.html"));
		const main = page.getByRole("main", { name: "Files" });
		await expect(main.locator(".ds-code")).toContainText("All checks passed.");
		const crumbs = main.getByRole("navigation", { name: "Path" });
		await expect(crumbs).toContainText("demo");
		await expect(crumbs.locator('[aria-current="page"]')).toHaveText(
			"report.html",
		);
		// The tree opened the folders on the way to the file.
		await expect(
			main.locator(".fv-node.is-current", { hasText: "report.html" }),
		).toBeVisible();

		await page.goBack();
		await ref(page, "refresh.ts").click();
		await expect(page).toHaveURL(fileUrl(id, "src/auth/refresh.ts"));
		await expect(main.locator(".ds-code")).toContainText("const lock");
	});

	test("a line in the route is marked and in view", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "fixture=blocks");
		await page.goto(
			`/#/file/${encodeURIComponent(id)}?path=src%2Fauth%2Frefresh.ts&line=7`,
		);
		await expect(page.locator(".ds-code-line.fv-hl")).toContainText(
			"export async function refresh",
		);
	});

	test("tree, folders, image, binary, Copy path and Open in Changes", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await page
			.locator(".d-session-head")
			.getByRole("button", { name: "Files", exact: true })
			.click();
		await expect(page).toHaveURL(
			new RegExp(`#/file/${encodeURIComponent(id)}$`),
		);
		const main = page.getByRole("main", { name: "Files" });
		const folder = main.getByRole("list", { name: "Files" });
		await expect(folder.getByRole("button")).toHaveText([
			"bin",
			"docs",
			"out",
			"src",
			"package.json",
			"README.md",
		]);
		await folder.getByRole("button", { name: "src", exact: true }).click();
		await expect(folder.getByRole("button")).toHaveText(["auth", "util"]);

		const tree = main.getByRole("list", { name: "Folder tree" });
		await tree.getByRole("button", { name: "docs", exact: true }).click();
		await tree.getByRole("button", { name: "shot.png", exact: true }).click();
		await expect(main.getByRole("img", { name: "shot.png" })).toBeVisible();
		await tree.getByRole("button", { name: "bin", exact: true }).click();
		await tree.getByRole("button", { name: "tool", exact: true }).click();
		await expect(main).toContainText("Binary file (8 B). Not shown.");
		// No changes to it: no Open in Changes.
		await expect(
			main.getByRole("button", { name: "Open in Changes" }),
		).toHaveCount(0);

		// src opened in the tree when the list opened it; auth is still closed.
		await expect(
			tree.getByRole("button", { name: "src", exact: true }),
		).toHaveAttribute("aria-expanded", "true");
		await tree.getByRole("button", { name: "auth", exact: true }).click();
		await tree.getByRole("button", { name: "refresh.ts", exact: true }).click();
		await expect(main.locator(".ds-code")).toContainText(
			"const lock = new Mutex();",
		);
		expect(await contrastFailures(page, ".fv *")).toEqual([]);

		await main.getByRole("button", { name: "Copy path" }).click();
		await expect(page.getByText("Path copied")).toBeVisible();
		expect(await copies(page)).toContain(
			"~/Projects/apparish/src/auth/refresh.ts",
		);

		await main.getByRole("button", { name: "Open in Changes" }).click();
		await expect(page).toHaveURL(
			new RegExp(
				`#/changes/${encodeURIComponent(id)}\\?f=src%2Fauth%2Frefresh\\.ts$`,
			),
		);
		await expect(
			page
				.getByRole("complementary", { name: "Changes" })
				.locator(".cv-file.current"),
		).toContainText("refresh.ts");
	});

	test("a path that isn't there says so", async ({ page, request }) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/file/${encodeURIComponent(id)}?path=nope.txt`);
		await expect(page.getByRole("main", { name: "Files" })).toContainText(
			"This file isn't in the agent's folder.",
		);
	});
});
