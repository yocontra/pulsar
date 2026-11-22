import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import type { Hello } from "../../src/api/types.ts";
import { expect, proveInSheet, test, withPasskey } from "../fixtures.ts";

const CONTROL = `http://127.0.0.1:${Number(process.env.PULSAR_REAL_CONTROL_PORT ?? Number(process.env.PULSAR_REAL_PORT ?? 47392) + 1)}`;
const H = { "X-Pulsar": "1" };

async function hello(request: APIRequestContext): Promise<Hello> {
	return (await (
		await request.get("/api/v1/hello", { headers: H })
	).json()) as Hello;
}

async function agents(request: APIRequestContext) {
	return (await (await request.get(`${CONTROL}/agents`)).json()) as {
		fixer: string;
		reviewer: string;
		differ: string;
		others: string[];
	};
}

const LOCAL = `http://localhost:${Number(process.env.PULSAR_REAL_PORT ?? 47392)}`;

/** A real passkey on the real daemon (virtual authenticator). */
async function passkey(
	page: Page,
	request: APIRequestContext,
	context: import("@playwright/test").BrowserContext,
) {
	await page.goto(`${LOCAL}/`);
	await withPasskey(page, request, context, { mock: false });
}

async function open(page: Page, request: APIRequestContext, base = "") {
	const h = await hello(request);
	await page.goto(`${base}/`);
	const machine = page.locator(`[data-node="m:${h.machineId}"]`);
	await expect(machine).toBeVisible();
	return h;
}

