import { expect, localhostBase, test, withPasskey } from "./fixtures.ts";

export function launchSettingsTest() {
	test("first-turn choices are scoped to the launch machine and a refusal keeps the message", async ({
		page,
		request,
		context,
	}) => {
		await page.goto(`${localhostBase()}/#/new?machine=desk`);
		await withPasskey(page, request, context);
		const draft = page.getByTestId("launch-draft");
		await expect(draft.getByTestId("launch-machine")).toHaveAccessibleName(
			"Machine: desk",
		);
		await expect(draft.getByText("First-turn settings")).toHaveCount(0);
		await draft.getByTestId("launch-harness").click();
		await page.getByRole("option", { name: /Codex/ }).click();
		await draft.getByText("First-turn settings").click();
		await expect(
			draft.locator('datalist option[value="desk-model"]'),
		).toHaveCount(1);
		await expect(
			draft.locator('datalist option[value="studio-model"]'),
		).toHaveCount(0);
		const model = draft.getByLabel("Model ID");
		await model.fill("studio-model");
		await draft.getByLabel("Reasoning effort").fill("high");
		const first = draft.getByRole("textbox", { name: "First message" });
		await first.fill("launch settings are ready");
		const start = () =>
			draft.getByRole("button", { name: "Start agent" }).click();
		await start();
		await expect(draft.getByRole("alert")).toContainText(
			"your message was not sent",
		);
		await expect(first).toHaveValue("launch settings are ready");
		await expect(model).toHaveValue("studio-model");

		await model.fill("desk-model");
		const submitted = page.waitForRequest(
			(r) =>
				r.method() === "POST" &&
				new URL(r.url()).pathname === "/api/v1/agents/launch",
		);
		await start();
		const send = await submitted;
		expect(send.postDataJSON()).toMatchObject({
			machine: "desk",
			params: {
				model: "desk-model",
				effort: "high",
				prompt: "launch settings are ready",
			},
		});
		await expect(page).toHaveURL(/#\/a\//, { timeout: 15_000 });
	});
}
