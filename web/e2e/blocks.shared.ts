import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expectCleanCopy } from "./copy.ts";
import { agentId, expect, test } from "./fixtures.ts";

/**
 * The chat-blocks gallery (fixture=blocks): every block the harness parsers
 * produce from synthetic Claude, Codex and omp logs (web/mock/blocks.ts),
 * rendered with every card open, in light and dark.
 *
 * With PULSAR_BLOCK_SHOTS=<dir>, also saves one screenshot per block and a
 * manifest.json there (for the design review).
 */
export function blocksSuite(platform: "desktop" | "phone") {
	const shots = process.env.PULSAR_BLOCK_SHOTS;

	/** Opens every closed card and waits for the lazy bodies. */
	async function openAll(page: Page) {
		const conv = page.locator(".ds-conv").first();
		for (let pass = 0; pass < 3; pass++) {
			const closed = conv.locator(
				'.ds-tool[data-state="closed"] > .ds-tool-head, .ds-reason[data-state="closed"] > .ds-reason-head',
			);
			const n = await closed.count();
			if (!n) break;
			for (let i = n - 1; i >= 0; i--) {
				const head = closed.nth(i);
				await head.scrollIntoViewIfNeeded();
				await head.click();
			}
		}
		await expect(conv.getByText("Loading…")).toHaveCount(0, {
			timeout: 15_000,
		});
	}

	test(`thinking and replies share highlighted, copyable code (${platform})`, async ({
		page,
		request,
	}) => {
		await page.addInitScript(() => {
			Object.defineProperty(navigator, "clipboard", {
				value: {
					writeText: async (value: string) => {
						document.body.dataset.copied = value;
					},
				},
			});
		});
		const id = await agentId(request, "fixture=blocks");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const thought = page.locator(".ds-reason:not(.is-hidden)").first();
		await thought.locator(".ds-reason-head").click();
		for (const block of [
			thought.locator(".ds-code"),
			page
				.locator(".ds-prose .ds-code")
				.filter({ hasText: "const clock = 42;" })
				.first(),
		]) {
			await expect(block.locator(".ds-code-label")).toHaveText(/typescript/i);
			await expect
				.poll(() =>
					block
						.locator(".ds-lc span")
						.evaluateAll(
							(tokens) =>
								new Set(tokens.map((t) => getComputedStyle(t).color)).size,
						),
				)
				.toBeGreaterThan(1);
			const copy = block.getByRole("button", { name: "Copy code" });
			await expect(copy.locator("svg")).toHaveCSS("width", "14px");
			await copy.click();
			await expect(page.locator("body")).toHaveAttribute(
				"data-copied",
				"const clock = 42;",
			);
			await page.locator("body").evaluate((body) => delete body.dataset.copied);
		}
	});

	test(`message cards show readable content and center the recipient (${platform})`, async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "fixture=blocks");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const cards = page.locator('[data-tool="send_message"]');
		const encrypted = cards.filter({ hasText: "inventory" }).first();
		await encrypted.locator(".ds-tool-head").click();
		await expect(encrypted).toContainText(
			"The transcript stores this message encrypted.",
		);
		await expect(encrypted).not.toContainText("gAAAA");
		const center = async (selector: string) => {
			const box = await encrypted.locator(selector).boundingBox();
			return box!.y + box!.height / 2;
		};
		expect(
			Math.abs(
				(await center(".ds-tool-verb")) - (await center(".ds-tool-target")),
			),
		).toBeLessThan(1.5);
		const encoded = cards.filter({ hasText: "reviewer" }).first();
		await encoded.locator(".ds-tool-head").click();
		await expect(encoded.locator(".ds-sent")).toHaveText("Review is ready.");
	});

	for (const scheme of ["light", "dark"] as const)
		test(`every chat block has its renderer (${platform}, ${scheme})`, async ({
			page,
			request,
		}) => {
			// About 40 s for the phone on a CI runner: every block, opened one by one.
			test.setTimeout(shots ? 240_000 : 120_000);
			await page.emulateMedia({ colorScheme: scheme });
			const id = await agentId(request, "fixture=blocks");
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			const conv = page.locator(".ds-conv").first();
			await expect(
				conv.locator('[data-tool="FrobnicateWidget"]'),
			).toBeAttached();
			await openAll(page);

			// One renderer per block, each in its own shape.
			const has = async (selector: string, min = 1) =>
				expect
					.poll(() => conv.locator(selector).count(), { message: selector })
					.toBeGreaterThanOrEqual(min);
			for (const tool of [
				"Read",
				"Edit",
				"MultiEdit",
				"Write",
				"NotebookEdit",
				"Bash",
				"BashOutput",
				"KillShell",
				"Grep",
				"Glob",
				"LS",
				"WebFetch",
				"WebSearch",
				"TodoWrite",
				"AskUserQuestion",
				"ExitPlanMode",
				"Skill",
				"Agent",
				"SendMessage",
				"ToolSearch",
				"mcp__tracker__create_issue",
				"mcp__browser__screenshot",
				"FrobnicateWidget",
				"advisor",
				"update_plan",
				"exec_command",
				"apply_patch",
				"view_image",
				"web_search",
				"local_shell",
				"exec",
				"spawn_agent",
				"eval",
				"todo",
				"task",
				"ask",
				"wait",
			])
				await has(`[data-tool="${tool}"]`);
			await has(".is-cut-json");
			await has('[data-tool="mcp__tracker__list_issues"]');
			// omp: an MCP call through `write xd://…` reads as the MCP call.
			const xd = conv.locator('[data-tool="mcp__issue-desk__label_issue"]');
			await expect(xd.locator(".ds-tool-head")).toContainText(
				"issue-desk.label_issue",
			);
			await expect(xd.locator(".ds-args")).toContainText("PARSE-7");
			await expect(conv.getByText(/Wrote\s+xd:\/\/mcp__/)).toHaveCount(0);
			await has(".ds-slash");
			await has(".ds-user-shell");
			await has(".ds-system-out", 2);
			await has(".ds-divider.is-interrupted", 2);
			await has(".ds-divider.is-compacted", 3);
			await has(".ds-notice, .ds-job-result", 3);
			await has(".ds-reason.is-hidden", 2);
			await has(".ev.peer", 4);
			// Shell commands, every harness: where they ran, highlighted Bash.
			await has(".ds-cmd .ds-term-dir", 4);
			await expect(
				conv.locator('.ds-term-dir[title="/work/demo/web"]'),
			).toContainText("web/");
			// A Codex script: its commands, then the script on demand.
			const script = conv
				.locator('[data-tool="exec"]')
				.filter({ hasText: "bun test net --reporter=dots" });
			await expect(script.locator(".ds-cmd")).toHaveCount(2);
			await expect(script.locator(".ds-cmd-call")).toHaveCount(1);
			await expect(script.locator(".ds-cmd").first()).toContainText("4 pass");
			await script.getByRole("button", { name: /Show script/ }).click();
			await expect(
				script.locator('.ds-cmd-script [data-lang="typescript"]'),
			).toContainText("const repo");
			// Code is formatted for display; "Original" shows it as written.
			const shown = script.locator(".ds-cmd-script .ds-code");
			await expect(shown).toHaveClass(/is-formatted/);
			await shown.getByRole("button", { name: "Original" }).click();
			await expect(shown).not.toHaveClass(/is-formatted/);
			await shown.getByRole("button", { name: "Formatted" }).click();
			await expect(shown).toHaveClass(/is-formatted/);
			// A long one-line chain: one step per line.
			const chain = conv
				.locator('[data-tool="Bash"]')
				.filter({ hasText: "Build and test the net package" });
			await expect(chain.locator(".ds-term-cmd")).toHaveCount(4);
			await chain.getByRole("button", { name: "Original" }).click();
			await expect(chain.locator(".ds-term-cmd")).toHaveCount(1);
			// Agent-team messages and task results: notice cards, never JSON.
			await has(".ds-notice-turn", 7);
			await has('.ds-notice-quiet[data-notice="idle_notification"]');
			await has('.ds-notice-dot[data-agent-color="blue"]');
			await has(".ds-notice-label.is-error");
			await has(".ds-notice-body table");
			const finished = conv
				.locator(".ds-notice-turn")
				.filter({ hasText: "Four fixes ready for review" });
			await expect(finished.locator(".ds-notice-body")).toHaveClass(
				/is-clamped/,
			);
			await finished.getByRole("button", { name: "Show more" }).click();
			await expect(
				finished.getByRole("button", { name: "Show less" }),
			).toHaveAttribute("aria-expanded", "true");
			await expect(finished.locator(".ds-notice-body")).not.toHaveClass(
				/is-clamped/,
			);
			await has(".ds-results li", 3);
			await has(".ds-todos li", 7);
			await has(".ds-options li.is-chosen");
			await has(".ds-patch-file", 3);
			await has(".ds-nb-cell");
			await has(".ds-json-node", 2);
			await has(".ds-args");
			await has(".ds-match-file", 2);
			await has(".ds-files li", 3);
			await has(".ds-chips li", 2);
			await has(".ds-plan");
			await has(".ds-term .ansi-fg-2");
			await has(".ds-edit-label", 2);
			await has(".ds-tool.is-denied");
			await has(".ds-tool.is-stopped");
			await has(".ds-tool.is-error", 3);
			await has("img.transcript-image", 4);
			await has(".ds-task, [data-tool='Agent']");

			// Never a raw dump, a leaked JS value or an escape code.
			const text = await conv.evaluate((el) => {
				// JSON cut at 4 KB is shown as (highlighted) text on purpose.
				const cut = [...el.querySelectorAll<HTMLElement>(".is-cut-json")];
				for (const c of cut) c.hidden = true;
				// biome-ignore lint/performance/useDomNodeTextContent: the rendered text is what a person reads.
				const t = (el as HTMLElement).innerText;
				for (const c of cut) c.hidden = false;
				return t;
			});
			expect(text).not.toMatch(/\[object Object\]/);
			expect(text).not.toMatch(/\bundefined\b/);
			expect(text).not.toContain('{"');
			expect(text).not.toContain('{"type":"idle_notification"');
			expect(text).not.toContain("This came from another Claude session");
			expect(text).not.toContain("\u001b");
			expect(text).not.toMatch(
				/<\/?(command-|bash-|system-reminder|tool_use_error)/,
			);
			// omp asks in HTML: shown as text, never as markup.
			await expect(conv.locator('img[src="x"]')).toHaveCount(0);
			await expectCleanCopy(
				page,
				`${platform} blocks`,
				".ds-conv :is(.ds-author, .ds-tool-verb, .ds-tool-meta, .ds-reason-head, .ds-divider, .ds-system, .ds-notice, .ds-tool-note, .ds-tool-state-note, .ds-plan-verdict, .ds-edit-label, .ds-match-count)",
			);

			// A thumbnail opens full size: arrows move between the
			// conversation's images, + zooms, Escape closes.
			await conv.locator(".ds-thumb").first().click();
			const box = page.locator(".ds-lightbox");
			await expect(box.locator("img")).toBeVisible();
			await expect(box.locator(".ds-lightbox-count")).toHaveText(
				/^1 of [4-9]$/,
			);
			await page.keyboard.press("ArrowRight");
			await expect(box.locator(".ds-lightbox-count")).toHaveText(/^2 of /);
			const viewShot = async (name: string) => {
				if (!shots) return;
				mkdirSync(join(shots, "views"), { recursive: true });
				await page.screenshot({
					path: join(shots, "views", `${name}-${platform}-${scheme}.jpg`),
					type: "jpeg",
					quality: 82,
					caret: "initial",
				});
			};
			await viewShot("lightbox");
			await box.getByRole("button", { name: "Zoom in" }).click();
			await expect(box.locator("img")).toHaveAttribute(
				"style",
				/scale\(1\.5\)/,
			);
			await page.keyboard.press("0");
			await expect(box.locator("img")).toHaveAttribute("style", /scale\(1\)/);
			await page.keyboard.press("Escape");
			await expect(page.locator(".ds-lightbox")).toHaveCount(0);
			// Escape closed only the image, not the session.
			await expect(conv).toBeVisible();

			// A PDF the agent read: a card with its facts that opens the viewer.
			const doc = conv.locator(".ds-doc").first();
			await expect(doc).toContainText("refresh-flow.pdf");
			await expect(doc).toContainText("PDF · 2 pages");
			await doc.click();
			const viewer = page.locator(".ds-pdf");
			await expect(viewer.locator('iframe[src^="blob:"]')).toBeVisible();
			await viewShot("pdf");
			await expect(
				viewer.getByRole("link", { name: "Download" }),
			).toHaveAttribute("download", "refresh-flow.pdf");
			await page.keyboard.press("Escape");
			await expect(viewer).toHaveCount(0);
			await expect(conv).toBeVisible();

			if (!shots) return;
			const dir = join(shots, `${platform}-${scheme}`);
			mkdirSync(dir, { recursive: true });
			const blocks = conv.locator(
				".ds-turn--user, .ds-turn--peer, .ds-parts > *, .ev.system:not(.ds-parts > *), .ev.gap",
			);
			// The jump-to-latest pill floats over whatever block is on screen.
			await page.evaluate(() => {
				for (const b of document.querySelectorAll("button"))
					if (b.textContent?.includes("Jump to latest"))
						b.style.visibility = "hidden";
			});
			const n = await blocks.count();
			const manifest: { file: string; label: string }[] = [];
			for (let i = 0; i < n; i++) {
				const b = blocks.nth(i);
				const label = await b.evaluate((el) => {
					const tool = el.getAttribute("data-tool");
					if (tool) return tool;
					const cls = el.className.toString();
					return cls
						.split(/\s+/)
						.filter((c: string) =>
							/^(ds-turn--|is-|ds-reason|ds-notice|ds-system|ds-divider|ds-prose|ds-task)/.test(
								c,
							),
						)
						.join(" ");
				});
				const file = `${String(i).padStart(3, "0")}.jpg`;
				await b.scrollIntoViewIfNeeded();
				await b.screenshot({
					path: join(dir, file),
					type: "jpeg",
					quality: 82,
					caret: "initial",
				});
				manifest.push({ file, label });
			}
			writeFileSync(
				join(dir, "manifest.json"),
				JSON.stringify(manifest, null, 1),
			);
		});

	test(`omp's tool cards in an omp agent (${platform})`, async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "fixture=omp-blocks");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const conv = page.locator(".ds-conv").first();
		await expect(conv.locator('[data-tool="wait"]')).toBeAttached({
			timeout: 15_000,
		});
		const notice = conv.locator("details.ds-job-result").first();
		await expect(notice.locator("summary")).toHaveText(
			"Background job bg_2 completed",
		);
		await expect(notice.locator("pre")).toBeHidden();
		await notice.locator("summary").click();
		await expect(notice.locator("pre")).toHaveText("bench <test> passed");
		await openAll(page);
		const card = (tool: string, text?: string) => {
			const all = conv.locator(`[data-tool="${tool}"]`);
			return (text ? all.filter({ hasText: text }) : all).first();
		};
		// Each card's line: verb, target and key result.
		await expect(
			card("read", "parse.ts").locator(".ds-tool-head"),
		).toContainText("lines 12–14");
		await expect(card("grep").locator(".ds-tool-head")).toContainText(
			"2 matches",
		);
		await expect(card("glob").locator(".ds-tool-head")).toContainText(
			"3 files",
		);
		await expect(
			card("bash", "--watch").locator(".ds-tool-head"),
		).toContainText(/in background/i);
		await expect(card("todo", "Checked off")).toBeAttached();
		await expect(card("write", "bg_2").locator(".ds-tool-head")).toContainText(
			"Sent input to",
		);
		await expect(card("web_fetch")).toHaveClass(/is-error/);
		await expect(
			card("mcp__issue-desk__label_issue").locator(".ds-args"),
		).toContainText("PARSE-7");
		// omp's result formats in the shared views.
		await expect(card("read", "parse.ts").locator(".ds-ln").first()).toHaveText(
			"12",
		);
		await expect(card("grep").locator(".ds-match-file").first()).toContainText(
			"parse.ts",
		);
		await expect(card("grep")).not.toContainText("*13|");
		await expect(card("glob").locator(".ds-files")).toContainText(
			"config/load.ts",
		);
		await expect(card("bash").locator(".ds-cmd").first()).toBeAttached();
		await expect(conv.getByText(/Wrote\s+(xd|proc):\/\//)).toHaveCount(0);
	});
}
