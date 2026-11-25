import type { Locator, Page } from "@playwright/test";
import type { Hello } from "../src/api/types.ts";
import { agentId, expect, test } from "./fixtures.ts";

/**
 * Skeletons match the loaded layout to the pixel: the desktop shell drawn
 * before the pool answers (ShellSkeleton) has the same boxes as the real
 * sidebar chrome and tree rows, within 1 px.
 */

type Box = { x: number; y: number; width: number; height: number };

async function boxes(l: Locator, n?: number): Promise<Box[]> {
	const all = await l.evaluateAll((els) =>
		els.map((e) => {
			const r = e.getBoundingClientRect();
			return { x: r.x, y: r.y, width: r.width, height: r.height };
		}),
	);
	return n === undefined ? all : all.slice(0, n);
}

function near(a: Box[], b: Box[], what: string) {
	expect(a.length, `${what}: count`).toBe(b.length);
	a.forEach((x, i) => {
		const y = b[i]!;
		for (const k of ["x", "y", "width", "height"] as const)
			expect(
				Math.abs(x[k] - y[k]),
				`${what} #${i} ${k}: skeleton ${x[k]} vs loaded ${y[k]}`,
			).toBeLessThanOrEqual(1);
	});
}

async function measure(page: Page) {
	return {
		logo: await boxes(page.locator(".d-brand img")),
		name: await boxes(page.locator(".d-brand-name")),
		nav: await boxes(page.locator(".d-nav .d-nav-item")),
		filter: await boxes(page.locator(".d-filter-wrap .d-input")),
		foot: await boxes(page.locator(".d-side-foot")),
		tree: await boxes(page.locator(".d-side .tree")),
	};
}

test.describe("desktop skeletons", () => {
	for (const hosted of [true, false]) {
		test(`the shell skeleton matches the loaded sidebar within 1 px (${hosted ? "with Hosted" : "without Hosted"})`, async ({
			page,
		}) => {
			// Nothing waits on you, and no stream adds rows mid-measure.
			await page.route("**/api/v1/attention**", (r) =>
				r.fulfill({ json: { items: [], total: 0 } }),
			);
			await page.route("**/api/v1/events**", (r) =>
				r.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
			);
			// Hold hello: the skeleton stays up until we let it through.
			let release!: () => void;
			const held = new Promise<void>((res) => {
				release = res;
			});
			await page.route("**/api/v1/hello", async (r) => {
				await held;
				const response = await r.fetch();
				const hello: Hello = await response.json();
				hello.features = hello.features.filter(
					(feature) => feature !== "hosted",
				);
				if (hosted) hello.features.push("hosted");
				await r.fulfill({ response, json: hello });
			});
			await page.goto("/");
			const skel = page.locator('.d-app[aria-busy="true"]');
			await expect(skel).toBeVisible();
			const before = await measure(page);
			const placeholders = await boxes(page.locator(".d-brand .d-skel-slot"));
			const skelRows = await boxes(
				page.locator(".d-side .vrow .d-skel-row"),
				6,
			);
			const skelIcon = await boxes(
				page.locator(".d-side .d-skel-row .d-skel-ico"),
				1,
			);

			release();
			await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
			await expect(skel).toHaveCount(0);
			const after = await measure(page);
			const controls = page.locator(".d-brand button");
			expect(
				await controls.evaluateAll((items) =>
					items.map((item) => item.getAttribute("aria-label")),
				),
			).toEqual([
				...(hosted ? ["Hosted agents"] : []),
				"New agent",
				"Usage",
				"Open on phone",
			]);
			const controlBoxes = await boxes(controls);
			expect(controlBoxes.length).toBe(placeholders.length - (hosted ? 0 : 1));
			near(
				placeholders.slice(-controlBoxes.length),
				controlBoxes,
				"header controls",
			);
			for (const k of Object.keys(before) as (keyof typeof before)[])
				near(before[k], after[k], k);
			const rows = await boxes(page.locator(".d-side .vrow .d-row.node"), 6);
			near(skelRows, rows, "tree row");
			near(
				skelIcon,
				await boxes(page.locator('[data-node="m:studio"] .d-ico')),
				"row icon",
			);
		});
	}

	test("tree placeholder rows have the loaded rows' boxes", async ({
		page,
	}) => {
		await page.route("**/api/v1/attention**", (r) =>
			r.fulfill({ json: { items: [], total: 0 } }),
		);
		await page.route("**/api/v1/events**", (r) =>
			r.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
		);
		let release!: () => void;
		const held = new Promise<void>((res) => {
			release = res;
		});
		// Hold the tree's first page: the sidebar shows placeholder rows.
		await page.route("**/api/v1/tree?**", async (r) => {
			await held;
			await r.continue();
		});
		await page.goto("/");
		await expect(page.locator(".d-side .d-skel-row").first()).toBeVisible();
		const skelRows = await boxes(page.locator(".d-side .vrow .d-skel-row"), 6);
		const skelIcon = await boxes(
			page.locator(".d-side .d-skel-row .d-skel-ico"),
			1,
		);
		release();
		await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
		near(
			skelRows,
			await boxes(page.locator(".d-side .vrow .d-row.node"), 6),
			"tree row",
		);
		near(
			skelIcon,
			await boxes(page.locator('[data-node="m:studio"] .d-ico')),
			"row icon",
		);
	});

	test("the session header skeleton matches the loaded header within 1 px", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		let release!: () => void;
		const held = new Promise<void>((res) => {
			release = res;
		});
		// Hold the session chunk: the header skeleton shows meanwhile.
		await page.route(/\/_app\/SessionDesktop\.[^/]+\.js$/, async (r) => {
			await held;
			await r.continue();
		});
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const head = page.locator(".d-session-head");
		await expect(head).toHaveAttribute("aria-busy", "true");
		const skelHead = await boxes(head);
		const skelAvatar = await boxes(
			page.locator(".d-session-head .d-sh-avatar-skel"),
		);
		release();
		await expect(page.locator(".session-header h1")).toHaveText(
			"apparish-auth",
		);
		near(skelHead, await boxes(page.locator(".d-session-head")), "header");
		near(
			skelAvatar,
			await boxes(page.locator(".d-session-head .ds-avatar")),
			"avatar",
		);
	});

	test("the home skeleton matches the loaded home page within 1 px", async ({
		page,
	}) => {
		let release!: () => void;
		const held = new Promise<void>((res) => {
			release = res;
		});
		await page.route("**/api/v1/hello", async (r) => {
			await held;
			await r.continue();
		});
		await page.goto("/");
		await expect(page.locator('.d-app[aria-busy="true"]')).toBeVisible();
		const main = async () => ({
			head: await boxes(page.locator(".d-main .d-page-head")),
			blockHead: await boxes(page.locator(".d-main .d-block-head"), 1),
			rows: await boxes(page.locator(".d-main .d-card"), 1).then(async (c) => [
				...c,
				...(await boxes(page.locator(".d-main .d-card > li"), 4)),
			]),
		});
		const before = await main();
		release();
		await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
		await expect(page.locator(".d-main .d-card > li")).toHaveCount(4 + 6);
		const after = await main();
		for (const k of Object.keys(before) as (keyof typeof before)[])
			near(before[k], after[k], `home ${k}`);
	});
});
