import type { Page } from "@playwright/test";
import {
	expect,
	localhostBase,
	proveInSheet,
	test,
	withPasskey,
} from "./fixtures.ts";

/**
 * New agent (features/launch) on the desktop: the draft in the session
 * pane, its pickers, Send's reasons, the start steps, the folder-trust
 * wait, a failure, another machine, and every way in. The mock runs the
 * steps on timers (web/mock/launch.ts).
 */

async function open(page: Page, hash = "") {
	await page.goto(`${localhostBase()}/${hash}`);
	await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
}

const draft = (page: Page) => page.getByTestId("launch-draft");

async function usePath(page: Page, path: string) {
	await page.getByTestId("launch-project").click();
	await page.getByRole("button", { name: "Add path…" }).click();
	await page.getByRole("searchbox", { name: "Search projects..." }).fill(path);
	await page.getByRole("button", { name: `Use ${path}` }).click();
}

test("start an agent here: draft, Prove Human, steps, then its session", async ({
	page,
	request,
	context,
}) => {
	await open(page);
	await withPasskey(page, request, context);
	await page.getByRole("button", { name: "New agent" }).click();
	await expect(page).toHaveURL(/#\/new$/);
	const d = draft(page);
	await expect(d.getByRole("heading", { level: 1 })).toContainText(
		/on\s*studio\s*to start/,
	);
	// The machine's most recent project is picked; harnesses carry marks.
	await expect(page.getByTestId("launch-project")).toHaveAccessibleName(
		/^Project: /,
	);
	await page.getByTestId("launch-harness").click();
	await expect(
		page.getByRole("option", { name: /omp.*Not found on studio/ }),
	).toBeVisible();
	await page.getByRole("option", { name: /Codex/ }).click();
	await expect(page.getByTestId("launch-harness")).toHaveAccessibleName(
		"Harness: Codex",
	);

	// A new worktree from a base branch.
	await page.getByTestId("launch-workspace").click();
	await page.getByRole("option", { name: "New worktree" }).click();
	await expect(page.getByTestId("launch-base")).toHaveAccessibleName(
		"Base branch: main",
	);
	await page.getByTestId("launch-base").click();
	await page
		.getByRole("searchbox", { name: "Search branches..." })
		.fill("release");
	await page.getByRole("option", { name: "release/2.0" }).click();

	// A folder that isn't a repo: Send says why.
	await usePath(page, "~/plain-folder");
	await expect(page.getByTestId("launch-why")).toHaveText(
		"That folder isn't a git repo. Use Current checkout.",
	);
	await expect(
		page.getByRole("button", { name: "Start agent" }),
	).toBeDisabled();
	await page.getByTestId("launch-workspace").click();
	await page.getByRole("option", { name: "Current checkout" }).click();
	await expect(page.getByTestId("launch-why")).toHaveCount(0);

	await d
		.getByRole("textbox", { name: "First message" })
		.fill("fix the login bug");
	await page.getByRole("button", { name: "Start agent" }).click();
	await proveInSheet(page);
	// Progress replaces Send in place; the steps show over the composer.
	await expect(d.getByRole("status")).toContainText(
		/Starting Codex…|Waiting for Codex…/,
	);
	await expect(d.locator(".ld-shimmer")).toBeVisible();
	// Up: its session replaces the draft.
	await expect(page).toHaveURL(/#\/a\/codex%3A/, { timeout: 15_000 });
	await expect(page.locator(".d-session-head")).toContainText(
		"codex@plain-folder",
	);
});

test("a folder-trust dialog shows Waiting in the terminal until answered there", async ({
	page,
	request,
	context,
}) => {
	await open(page);
	await withPasskey(page, request, context);
	await page.keyboard.press("ControlOrMeta+Alt+KeyN");
	await expect(page).toHaveURL(/#\/new$/);
	await usePath(page, "~/Projects/trust-me");
	await page.getByRole("button", { name: "Start agent" }).click();
	await proveInSheet(page);
	const d = draft(page);
	await expect(
		d.locator(".ds-status-text", { hasText: "Waiting in the terminal" }),
	).toBeVisible({
		timeout: 10_000,
	});
	await expect(d).toContainText(
		"folder trust is open in the new terminal on studio",
	);
	await expect(d.getByText(/tmux attach -t pulsar-/)).toBeVisible();
	await request.post("/api/v1/__mock/launch/answer", {
		headers: { "X-Pulsar": "1" },
	});
	await expect(page).toHaveURL(/#\/a\//, { timeout: 15_000 });
});

test("a failed start says why and keeps the message for another try", async ({
	page,
	request,
	context,
}) => {
	await open(page, "#/new");
	await withPasskey(page, request, context);
	await usePath(page, "~/Projects/will-fail");
	const box = draft(page).getByRole("textbox", { name: "First message" });
	await box.fill("hello there");
	await page.getByRole("button", { name: "Start agent" }).click();
	await proveInSheet(page);
	await expect(draft(page).getByRole("alert")).toContainText(
		"Claude Code exited: command not found",
		{ timeout: 10_000 },
	);
	await expect(box).toHaveValue("hello there");
	await expect(page.getByRole("button", { name: "Start agent" })).toBeEnabled();
});

test("another machine: its own passkey check, no Prove Human sheet", async ({
	page,
	request,
	context,
}) => {
	await open(page, "#/new");
	await withPasskey(page, request, context);
	// A project's link from another machine (its tree row, a menu).
	await page.evaluate(() => {
		location.hash = "#/new?machine=desk";
	});
	await expect(page.getByTestId("launch-machine")).toHaveAccessibleName(
		"Machine: desk",
	);
	await expect(page.getByTestId("launch-project")).toHaveAccessibleName(
		/^Project: \w/,
	);
	await page.getByRole("button", { name: "Start agent" }).click();
	await expect(page).toHaveURL(/#\/a\//, { timeout: 15_000 });
	await expect(page.getByRole("dialog", { name: "Prove Human" })).toHaveCount(
		0,
	);
	await expect(page.locator(".d-session-head")).toContainText("desk");
});

test("Cmd-K and a project's menu open the draft", async ({ page }) => {
	await open(page);
	await page.getByRole("button", { name: "Search", exact: true }).click();
	const list = page.getByRole("listbox", { name: "Results" });
	await page.getByRole("textbox", { name: "Search" }).fill("new agent");
	await list.getByRole("option", { name: "New agent", exact: true }).click();
	await expect(page).toHaveURL(/#\/new$/);

	await page.getByRole("button", { name: "Search", exact: true }).click();
	await page.getByRole("textbox", { name: "Search" }).fill("atlas");
	await list.getByRole("option", { name: "New agent in atlas" }).click();
	await expect(page.getByTestId("launch-project")).toHaveAccessibleName(
		"Project: atlas",
	);

	await page.goto(`${localhostBase()}/`);
	const row = page.locator('[data-node*="billing"]').first();
	await row.click({ button: "right" });
	await page.getByRole("menuitem", { name: "New agent in billing" }).click();
	await expect(page.getByTestId("launch-project")).toHaveAccessibleName(
		"Project: billing",
	);
});
