import type { Page } from "@playwright/test";
import { agentId, expect } from "./fixtures.ts";

export async function reviewDiffLines(page: Page, phone: boolean) {
	const id = await agentId(page.request, "name=apparish-auth");
	await page.goto(`/#/a/${encodeURIComponent(id)}`);
	const input = page
		.getByRole("textbox", { name: "Message", exact: true })
		.last();
	await input.fill("Please review");
	await page
		.getByRole("button", { name: /^Changes/ })
		.first()
		.click();
	await page.locator(".cv-file").filter({ hasText: "mutex.ts" }).last().click();
	const row = page
		.getByRole("button", { name: "Review old line 1", exact: true })
		.last();
	await row.click();
	const form = page.getByRole("form", { name: "Review lines" }).last();
	await form.getByRole("spinbutton", { name: "Last review line" }).fill("2");
	await page.evaluate(() =>
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (quote: string) =>
					sessionStorage.setItem("test.copiedReview", quote),
			},
		}),
	);
	await form.getByRole("button", { name: "Copy quote" }).click();
	expect(
		await page.evaluate(() => sessionStorage.getItem("test.copiedReview")),
	).toContain("src/util/lock.ts:1-2 (working tree, before)");
	await form.getByRole("button", { name: "Add to chat" }).click();
	await expect(input).toHaveValue(
		/Please review\n\nsrc\/util\/lock\.ts:1-2 \(working tree, before\)\n\n {4}export class Lock \{\n {4}\s*private tail/,
	);
	if (phone) await expect(page).toHaveURL(/#\/a\//);
	await expect(
		page.getByRole("button", { name: "Send", exact: true }).last(),
	).toBeEnabled();
}

export async function reviewFileLines(page: Page) {
	const id = await agentId(page.request, "name=omp@apparish");
	await page.goto(
		`/#/file/${encodeURIComponent(id)}?path=src%2Fauth%2Frefresh.ts&line=7`,
	);
	await page
		.getByRole("button", { name: "Review lines", exact: true })
		.last()
		.click();
	const form = page.getByRole("form", { name: "Review lines" }).last();
	await expect(form.getByLabel("First review line")).toHaveValue("7");
	await form.getByLabel("Last review line").fill("8");
	await form.getByRole("button", { name: "Add to chat" }).click();
	await expect(
		page.getByRole("textbox", { name: "Message", exact: true }).last(),
	).toHaveValue(
		/src\/auth\/refresh.ts:7-8 \(File\)\n\n {4}export async function refresh/,
	);
	const other = await agentId(page.request, "name=apparish-auth");
	await page.goto(
		`/#/file/${encodeURIComponent(id)}?path=src%2Fauth%2Frefresh.ts&line=7`,
	);
	await page
		.getByRole("button", { name: "Review lines", exact: true })
		.last()
		.click();
	await form.getByRole("button", { name: "Choose another chat" }).click();
	await form
		.getByRole("combobox", { name: "Destination chat" })
		.selectOption(other);
	await form.getByRole("button", { name: "Add to chat" }).click();
	await expect(page).toHaveURL(new RegExp(`${encodeURIComponent(other)}$`));
	await expect(
		page.getByRole("textbox", { name: "Message", exact: true }).last(),
	).toHaveValue(/^From .+\nsrc\/auth\/refresh\.ts:7 \(File\)/);
}

export async function reviewChildLines(page: Page) {
	const parent = await agentId(page.request, "name=apparish-auth");
	const child = `${parent}/sub:a2fix`;
	await page.goto(`/#/s/${encodeURIComponent(child)}`);
	const chat = page.locator("[data-subagent-page]").last();
	const input = chat.getByRole("textbox", { name: "Message", exact: true });
	await input.fill("Child review");
	await chat.getByRole("button", { name: "session interface" }).click();
	await expect(page).toHaveURL(/#\/file\//);
	await page.reload();
	await page
		.getByRole("button", { name: "Review lines", exact: true })
		.last()
		.click();
	await page.getByRole("button", { name: "Add to chat" }).last().click();
	await expect(page).toHaveURL(/#\/s\//);
	await expect(input).toHaveValue(
		/Child review\n\nsrc\/auth\/session.ts:1 \(File\)/,
	);
	await expect(chat.locator("[data-messaging]")).toHaveAttribute(
		"data-messaging",
		"parent",
	);
}
