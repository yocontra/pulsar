import type { AgentRow, TranscriptPage } from "../src/api/types.ts";
import {
	agentId,
	expect,
	localhostBase,
	proveInSheet,
	registerPasskey,
	resetPasskeys,
	test,
} from "./fixtures.ts";
import { softAuthenticator } from "./soft-webauthn.ts";

const sessionId = "900d4135-768b-4cbc-b11d-ef4417681243";
const archiveId = `pi:${sessionId}`;
const cwd = "/Users/you/Projects/resume-folder-trust";
const header = { "X-Pulsar": "1" };
const savedText = "Original pi conversation saved before exit.";
const transcript: TranscriptPage = {
	events: [
		{
			id: "saved#0",
			ts: 1_780_000_000_000,
			role: "user",
			kind: "text",
			text: savedText,
		},
	],
	cursor: null,
	available: true,
};

export function resumePidTest() {
	test("resuming an archived pi conversation opens its live PID route", async ({
		page,
		request,
	}) => {
		await resetPasskeys(request);
		await softAuthenticator(page);

		const seed = await agentId(request, "harness=claude");
		const response = await request.get(
			`/api/v1/agents/${encodeURIComponent(seed)}`,
			{ headers: header },
		);
		expect(response.ok()).toBe(true);
		const archive: AgentRow = {
			...((await response.json()) as AgentRow),
			id: archiveId,
			name: "pi saved conversation",
			harness: "pi",
			cwd,
			machine: "studio",
			machineId: "studio",
			sessionId,
			archived: true,
			registered: false,
			status: "gone",
			state: "offline",
			needsYou: null,
			pid: null,
			capabilities: {
				surface: "attached",
				inbox: false,
				wake: false,
				stop: false,
				status: false,
				transcript: true,
				subagents: false,
				resume: true,
			},
		};
		const archivePath = encodeURIComponent(archiveId);
		await page.route(`**/api/v1/agents/${archivePath}`, (route) =>
			route.fulfill({ json: archive }),
		);
		await page.route(
			new RegExp(
				`/api/v1/agents/${archivePath}/(?:changes|usage|subagents)(?:\\?|$)`,
				"i",
			),
			async (route) => {
				const url = route
					.request()
					.url()
					.replace(archivePath, encodeURIComponent(seed));
				await route.fulfill({ response: await route.fetch({ url }) });
			},
		);
		await page.route(
			new RegExp(
				`/api/v1/agents/(?:${archivePath}|pi%3Apid%3A[0-9]+)/transcript(?:\\?|$)`,
				"i",
			),
			(route) => route.fulfill({ json: transcript }),
		);

		const oldUrl = `${localhostBase()}/#/a/${archivePath}`;
		await page.goto(oldUrl);
		await registerPasskey(page);
		const composer = page.locator(".composer-input");
		const saved = page.getByText(savedText, { exact: true });
		await expect(saved).toBeVisible();
		await expect(
			page.getByText("Saved conversation · Session closed"),
		).toBeVisible();
		await expect(composer).toHaveCount(0);

		const submitted = page.waitForRequest(
			(r) =>
				r.method() === "POST" &&
				new URL(r.url()).pathname === "/api/v1/agents/launch",
		);
		await page.getByRole("button", { name: "Resume session" }).click();
		await proveInSheet(page);
		const { machine, params } = (await submitted).postDataJSON();
		expect(machine).toBeUndefined();
		expect(params).toMatchObject({
			cwd,
			harness: "pi",
			resumeSessionId: sessionId,
			workspace: "current",
		});
		expect(params.prompt).toBeUndefined();
		await expect(
			page.getByRole("button", { name: "Waiting in the terminal" }),
		).toBeDisabled();
		await expect(page).toHaveURL(oldUrl);
		await expect(saved).toBeVisible();
		await expect(composer).toHaveCount(0);

		const answer = await request.post("/api/v1/__mock/launch/answer", {
			headers: header,
		});
		expect(answer.ok()).toBe(true);
		await expect(page).toHaveURL(/#\/a\/pi%3Apid%3A\d+$/i);
		const liveId = decodeURIComponent(
			new URL(page.url()).hash.slice("#/a/".length),
		);
		const live = await request.get(
			`/api/v1/agents/${encodeURIComponent(liveId)}`,
			{ headers: header },
		);
		expect(await live.json()).toMatchObject({
			id: liveId,
			pid: Number(liveId.slice("pi:pid:".length)),
			sessionId: null,
		});
		await expect(saved).toBeVisible();
		await expect(composer).toBeVisible();
	});
}