test.describe("real daemon @real", () => {
	test("tree loads from the daemon @real", async ({ page, request }) => {
		const h = await open(page, request);
		expect(h.features).toContain("stop");
		const machine = page.locator(`[data-node="m:${h.machineId}"]`);
		await expect(machine).toContainText("studio");
		await expect(machine).toHaveAttribute("aria-expanded", "true");
		const demo = page.locator(`[data-node="m:${h.machineId}/p:demo"]`);
		await expect(demo).toBeVisible();
		await demo.locator(".chev").click();
		await expect(
			page.locator(".tree [data-agent]", { hasText: "fixer" }),
		).toBeVisible();
		// The agent that asked the user shows under Needs you.
		await expect(
			page.getByRole("button", {
				name: "docs-writer on studio: Which README section should the lock note go in?",
			}),
		).toBeVisible();
	});

	test("transcript media: a read PDF and a screenshot, served safely and opened in the app @real", async ({
		page,
		request,
	}) => {
		const { fixer } = await agents(request);
		await open(page, request);
		await page.goto(`/#/a/${encodeURIComponent(fixer)}`);
		await expect(page.locator(".session-header h1")).toHaveText("fixer");
		expect((await request.post(`${CONTROL}/append-media`)).ok()).toBe(true);
		const doc = page.locator(".ds-doc", { hasText: "refresh-flow.pdf" });
		await expect(doc).toContainText("PDF · 2 pages", { timeout: 10_000 });
		await expect(
			page.locator(".tool-images img.transcript-image").last(),
		).toHaveAttribute("src", /^blob:/);
		// The daemon serves the PDF as a PDF, never as active content.
		const page1 = await request.get(
			`/api/v1/agents/${encodeURIComponent(fixer)}/transcript`,
			{
				headers: { "X-Pulsar": "1" },
			},
		);
		const url = (
			(await page1.json()) as { events: { documents?: { url: string }[] }[] }
		).events.find((e) => e.documents)?.documents?.[0]?.url;
		expect(url).toBeTruthy();
		const bytes = await request.get(url!, { headers: { "X-Pulsar": "1" } });
		expect(bytes.headers()["content-type"]).toBe("application/pdf");
		expect(bytes.headers()["x-content-type-options"]).toBe("nosniff");
		expect(bytes.headers()["content-security-policy"]).toContain("sandbox");
		expect((await bytes.body()).subarray(0, 5).toString()).toBe("%PDF-");
		// The card opens the in-app viewer (under the app's real CSP).
		await doc.click();
		await expect(page.locator('.ds-pdf iframe[src^="blob:"]')).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.locator(".ds-pdf")).toHaveCount(0);
	});

	test("an agent's real transcript streams live @real", async ({
		page,
		request,
	}) => {
		const { fixer } = await agents(request);
		await open(page, request);
		await page.goto(`/#/a/${encodeURIComponent(fixer)}`);
		await expect(page.locator(".session-header h1")).toHaveText("fixer");
		await expect(page.locator(".transcript")).toContainText(
			"Fix the token refresh race",
		);
		// A Claude session outside tmux can't be interrupted: no Stop.
		await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
		const marker = `live line ${Date.now()}`;
		const r = await request.post(
			`${CONTROL}/append?text=${encodeURIComponent(marker)}`,
		);
		expect(r.ok()).toBe(true);
		await expect(page.locator(".transcript")).toContainText(marker, {
			timeout: 10_000,
		});
	});

	test("an agent's subagents: listed, nested in the sidebar, transcript, message via parent @real", async ({
		page,
		request,
	}) => {
		const { fixer } = await agents(request);
		const list = (await (
			await request.get(
				`/api/v1/agents/${encodeURIComponent(fixer)}/subagents`,
				{ headers: H },
			)
		).json()) as { items: { id: string; name: string; state: string }[] };
		const sub = `${fixer}/sub:a0demo0subagent`;
		expect(list.items).toMatchObject([
			{ id: sub, name: "Find refresh callers", state: "done" },
		]);
		// Not an agent.
		const all = (await (
			await request.get("/api/v1/agents?limit=200", { headers: H })
		).json()) as { items: { id: string }[] };
		expect(all.items.some((a) => a.id.includes("/sub:"))).toBe(false);

		// It is finished: the sidebar lists it only with "Show finished subagents".
		await page.addInitScript(() =>
			localStorage.setItem("pulsar.showFinishedSubagents", "1"),
		);
		const h = await open(page, request);
		const demo = page.locator(`[data-node="m:${h.machineId}/p:demo"]`);
		if ((await demo.getAttribute("aria-expanded")) !== "true")
			await demo.locator(".chev").click();
		const toggle = page.locator(`[data-subs="${fixer}"]`);
		await expect(toggle).toHaveText("1 subagent");
		await toggle.click();
		await page
			.locator(".tree [data-subagent]", { hasText: "Find refresh callers" })
			.click();
		const view = page.locator(`[data-subagent-page="${sub}"]`);
		await expect(view).toContainText("Found 3 callers of refresh().");
		await expect(view.locator(".sub-note")).toContainText(
			"Claude Code subagents can't receive messages",
		);
		const sent = page.waitForResponse(
			(r) =>
				r.url().endsWith("/api/v1/send") && r.request().method() === "POST",
		);
		await view.locator(".composer-input").fill("which caller is hot?");
		await page.keyboard.press("ControlOrMeta+Enter");
		const prove = page.getByRole("dialog", { name: "Prove Human" });
		if (await prove.isVisible().catch(() => false))
			await prove.getByRole("button", { name: "Send without proving" }).click();
		const res = await sent;
		expect(res.status()).toBe(200);
		const body = (await res.json()) as {
			message: { body: string };
			receipts: { agentId: string }[];
		};
		expect(body.receipts.map((r) => r.agentId)).toEqual([fixer]);
		expect(body.message.body).toContain(
			'For your subagent "Find refresh callers"',
		);
	});

	test("an agent's worktree changes show and update live @real", async ({
		page,
		request,
	}) => {
		const { differ } = await agents(request);
		await open(page, request);
		await page.goto(`/#/a/${encodeURIComponent(differ)}`);
		await expect(page.locator(".session-header h1")).toHaveText("differ");
		const toggle = page.getByRole("button", { name: /^Changes/ });
		await expect(toggle).toContainText("2");
		await toggle.click();
		const panel = page.getByRole("complementary", { name: "Changes" });
		await expect(panel.locator(".cv-branch")).toContainText("fix-lock");
		await expect(panel.locator(".cv-file")).toHaveCount(2);
		await panel.locator(".cv-file", { hasText: "lock.ts" }).click();
		await expect(panel.locator(".ds-diff-row.del")).toContainText(
			"export const locked = false;",
		);
		await expect(panel.locator(".ds-diff-row.add")).toContainText(
			"export const locked = true;",
		);
		// The agent edits a file: the open diff follows, no reload.
		const marker = `edited ${Date.now()}`;
		const r = await request.post(
			`${CONTROL}/edit?path=${encodeURIComponent("src/lock.ts")}&text=${encodeURIComponent(marker)}`,
		);
		expect(r.ok()).toBe(true);
		await expect(panel.locator(".ds-diff-row.add").last()).toContainText(
			marker,
			{ timeout: 10_000 },
		);
		// The server refuses paths git does not list.
		const bad = await request.get(
			`/api/v1/agents/${encodeURIComponent(differ)}/changes/file?path=${encodeURIComponent("../state/pulsar.db")}`,
			{ headers: H },
		);
		expect(bad.status()).toBe(404);
	});

	test("send to one agent and see its receipt and reply @real", async ({
		page,
		request,
	}) => {
		const { reviewer } = await agents(request);
		await open(page, request);
		await page.goto(`/#/a/${encodeURIComponent(reviewer)}`);
		await expect(page.locator(".session-header h1")).toHaveText("reviewer");
		const text = `check the lock ${Date.now()}`;
		await page.getByRole("radio", { name: "Interrupt now" }).click();
		await page.locator(".composer-input").fill(text);
		await page.keyboard.press("ControlOrMeta+Enter");
		// pi keeps no transcript (no bubble): its receipt line stays.
		await expect(page.locator(".receipt-line")).toContainText(
			`reviewer got: ${text}`,
			{ timeout: 10_000 },
		);
	});

	test("a send retried after a lost response is delivered once (client id) @real", async ({
		page,
		request,
		errors,
	}) => {
		const { reviewer } = await agents(request);
		await open(page, request);
		await page.goto(`/#/a/${encodeURIComponent(reviewer)}`);
		await expect(page.locator(".session-header h1")).toHaveText("reviewer");
		const text = `send this once ${Date.now()}`;
		// The daemon gets the first send, but its response never arrives.
		const seen: { clientId?: string; id?: string }[] = [];
		await page.route("**/api/v1/send", async (route) => {
			const req = route.request().postDataJSON() as { clientId?: string };
			const res = await route.fetch();
			const body = (await res.json()) as { message?: { id: string } };
			seen.push({ clientId: req.clientId, id: body.message?.id });
			if (seen.length === 1) await route.abort("failed");
			else await route.fulfill({ response: res });
		});
		// The reviewer is busy: interrupt, so the push goes now.
		await page.getByRole("radio", { name: "Interrupt now" }).click();
		await page.locator(".composer-input").fill(text);
		await page.keyboard.press("ControlOrMeta+Enter");
		const count = async () =>
			(
				(await (
					await request.get(
						`${CONTROL}/pushes?body=${encodeURIComponent(text)}`,
					)
				).json()) as { count: number }
			).count;
		await expect.poll(count).toBe(1);
		// The bubble (or, without a transcript, the composer) offers Retry.
		await page.getByRole("button", { name: "Retry" }).first().click();
		await expect.poll(() => seen.length).toBe(2);
		expect(seen[1]!.clientId).toBe(seen[0]!.clientId);
		expect(seen[1]!.id).toBe(seen[0]!.id);
		await page.waitForTimeout(1500);
		expect(await count()).toBe(1);
		await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
		// The aborted request logs a console error; that one was on purpose.
		for (let i = errors.length - 1; i >= 0; i--)
			if (/net::ERR_FAILED/.test(errors[i]!)) errors.splice(i, 1);
	});

	test("the daemon sends a repeated clientId once @real", async ({
		request,
	}) => {
		const { reviewer } = await agents(request);
		const body = `api once ${Date.now()}`;
		const send = () =>
			request.post("/api/v1/send", {
				headers: H,
				data: {
					ids: [reviewer],
					body,
					priority: "urgent",
					clientId: `c_e2e${Date.now()}`,
				},
			});
		const clientId = `c_e2e_${Date.now()}`;
		const post = () =>
			request.post("/api/v1/send", {
				headers: H,
				data: { ids: [reviewer], body, priority: "urgent", clientId },
			});
		const [a, b] = await Promise.all([post(), post()]);
		const c = await post();
		const ids = await Promise.all(
			[a, b, c].map(
				async (r) =>
					((await r.json()) as { message: { id: string } }).message.id,
			),
		);
		expect(new Set(ids).size).toBe(1);
		await expect
			.poll(
				async () =>
					(
						(await (
							await request.get(
								`${CONTROL}/pushes?body=${encodeURIComponent(body)}`,
							)
						).json()) as { count: number }
					).count,
			)
			.toBe(1);
		// Another client id is another send.
		expect((await send()).ok()).toBe(true);
		await expect
			.poll(
				async () =>
					(
						(await (
							await request.get(
								`${CONTROL}/pushes?body=${encodeURIComponent(body)}`,
							)
						).json()) as { count: number }
					).count,
			)
			.toBe(2);
	});

	test("a proven send reaches the agent in the short frame and renders as the operator's turn @real", async ({
		page,
		request,
		context,
	}) => {
		const { reviewer, fixer } = await agents(request);
		await passkey(page, request, context);
		await open(page, request, LOCAL);
		await page.goto(`${LOCAL}/#/a/${encodeURIComponent(reviewer)}`);
		await expect(page.locator(".session-header h1")).toHaveText("reviewer");
		// Prove first (the sidebar's Prove Human), so the send is the operator's.
		const nav = page.getByRole("button", { name: /^Prove Human: / }).first();
		if (/Not proven/.test((await nav.getAttribute("aria-label")) ?? "")) {
			await nav.click();
			// From the nav the sheet stays open on "Proven as …": close it.
			const sheet = page.getByRole("dialog", { name: "Prove Human" });
			await sheet.getByRole("button", { name: /^Prove with/ }).click();
			await expect(sheet.getByRole("status")).toContainText("Proven as");
			await sheet.getByRole("button", { name: "Close" }).click();
		}
		await expect(nav).toHaveAccessibleName(/^Prove Human: Proven/);
		const body = `tighten the refresh lock ${Date.now()}`;
		await page.getByRole("radio", { name: "Interrupt now" }).click();
		await page.locator(".composer-input").fill(body);
		const sent = page.waitForResponse(
			(r) =>
				r.url().endsWith("/api/v1/send") && r.request().method() === "POST",
		);
		await page.keyboard.press("ControlOrMeta+Enter");
		const res = await sent;
		const id = ((await res.json()) as { message: { id: string } }).message.id;
		let text = "";
		await expect
			.poll(async () => {
				const r = await request.get(`${CONTROL}/push?id=${id}`);
				text = r.ok() ? ((await r.json()) as { text: string }).text : "";
				return text;
			})
			.not.toBe("");
		expect(text).toMatch(
			new RegExp(
				`^\\[human operator - [^\\]\\n]+\\] ${body}\n— via Pulsar from \\S+ · (waiting for your reply|reply): respond ${id}$`,
			),
		);
		// The same text in a Claude transcript: the operator's own turn.
		await request.post(`${CONTROL}/push?id=${id}`);
		await page.goto(`${LOCAL}/#/a/${encodeURIComponent(fixer)}`);
		const turn = page.locator(`[data-pulsar-id="${id}"]`);
		await expect(turn).toHaveCount(1, { timeout: 15_000 });
		await expect(turn).toHaveClass(/ds-turn--user/);
		await expect(turn.locator(".ds-author-via")).toHaveText(
			/^via Pulsar on \S+$/,
		);
		await expect(turn.locator(".ds-bubble")).toHaveText(body);
		await expect(page.locator(".transcript")).not.toContainText(
			`respond ${id}`,
		);
	});

	test("stop interrupts an agent through its extension @real", async ({
		page,
		request,
		context,
	}) => {
		const { reviewer } = await agents(request);
		// Stop needs a passkey session (Face ID / Touch ID once).
		await passkey(page, request, context);
		await open(page, request, LOCAL);
		await page.goto(`${LOCAL}/#/a/${encodeURIComponent(reviewer)}`);
		await expect(page.locator(".session-header h1")).toHaveText("reviewer");
		await page.keyboard.press("ControlOrMeta+.");
		const confirm = page.getByRole("alertdialog", { name: "Confirm stop" });
		await confirm.getByRole("button", { name: "Stop this turn" }).click();
		// Not proven yet: Prove Human opens (one tap), then the Stop goes on.
		await proveInSheet(page);
		await expect(page.locator(".toast")).toHaveText("Stopped reviewer's turn");
		await page.getByRole("button", { name: "Stop", exact: true }).click();
		await confirm.getByRole("button", { name: "Stop this turn" }).click();
		await expect(page.locator(".toast")).toHaveText(
			"reviewer wasn't running a turn",
		);
	});

	test("broadcast: the audience, then send (the dry run runs inside Send) @real", async ({
		page,
		request,
	}) => {
		await open(page, request);
		await page.goto(`/#/broadcast?s=${encodeURIComponent("project=api")}`);
		const count = page.getByTestId("match-count");
		await expect(count).toHaveText("3 agents on 1 machine");
		await expect(page.locator(".bc-sentence")).toContainText(
			"all agents in api",
		);
		await expect(page.locator(".bc-card")).toHaveCount(1);
		await page.getByLabel("Broadcast message").fill("api freeze in 10 min");
		await page.getByRole("button", { name: /^Send to 3/ }).click();
		// A small send asks once to confirm the recipients.
		await page.getByRole("button", { name: "Confirm send to 3" }).click();
		await expect(
			page.getByRole("dialog", { name: "Broadcast results" }),
		).toBeVisible();
		await expect(page.locator(".receipt-summary")).toContainText(
			/handed over|waiting|delivered/i,
			{ timeout: 8000 },
		);
	});

	test("the daemon serves the app compressed with build caching @real", async ({
		request,
	}) => {
		const index = await request.get("/", {
			headers: { "Accept-Encoding": "gzip, deflate, br" },
		});
		expect(index.headers()["content-encoding"]).toBe("br");
		expect(index.headers().vary).toBe("Accept-Encoding");
		expect(index.headers()["cache-control"]).toBe("no-cache");
		expect(index.headers()["content-security-policy"]).toContain(
			"script-src 'self'",
		);
		// The entry module only imports the app chunk (a few bytes, below the
		// 1 KB precompression floor); check the largest build script instead.
		const dir = resolve(import.meta.dirname, "../../../dist/web/_app");
		const [name] = readdirSync(dir)
			.filter((f) => f.endsWith(".js"))
			.sort(
				(a, b) => statSync(join(dir, b)).size - statSync(join(dir, a)).size,
			);
		const entry = `/_app/${name}`;
		const js = await request.get(entry, {
			headers: { "Accept-Encoding": "gzip" },
		});
		expect(js.headers()["content-encoding"]).toBe("gzip");
		expect(js.headers()["cache-control"]).toBe(
			"public, max-age=31536000, immutable",
		);
		const again = await request.get(entry, {
			headers: {
				"Accept-Encoding": "gzip",
				"If-None-Match": js.headers().etag!,
			},
		});
		expect(again.status()).toBe(304);
		for (const path of ["/sw.js", "/boot.js"])
			expect((await request.get(path)).headers()["cache-control"]).toBe(
				"no-cache",
			);
		expect(
			(await request.get("/api/v1/hello", { headers: H })).headers()[
				"cache-control"
			],
		).toBe("no-store");
	});
});
