import type { APIRequestContext, Page } from "@playwright/test";
import { expect, ready, test } from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

/**
 * Diagnostics (web/src/features/diagnostics): the pool from
 * `GET /diagnostics`, then each machine's doctor checks from
 * `GET /diagnostics/:id` as they arrive (web/mock/diagnostics.ts), grouped, with
 * fixes, machine facts and version skew; opened from Settings and Cmd-K.
 * It checks again on its own (live.shared.ts covers that). Shared by
 * diagnostics.desktop.e2e.ts and diagnostics.phone.e2e.ts.
 */

/** The visible page: the phone's top Ionic page, or the desktop's main area. */
const view = (page: Page, phone: boolean) =>
	phone
		? page.locator("ion-nav > .ion-page:not(.ion-page-hidden)").last()
		: page.getByRole("main", { name: "Diagnostics" });

async function knobs(request: APIRequestContext, body: object) {
	const res = await request.post("/api/v1/__mock/diagnostics", {
		headers: { "X-Pulsar": "1" },
		data: body,
	});
	expect(res.ok()).toBe(true);
}

export function diagnosticsSuite(platform: "desktop" | "phone") {
	const phone = platform === "phone";

	// A worker's mock keeps the app load reports earlier tests sent (some
	// fail a chunk on purpose), and doctor shows them as a note on studio:
	// start from none.
	test.beforeEach(async ({ request }) => {
		const res = await request.post("/api/v1/__mock/client-errors", {
			headers: { "X-Pulsar": "1" },
		});
		expect(res.ok()).toBe(true);
	});

	test.afterEach(async ({ request }) => {
		await knobs(request, { reset: true });
	});

	test(`app load errors the devices reported show as a note on this machine (${platform})`, async ({
		page,
		request,
	}) => {
		const H = { "X-Pulsar": "1" };
		await request.post("/api/v1/__mock/client-errors", { headers: H });
		const report = {
			kind: "chunk",
			build: "abc123def456",
			urls: ["/_app/UsageView.Bx3k.js"],
			error: {
				name: "TypeError",
				message: "Importing a module script failed.",
			},
			sw: {
				controller: "abc123def456",
				state: "active",
				caches: [],
				failed: [],
			},
			online: true,
			standalone: true,
			ua: "iPhone",
			route: "/usage",
			reloaded: false,
			at: Date.now(),
		};
		for (let i = 0; i < 2; i++)
			expect(
				(
					await request.post("/api/v1/client-errors", {
						headers: H,
						data: report,
					})
				).status(),
			).toBe(204);
		try {
			await ready(page);
			await page.evaluate(() => {
				location.hash = "#/diagnostics";
			});
			const studio = view(page, phone).locator('[data-machine="studio"]');
			await expect(studio.locator(".diag-health")).toHaveText("2 notes");
			await expect(studio).toContainText(
				"recent app load errors: 2 report(s); by build: abc123def456: 2; by file: /_app/UsageView.Bx3k.js: 2",
			);
		} finally {
			await request.post("/api/v1/__mock/client-errors", { headers: H });
		}
	});

	test(`this machine shows at once; each peer as it answers, or why it timed out (${platform})`, async ({
		page,
		request,
	}) => {
		await knobs(request, { hold: { "mbp-a": 2500 }, timeout: ["mbp-a"] });
		await ready(page);
		await page.evaluate(() => {
			location.hash = "#/diagnostics";
		});
		const v = view(page, phone);
		const studio = v.locator('[data-machine="studio"]');
		const mbp = v.locator('[data-machine="mbp-a"]');
		await expect(studio.locator(".diag-health")).toHaveText("1 note");
		// mbp-a is still being asked: a Checking… row in its place.
		await expect(mbp.getByRole("status")).toHaveText("Checking…");
		await expect(mbp.locator(".diag-check")).toHaveCount(0);
		await expect(v.locator('[data-machine="desk"] .diag-error')).toContainText(
			"upgrade pulsar on desk to see its checks",
		);
		// Then it says why it has no report.
		await expect(mbp.locator(".diag-error")).toContainText(
			"mbp-a did not answer within 35 s",
			{ timeout: 10_000 },
		);
		await expect(mbp.locator(".diag-health")).toHaveText("No report");
		await expect(mbp.getByRole("status")).toHaveCount(0);
	});

	test(`every machine's checks, fixes, facts and version skew (${platform})`, async ({
		page,
	}) => {
		await ready(page);
		await page.evaluate(() => {
			location.hash = "#/diagnostics";
		});
		const v = view(page, phone);
		const machines = v.locator(".diag-machine");
		await expect(machines).toHaveCount(4);
		await expect(machines.locator("h2")).toHaveText([
			"studioThis machine",
			"mbp-a",
			"mbp-b",
			"desk",
		]);

		// The skew notice names each machine behind the newest version.
		const skew = v.getByRole("note", { name: "Version skew" });
		await expect(skew).toContainText("newest 2.1.0");
		await expect(skew).toContainText("Upgrade pulsar on mbp-a.");
		await expect(skew).toContainText("Upgrade pulsar on desk.");

		const studio = v.locator('[data-machine="studio"]');
		await expect(studio.locator(".diag-health")).toHaveText("1 note");
		await expect(studio.locator(".diag-facts")).toContainText("Uptime3d 4h");
		await expect(studio.locator(".diag-facts")).toContainText(
			"TailscaleRunning · 1.104.7",
		);
		await expect(studio.locator(".diag-facts")).toContainText(
			"CertificateExpires in 71 days",
		);
		await expect(studio.locator(".diag-facts")).toContainText(
			"Claude Code2.1.328",
		);
		// The checks that passed fold into one row; open it to see them.
		await studio.getByRole("button", { name: "10 checks passed" }).click();
		await expect(studio.getByRole("heading", { level: 3 })).toHaveText([
			"Daemon",
			"Harnesses",
			"Approvals",
			"Remote access",
			"Agent mesh",
		]);

		// A problem: its level in words (not color alone) and its fix.
		const mbp = v.locator('[data-machine="mbp-a"]');
		await expect(mbp.locator(".diag-health")).toHaveText("1 problem");
		await expect(mbp.locator(".diag-upgrade")).toContainText(
			"upgrade pulsar on mbp-a (2.0.3; newest is 2.1.0)",
		);
		const bad = mbp.locator('.diag-check[data-level="bad"]');
		await expect(bad).toHaveCount(1);
		await expect(bad).toContainText("Problem: background service not loaded");
		await expect(bad.locator(".diag-fix")).toContainText("Fix: run");
		await expect(bad.locator(".diag-fix code")).toHaveText("pulsar mesh on");
		await expect(
			bad.getByRole("button", { name: "Copy pulsar mesh on" }),
		).toBeVisible();
		await expect(mbp.locator(".diag-facts")).toContainText(
			"Event loopp99 240 ms, max 1900 ms, 3 stalls",
		);
		await expect(mbp.locator(".diag-facts")).toContainText("piVersion unknown");

		// No report: asleep, or too old to answer.
		await expect(v.locator('[data-machine="mbp-b"] .diag-error')).toContainText(
			"asleep 14m",
		);
		await expect(v.locator('[data-machine="desk"] .diag-error')).toContainText(
			"upgrade pulsar on desk to see its checks",
		);
		await expect(v.locator('[data-machine="desk"] .diag-health')).toHaveText(
			"No report",
		);
		expect(await contrastFailures(page, ".diag *")).toEqual([]);
	});

	test(`no Check again button: it says when it last checked (${platform})`, async ({
		page,
	}) => {
		await ready(page);
		await page.evaluate(() => {
			location.hash = "#/diagnostics";
		});
		const v = view(page, phone);
		await expect(v.locator(".diag-machine")).toHaveCount(4);
		await expect(page.getByTestId("diag-checked")).toHaveText(
			/^Checked (now|\d+s ago)$/,
		);
		await expect(
			page.getByRole("button", { name: /check again/i }),
		).toHaveCount(0);
	});

	test(`Settings opens Diagnostics (${platform})`, async ({ page }) => {
		await ready(page);
		if (phone) {
			await page.evaluate(() => {
				location.hash = "#/settings";
			});
			const row = page.locator('[data-setting="diagnostics"]');
			await expect(row).toContainText("Check Every Machine");
			await row.tap();
		} else {
			await page.getByRole("button", { name: "Settings", exact: true }).click();
			await page
				.getByRole("navigation", { name: "Settings sections" })
				.getByRole("button", { name: "Diagnostics" })
				.click();
			const section = page.locator(
				'section[aria-labelledby="set-x-diagnostics"]',
			);
			await expect(section).toContainText("Check every machine");
			await section.getByRole("button", { name: "Open diagnostics" }).click();
		}
		await expect(page).toHaveURL(/#\/diagnostics$/);
		await expect(view(page, phone).locator(".diag-machine")).toHaveCount(4);
	});

	test(`a summary row per machine: its state, version and last check (${platform})`, async ({
		page,
	}) => {
		await ready(page);
		await page.evaluate(() => {
			location.hash = "#/diagnostics";
		});
		const v = view(page, phone);
		const rows = v.locator("[data-summary]");
		await expect(rows).toHaveCount(4);
		const studio = v.locator('[data-summary="studio"]');
		await expect(studio).toContainText("This machine");
		await expect(studio).toContainText("1 note");
		await expect(studio).toContainText(
			/Pulsar 2\.1\.0 · checked (now|\d+s ago)/,
		);
		await expect(v.locator('[data-summary="mbp-a"]')).toContainText(
			"1 problem",
		);
		await expect(v.locator('[data-summary="desk"]')).toContainText("No report");
		// A tap takes focus to that machine's section.
		await v.locator('[data-summary="desk"]').click();
		await expect(v.locator('[data-machine="desk"] h2')).toBeFocused();
		await expect(v.locator('[data-machine="desk"] h2')).toBeInViewport();
	});

	test(`problems first, then notes; passed checks fold into one row (${platform})`, async ({
		page,
	}) => {
		await ready(page);
		await page.evaluate(() => {
			location.hash = "#/diagnostics";
		});
		const v = view(page, phone);
		const mbp = v.locator('[data-machine="mbp-a"]');
		await expect(mbp.locator(".diag-health")).toHaveText("1 problem");
		// Doctor's order is note, note, bad, note: the problem comes first.
		await expect(mbp.locator(".diag-check")).toHaveCount(4);
		expect(
			await mbp
				.locator(".diag-check")
				.evaluateAll((els) => els.map((e) => e.getAttribute("data-level"))),
		).toEqual(["bad", "note", "note", "note"]);
		await expect(mbp.locator(".diag-check").first()).toContainText(
			"background service not loaded",
		);
		await expect(mbp.locator(".diag-check").nth(1)).toContainText(
			"event loop: p99 240 ms",
		);
		// Each problem names its group.
		await expect(mbp.locator(".diag-check").first()).toContainText(
			"Agent mesh",
		);

		// The passed check is folded: collapsed until opened, then shown last.
		const fold = mbp.getByRole("button", { name: "1 check passed" });
		await expect(fold).toHaveAttribute("aria-expanded", "false");
		await expect(mbp.locator('.diag-check[data-level="ok"]')).toHaveCount(0);
		await fold.click();
		await expect(fold).toHaveAttribute("aria-expanded", "true");
		const ok = mbp.locator('.diag-check[data-level="ok"]');
		await expect(ok).toHaveCount(1);
		await expect(ok).toContainText("daemon 2.0.3 running");
		await expect(mbp.locator(".diag-check").last()).toHaveAttribute(
			"data-level",
			"ok",
		);
		await fold.click();
		await expect(ok).toHaveCount(0);

		// Open, every row still meets contrast in this theme.
		await v
			.locator('[data-machine="studio"]')
			.getByRole("button", { name: "10 checks passed" })
			.click();
		await fold.click();
		expect(await contrastFailures(page, ".diag *")).toEqual([]);
		await page.emulateMedia({ colorScheme: "dark" });
		expect(await contrastFailures(page, ".diag *")).toEqual([]);
	});

	test(`a fix's command copies with one tap (${platform})`, async ({
		page,
	}) => {
		await page.addInitScript(() => {
			const w = window as unknown as { __copied: string[] };
			w.__copied = [];
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async (t: string) => {
						w.__copied.push(t);
					},
				},
			});
		});
		await ready(page);
		await page.evaluate(() => {
			location.hash = "#/diagnostics";
		});
		const v = view(page, phone);
		const mbp = v.locator('[data-machine="mbp-a"]');
		const pi = mbp.locator(".diag-check", { hasText: "pi: found" });
		await expect(pi.locator(".diag-cmd code")).toHaveText(
			"pulsar setup --client pi",
		);
		const copy = pi.getByRole("button", {
			name: "Copy pulsar setup --client pi",
		});
		await copy.click();
		await expect(copy).toContainText("Copied");
		expect(
			await page.evaluate(
				() => (window as unknown as { __copied: string[] }).__copied,
			),
		).toEqual(["pulsar setup --client pi"]);
		// Only commands get a Copy button: a check with no fix has none.
		await expect(
			mbp
				.locator(".diag-check", { hasText: "node certificate" })
				.getByRole("button"),
		).toHaveCount(0);
	});

	if (phone)
		test("nothing overflows a 320 px screen at 17 and 23 px text, passed checks open", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 320, height: 640 });
			await ready(page);
			await page.evaluate(() => {
				location.hash = "#/diagnostics";
			});
			const v = view(page, phone);
			await expect(v.locator(".diag-machine")).toHaveCount(4);
			await expect(
				v.locator('[data-machine="studio"] .diag-health'),
			).toHaveText("1 note");
			for (const name of ["10 checks passed", "1 check passed"])
				await v.getByRole("button", { name }).click();
			await expect(v.locator('.diag-check[data-level="ok"]')).toHaveCount(11);
			for (const font of [17, 23]) {
				await page.evaluate(
					(px) =>
						document.documentElement.style.setProperty("font-size", `${px}px`),
					font,
				);
				const wide = await v.evaluate((root) => {
					const out: string[] = [];
					for (const e of root.querySelectorAll<HTMLElement>(".diag *")) {
						if (e.closest(".diag-sr")) continue;
						const r = e.getBoundingClientRect();
						if (r.width && (r.left < -0.5 || r.right > innerWidth + 0.5))
							out.push(`${e.className || e.tagName}: ${r.left}–${r.right}`);
					}
					return out;
				});
				expect(wide, `${font} px text`).toEqual([]);
			}
		});
}
