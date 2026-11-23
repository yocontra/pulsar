import type { Locator, Page } from "@playwright/test";
import { expectIonicStyledUnderCsp } from "./csp-phone.ts";
import {
	agentId,
	expect,
	localhostBase,
	ready,
	resetPasskeys,
	test,
} from "./fixtures.ts";
import { softAuthenticator } from "./soft-webauthn.ts";

/**
 * iPhone gestures in WebKit. Playwright can't synthesize multi-step touches,
 * and WebKit's Touch constructor is closed, so these dispatch touch events
 * whose `touches` carry the points (what the gesture code reads).
 */
type Pt = { x: number; y: number };
/** ion-item-sliding methods the tests call. */
type Sliding = {
	getOpenAmount(): Promise<number>;
	closeOpened(): Promise<boolean>;
};

async function touch(page: Page, type: string, p: Pt) {
	await page.evaluate(
		([type, x, y]) => {
			const w = window as unknown as { __touchTarget?: Element };
			if (type === "touchstart")
				w.__touchTarget = document.elementFromPoint(x, y) ?? document.body;
			const target = w.__touchTarget ?? document.body;
			const t = {
				identifier: 1,
				target,
				clientX: x,
				clientY: y,
				pageX: x,
				pageY: y,
			};
			const e = new Event(type, { bubbles: true, cancelable: true });
			Object.defineProperty(e, "touches", {
				value: type === "touchend" ? [] : [t],
			});
			Object.defineProperty(e, "changedTouches", { value: [t] });
			target.dispatchEvent(e);
		},
		[type, p.x, p.y] as const,
	);
}

/** A drag in `steps` moves, `ms` apart; then lift (and the tap's click). */
async function drag(
	page: Page,
	from: Pt,
	to: Pt,
	{ steps = 10, ms = 16, click = false } = {},
) {
	await touch(page, "touchstart", from);
	for (let i = 1; i <= steps; i++) {
		await touch(page, "touchmove", {
			x: from.x + ((to.x - from.x) * i) / steps,
			y: from.y + ((to.y - from.y) * i) / steps,
		});
		await page.waitForTimeout(ms);
	}
	await touch(page, "touchend", to);
	// `click`: a stray click where the touch started, which a gesture must eat.
	if (click) await page.mouse.click(from.x, from.y);
}

/** Home is up and the lazy Ionic pieces (swipe actions) are in. */
async function home(page: Page) {
	await ready(page);
	await expect(page.locator("ion-item-sliding").first()).toBeAttached();
	// The Safari-tab install tip takes a third of this short viewport.
	const tip = page.getByRole("button", { name: "Dismiss tip" });
	if (await tip.count()) await tip.tap();
}

