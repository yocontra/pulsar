import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { openAgent } from "./composer.shared.ts";
import { expect, test } from "./fixtures.ts";

/**
 * An open app moves to the build its daemon serves (src/data/update.ts):
 * the mock serves a staged copy of dist/web with a new build id and drops
 * its event streams (a daemon upgrade and restart). Shared by
 * update.desktop.e2e.ts and update.ios.e2e.ts; the service worker path is
 * in load.e2e.ts.
 */

const DIST = resolve(import.meta.dirname, "../../dist/web");
const H = { "X-Pulsar": "1" };
const META = /<meta name="pulsar-build" content="([0-9a-f]+)">/;
const DRAFT = "half a thought, not sent yet";

/** dist/web with another build id in index.html (same asset files). */
function stageBuild(staged: string[]) {
	const root = mkdtempSync(join(tmpdir(), "pulsar-update-"));
	staged.push(root);
	cpSync(DIST, root, { recursive: true });
	for (const f of ["index.html.br", "index.html.gz"])
		rmSync(join(root, f), { force: true });
	const html = readFileSync(join(root, "index.html"), "utf8");
	const old = META.exec(html)![1]!;
	const build = `${old.slice(0, 6)}${Math.random().toString(16).slice(2, 8)}`;
	writeFileSync(join(root, "index.html"), html.replace(old, build));
	return { root, build };
}

/** A daemon upgrade: serve `body` and restart (every stream drops). */
async function deploy(
	request: APIRequestContext,
	body: { root?: string; webBuild?: string },
) {
	expect(
		(
			await request.post("/api/v1/__mock/static", { headers: H, data: body })
		).ok(),
	).toBe(true);
	expect(
		(await request.post("/api/v1/__mock/restart", { headers: H })).ok(),
	).toBe(true);
}

// Both answer null while a reload is under way (a poll asks again).
const ownBuild = (page: Page) =>
	page
		.evaluate(() =>
			document
				.querySelector('meta[name="pulsar-build"]')
				?.getAttribute("content"),
		)
		.catch(() => null);
/** Set before an update; a reload clears it. */
const mark = (page: Page) =>
	page.evaluate(() => {
		(window as { __beforeUpdate?: boolean }).__beforeUpdate = true;
	});
const marked = (page: Page) =>
	page
		.evaluate(
			() => (window as { __beforeUpdate?: boolean }).__beforeUpdate === true,
		)
		.catch(() => null);
const updateToast = (page: Page) =>
	page.locator("[data-sonner-toast]", { hasText: "Pulsar updated" });

export function updateSuite(platform: "desktop" | "phone") {
	const phone = platform === "phone";
	const staged: string[] = [];
	test.afterEach(async ({ request }) => {
		await request.post("/api/v1/__mock/static", { headers: H, data: {} });
		for (const dir of staged.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	test(`an idle app reloads into the new build and keeps the route and draft (${platform})`, async ({
		page,
		request,
	}) => {
		const composer = await openAgent(page, request, "name=apparish-auth");
		const input = composer.locator(".composer-input");
		await input.fill(DRAFT);
		await input.blur();
		const route = new URL(page.url()).hash;
		const next = stageBuild(staged);
		await mark(page);
		// Past the typing window (4 s): the page is idle.
		await page.waitForTimeout(4_500);
		await deploy(request, { root: next.root });

		await expect.poll(() => marked(page), { timeout: 20_000 }).toBe(false);
		await expect.poll(() => ownBuild(page)).toBe(next.build);
		expect(new URL(page.url()).hash).toBe(route);
		await expect(
			page.locator(".composer").last().locator(".composer-input"),
		).toHaveValue(DRAFT);
		await expect(updateToast(page)).toHaveCount(0);
	});

	test(`while typing it offers Reload instead, and the tap reloads (${platform})`, async ({
		page,
		request,
	}) => {
		const composer = await openAgent(page, request, "name=apparish-auth");
		const input = composer.locator(".composer-input");
		await input.fill("still typ");
		const next = stageBuild(staged);
		await mark(page);
		await deploy(request, { root: next.root });
		// Keep typing until the toast shows: a reload now would interrupt.
		const toastShown = updateToast(page);
		for (let i = 0; i < 40 && !(await toastShown.isVisible()); i++) {
			await input.press("i");
			await page.waitForTimeout(500);
		}
		await expect(toastShown).toBeVisible();
		expect(await marked(page)).toBe(true);
		const typed = await input.inputValue();

		const reload = toastShown.getByRole("button", { name: "Reload" });
		if (phone) await reload.tap();
		else await reload.click();
		await expect.poll(() => marked(page), { timeout: 20_000 }).toBe(false);
		await expect.poll(() => ownBuild(page)).toBe(next.build);
		await expect(
			page.locator(".composer").last().locator(".composer-input"),
		).toHaveValue(typed);
	});

	test(`after typing stops, the update applies by itself (${platform})`, async ({
		page,
		request,
	}) => {
		const composer = await openAgent(page, request, "name=apparish-auth");
		const input = composer.locator(".composer-input");
		await input.fill("typed just now");
		const next = stageBuild(staged);
		await mark(page);
		await deploy(request, { root: next.root });
		await input.press("!");
		await expect(updateToast(page)).toBeVisible({ timeout: 20_000 });
		// No tap: the next quiet moment (typing window past) reloads.
		await expect.poll(() => marked(page), { timeout: 20_000 }).toBe(false);
		await expect.poll(() => ownBuild(page)).toBe(next.build);
		await expect(
			page.locator(".composer").last().locator(".composer-input"),
		).toHaveValue("typed just now!");
	});

	test(`a build the reload can't reach shows the toast, with no reload loop (${platform})`, async ({
		page,
		request,
	}) => {
		await openAgent(page, request, "name=apparish-auth");
		let loads = 0;
		page.on("load", () => loads++);
		await mark(page);
		await page.waitForTimeout(4_500);
		// /hello reports a build the server's HTML never has.
		await deploy(request, { webBuild: "0123456789ab" });

		await expect.poll(() => marked(page), { timeout: 20_000 }).toBe(false);
		await expect(updateToast(page)).toBeVisible({ timeout: 20_000 });
		await mark(page);
		// Past the next quiet-moment retry (5 s): no second reload.
		await page.waitForTimeout(7_000);
		expect(await marked(page)).toBe(true);
		expect(loads).toBe(1);
		await expect(updateToast(page)).toBeVisible();
	});

	test(`an older daemon without a build id changes nothing (${platform})`, async ({
		page,
		request,
	}) => {
		await openAgent(page, request, "name=apparish-auth");
		await mark(page);
		await page.waitForTimeout(4_500);
		// The stream reconnects and /hello is asked again.
		const asked = page.waitForResponse((r) =>
			r.url().endsWith("/api/v1/hello"),
		);
		await deploy(request, { webBuild: "none" });
		await asked;
		await page.waitForTimeout(1_000);
		expect(await marked(page)).toBe(true);
		await expect(updateToast(page)).toHaveCount(0);
	});
}