async function center(l: Locator): Promise<Pt> {
	const b = (await l.boundingBox())!;
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** The center of the part of `l` that shows inside `view`. */
async function visibleCenter(l: Locator, view: Locator): Promise<Pt> {
	const b = (await l.boundingBox())!;
	const v = (await view.boundingBox())!;
	const top = Math.max(b.y, v.y);
	const bottom = Math.min(b.y + b.height, v.y + v.height);
	return { x: b.x + b.width / 2, y: (top + bottom) / 2 };
}

const node = (page: Page, id: string) =>
	page.locator(`[data-tree-node="${id}"]`);
const title = (page: Page) => page.locator(".p-nav-title h1");

async function openSession(page: Page) {
	await home(page);
	await node(page, "m:studio/p:apparish").locator("ion-item").tap();
	await page
		.locator("[data-tree-node] ion-item[data-agent]", {
			hasText: "codex@apparish",
		})
		.first()
		.tap();
	await expect(title(page)).toHaveText("codex@apparish");
	await expect(page.getByRole("button", { name: "Back" }).last()).toBeVisible();
	// The push transition.
	await page.waitForTimeout(700);
}

test.describe("ios gestures", () => {
	test("Ionic is styled under the strict CSP (WebKit)", async ({ page }) => {
		await home(page);
		await expectIonicStyledUnderCsp(page);
	});

	test("edge swipe-back pops; a short swipe springs back", async ({ page }) => {
		await openSession(page);
		const y = 420;
		await drag(page, { x: 4, y }, { x: 60, y }, { steps: 12, ms: 30 });
		await page.waitForTimeout(800);
		await expect(title(page)).toBeVisible();
		await expect(page).toHaveURL(/#\/a\//);

		await drag(page, { x: 4, y }, { x: 320, y }, { steps: 12, ms: 20 });
		await expect(page).not.toHaveURL(/#\/a\//);
		await expect(title(page)).toHaveCount(0);
		await expect(node(page, "m:studio")).toBeVisible();
		// History followed: forward returns to the conversation.
		await page.goForward();
		await expect(title(page)).toHaveText("codex@apparish");
	});

	test("swipe actions: Open and Stop trail", async ({ page }) => {
		await home(page);
		await node(page, "m:studio/p:apparish").locator("ion-item").tap();
		const row = page
			.locator("[data-tree-node] ion-item[data-agent]", {
				hasText: "codex@apparish",
			})
			.first();
		const c = await center(row);
		const sliding = row.locator("xpath=ancestor::ion-item-sliding");
		const open = () =>
			sliding.evaluate((e) => (e as unknown as Sliding).getOpenAmount());
		// Swipe left: the trailing actions (Open, Stop).
		await drag(
			page,
			{ x: 330, y: c.y },
			{ x: 150, y: c.y },
			{ steps: 14, ms: 20 },
		);
		await expect.poll(open).toBeGreaterThan(0);
		await expect(
			sliding.locator("ion-item-option", { hasText: "Open" }),
		).toBeVisible();
	});

	test("swipe actions: Pin leads", async ({ page }) => {
		await home(page);
		await node(page, "m:studio/p:apparish").locator("ion-item").tap();
		const row2 = page
			.locator("[data-tree-node] ion-item[data-agent]", {
				hasText: "codex@apparish",
			})
			.first();
		const s2 = row2.locator("xpath=ancestor::ion-item-sliding");
		const open2 = () =>
			s2.evaluate((e) => (e as unknown as Sliding).getOpenAmount());
		const d = await center(row2);
		// Swipe right: the leading Pin action.
		await drag(page, { x: 30, y: d.y }, { x: 140, y: d.y });
		await expect.poll(open2).toBeLessThan(0);
		await s2.locator("ion-item-option", { hasText: "Pin" }).tap();
		await expect(
			page.locator(".p-section h2", { hasText: "Pinned" }),
		).toBeVisible();
	});

	test("long-press a message: Copy in an action sheet, no copy row", async ({
		page,
	}) => {
		await openSession(page);
		await expect(page.locator(".p-agent .ds-msg-actions")).toHaveCount(0);
		// The agent is working: the mock streams new turns into the
		// conversation. Press the text of the latest turn that has some (a
		// turn that just started has none yet, so it has nothing to copy),
		// at the part of it on screen (a long turn is taller than the screen).
		const msg = page.locator(".p-agent .ds-turn--assistant .ds-parts p").last();
		await expect(msg).toBeVisible();
		await msg.scrollIntoViewIfNeeded();
		const c = await visibleCenter(
			msg,
			page.locator(".p-agent .ds-scroller").first(),
		);
		await touch(page, "touchstart", c);
		await page.waitForTimeout(650);
		await touch(page, "touchend", c);
		const sheet = page.getByTestId("actions");
		await expect(sheet.getByRole("button", { name: "Copy" })).toBeVisible();
		await sheet.getByRole("button", { name: "Cancel" }).tap();
		await expect(sheet).toHaveCount(0);
	});

	test("long-press opens an action sheet; Cancel closes it", async ({
		page,
	}) => {
		await home(page);
		const studio = node(page, "m:studio").locator("ion-item");
		const c = await center(studio);
		await touch(page, "touchstart", c);
		await page.waitForTimeout(650);
		await touch(page, "touchend", c);
		const sheet = page.getByTestId("actions");
		await expect(sheet).toBeVisible();
		await expect(sheet).toContainText("Message Everyone on studio");
		// The lift's click didn't toggle the row.
		await expect(node(page, "m:studio")).toHaveAttribute(
			"data-expanded",
			"true",
		);
		await sheet.getByRole("button", { name: "Cancel" }).tap();
		await expect(sheet).toHaveCount(0);
	});

	test("no pull to refresh: the tree is live, a pull down reads nothing", async ({
		page,
	}) => {
		await home(page);
		await expect(page.locator("ion-refresher")).toHaveCount(0);
		let trees = 0;
		page.on("request", (r) => {
			if (/\/api\/v1\/tree\b/.test(r.url())) trees++;
		});
		await drag(
			page,
			{ x: 190, y: 230 },
			{ x: 190, y: 560 },
			{ steps: 20, ms: 30 },
		);
		await page.waitForTimeout(1500);
		expect(trees).toBe(0);
	});

	test("sheet: the group composer opens at the medium detent and drags to large", async ({
		page,
	}) => {
		await home(page);
		await page.goto("/#/n/m%3Astudio");
		const modal = page.locator("ion-modal");
		await expect(
			modal.getByRole("heading", { name: "Everyone on studio" }),
		).toBeVisible();
		await page.waitForTimeout(600);
		const top = () =>
			modal.evaluate(
				(m) =>
					m.shadowRoot!.querySelector(".modal-wrapper")!.getBoundingClientRect()
						.top,
			);
		const before = await top();
		// Drag the grabber up (mouse: Ionic's sheet gesture takes both).
		await page.mouse.move(190, before + 10);
		await page.mouse.down();
		for (let i = 1; i <= 12; i++) {
			await page.mouse.move(190, before + 10 - ((before - 40) * i) / 12);
			await page.waitForTimeout(30);
		}
		await page.mouse.up();
		await page.waitForTimeout(700);
		expect(await top()).toBeLessThan(before - 100);
		// A fling down dismisses it and pops its route.
		const now = await top();
		await page.mouse.move(190, now + 10);
		await page.mouse.down();
		for (let i = 1; i <= 5; i++) {
			await page.mouse.move(190, now + 10 + ((790 - now) * i) / 5);
			await page.waitForTimeout(10);
		}
		await page.mouse.up();
		await expect(modal).toHaveCount(0);
		await expect(page).not.toHaveURL(/#\/n\//);
	});

	test("an approval opens inline in its agent's conversation (no sheet to swipe away)", async ({
		page,
	}) => {
		await home(page);
		await page.getByTestId("needs-summary").tap();
		await page
			.locator(".p-needs ion-item.p-attn", { hasText: "apparish-auth" })
			.first()
			.tap();
		await expect(title(page)).toHaveText("apparish-auth");
		await expect(
			page.locator(".prompt-inline .approval-card"),
		).toBeInViewport();
		await expect(page.locator("ion-modal")).toHaveCount(0);
	});

	test("Prove Human in WebKit: an unproven approve registers a passkey here, then the answer goes on", async ({
		page,
		request,
	}) => {
		// Linux WebKit (CI) has no WebAuthn at all.
		test.skip(process.platform === "linux", "no WebAuthn in Linux WebKit");
		await resetPasskeys(request);
		await softAuthenticator(page);
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`${localhostBase()}/#/approval/${encodeURIComponent(id)}`);
		const card = page.locator(".prompt-inline .approval-card");
		await expect(card).toContainText("apparish-auth");
		await card.getByRole("button", { name: /^Allow once( · Face ID)?$/ }).tap();
		const prove = page.getByRole("dialog", { name: "Prove Human" });
		await expect(prove).toContainText("To answer this prompt");
		await prove.getByRole("button", { name: "Prove with passkey" }).tap();
		await expect(prove).toHaveCount(0);
		await expect(page.locator(".prompt-outcome")).toContainText(
			/Allowed once by You · .+ on .+ · \d/,
		);
	});
});

test.describe("skeletons", () => {
	test("Home's skeleton lands on the loaded layout's pixels", async ({
		page,
	}) => {
		// Pixel-matched to Apple's fonts; Linux fonts wrap rows differently.
		test.skip(process.platform === "linux", "tuned to Apple's fonts");
		// Nothing needs you (the first section is Machines either way), and the
		// tree waits until the skeleton is measured.
		await page.route("**/api/v1/attention**", (r) =>
			r.fulfill({ json: { items: [], total: 0 } }),
		);
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		await page.route(/\/api\/v1\/tree(\?|$)/, async (r) => {
			await held;
			await r.continue();
		});
		await page.goto("/");
		const box = async (sel: string, i = 0) => {
			const b = await page.locator(sel).nth(i).boundingBox();
			if (!b) throw new Error(`no box for ${sel} #${i}`);
			return b;
		};
		await expect(page.locator("[data-sk=row]").first()).toBeVisible();
		// The lazy search field and segmented control are in.
		await expect(page.getByTestId("home-search")).toBeVisible();
		await page.waitForTimeout(300);
		const sk = {
			head: await box("[data-sk=section] h2"),
			rows: await Promise.all([0, 1, 2].map((i) => box("[data-sk=row]", i))),
			lead: await box("[data-sk=row] [data-sk=lead]"),
			title: await box("[data-sk=row] [data-sk=title]"),
		};
		release();
		// Needs-you may arrive on the event stream: compare against the
		// Machines section wherever it lands, and rows relative to it.
		const machinesHeader = async () => {
			const hs = await page.locator(".p-vrow.is-section h2").allTextContents();
			return Math.max(0, hs.indexOf("Machines"));
		};
		await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
		await page.waitForTimeout(300);
		const real = {
			head: await box(".p-vrow.is-section h2", await machinesHeader()),
			rows: await Promise.all([0, 1, 2].map((i) => box(".p-vrow.is-node", i))),
			lead: await box(".p-vrow.is-node [data-sk=lead]"),
			title: await box(".p-vrow.is-node [data-sk=title]"),
		};
		const near = (a: number, b: number, what: string) =>
			expect(
				Math.abs(a - b),
				`${what}: skeleton ${a} vs loaded ${b}`,
			).toBeLessThanOrEqual(1);
		const dy = real.head.y - sk.head.y; // 0 unless needs-you landed above
		for (const k of ["x", "width", "height"] as const)
			near(sk.head[k], real.head[k], `section header ${k}`);
		sk.rows.forEach((r, i) => {
			for (const k of ["x", "width", "height"] as const)
				near(r[k], real.rows[i]![k], `row ${i} ${k}`);
			near(r.y + dy, real.rows[i]!.y, `row ${i} y`);
		});
		for (const k of ["x", "width", "height"] as const)
			near(sk.lead[k], real.lead[k], `row icon ${k}`);
		near(sk.lead.y + dy, real.lead.y, "row icon y");
		for (const k of ["x", "height"] as const)
			near(sk.title[k], real.title[k], `row title ${k}`);
		near(sk.title.y + dy, real.title.y, "row title y");
	});
});
