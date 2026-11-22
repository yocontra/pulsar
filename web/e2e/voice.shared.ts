import type { Page } from "@playwright/test";
import { openAgent } from "./composer.shared.ts";
import { agentId, expect, test } from "./fixtures.ts";

/**
 * Dictation in the composer (features/voice) with a fake recognizer in
 * place of the browser's: the test speaks for it (`__speech.say`), and its
 * calls show what the app asked of it. Shared by voice.desktop.e2e.ts and
 * voice.ios.e2e.ts.
 */

interface Speech {
	calls: string[];
	say(...pieces: string[]): void;
	error(code: string): void;
	end(): void;
}

/** Before the app loads: the fake recognizer, or none at all. */
async function fakeSpeech(page: Page, supported = true) {
	await page.addInitScript((supported) => {
		const w = window as unknown as Record<string, unknown>;
		delete w.SpeechRecognition;
		delete w.webkitSpeechRecognition;
		if (!supported) return;
		type Handlers = {
			onresult: ((e: unknown) => void) | null;
			onerror: ((e: unknown) => void) | null;
			onend: (() => void) | null;
		};
		let last: Handlers | null = null;
		const speech = {
			calls: [] as string[],
			say: (...pieces: string[]) =>
				last?.onresult?.({ results: pieces.map((t) => [{ transcript: t }]) }),
			error: (code: string) => last?.onerror?.({ error: code }),
			end: () => last?.onend?.(),
		};
		w.__speech = speech;
		w.webkitSpeechRecognition = class {
			lang = "";
			continuous = false;
			interimResults = false;
			onresult = null;
			onerror = null;
			onend = null;
			constructor() {
				last = this;
			}
			start() {
				speech.calls.push("start");
			}
			stop() {
				speech.calls.push("stop");
			}
			abort() {
				speech.calls.push("abort");
			}
		};
	}, supported);
}

/** Speaks for the fake recognizer, or reads what the app asked of it. */
const speech = <K extends keyof Speech>(
	page: Page,
	op: K,
	...args: Speech[K] extends (...a: infer A) => unknown ? A : []
) =>
	page.evaluate(
		({ op, args }) => {
			const s = (window as unknown as { __speech: Record<string, unknown> })
				.__speech;
			const v = s[op];
			return typeof v === "function" ? v(...args) : v;
		},
		{ op, args: args as string[] },
	) as Promise<Speech[K] extends string[] ? string[] : undefined>;

export function voiceSuite(platform: "desktop" | "phone") {
	test(`dictate into the draft, live, then stop (${platform})`, async ({
		page,
		request,
	}) => {
		await fakeSpeech(page);
		const composer = await openAgent(page, request, "name=apparish-auth");
		const input = composer.locator(".composer-input");
		await input.fill("Note:");
		const mic = composer.getByRole("button", { name: "Dictate" });
		await mic.click();
		const stop = composer.getByRole("button", { name: "Stop dictation" });
		await expect(stop).toHaveAttribute("aria-pressed", "true");
		await expect(stop).toHaveAttribute("data-state", "listening");
		await expect(stop.getByRole("status")).toHaveText(/^0:0\d$/);
		expect(await speech(page, "calls")).toEqual(["start"]);

		await speech(page, "say", "fix the");
		await expect(input).toHaveValue("Note: fix the");
		await speech(page, "say", "fix the login", " bug");
		await expect(input).toHaveValue("Note: fix the login bug");
		await expect(composer.getByRole("button", { name: "Send" })).toBeEnabled();

		await stop.click();
		const finishing = composer.getByRole("button", {
			name: "Finish dictation now",
		});
		await expect(finishing).toHaveAttribute("data-state", "finishing");
		expect(await speech(page, "calls")).toEqual(["start", "stop"]);
		await speech(page, "say", "fix the login", " bug now");
		await speech(page, "end");
		await expect(mic).toHaveAttribute("aria-pressed", "false");
		await expect(input).toHaveValue("Note: fix the login bug now");
	});

	test(`a second tap ends a slow stop, and Send ends listening (${platform})`, async ({
		page,
		request,
	}) => {
		await fakeSpeech(page);
		const composer = await openAgent(page, request, "name=apparish-auth");
		const input = composer.locator(".composer-input");
		await composer.getByRole("button", { name: "Dictate" }).click();
		await speech(page, "say", "first");
		await composer.getByRole("button", { name: "Stop dictation" }).click();
		// The recognizer never ends: the second tap keeps the words.
		await composer
			.getByRole("button", { name: "Finish dictation now" })
			.click();
		await expect(
			composer.getByRole("button", { name: "Dictate" }),
		).toBeVisible();
		expect(await speech(page, "calls")).toEqual(["start", "stop", "abort"]);
		await expect(input).toHaveValue("first");

		await input.fill("");
		await composer.getByRole("button", { name: "Dictate" }).click();
		await speech(page, "say", "ship it");
		await expect(input).toHaveValue("ship it");
		await composer.getByRole("button", { name: "Send" }).click();
		await expect(input).toHaveValue("");
		await expect(
			composer.getByRole("button", { name: "Dictate" }),
		).toBeVisible();
		await speech(page, "say", "ship it", " and more");
		await expect(input).toHaveValue("");
		// The message went out with the dictated words.
		await expect(
			page.getByText("ship it", { exact: true }).last(),
		).toBeVisible();
	});

	test(`leaving the agent releases the mic and keeps the words (${platform})`, async ({
		page,
		request,
	}) => {
		await fakeSpeech(page);
		const composer = await openAgent(page, request, "name=apparish-auth");
		const input = composer.locator(".composer-input");
		await composer.getByRole("button", { name: "Dictate" }).click();
		await speech(page, "say", "keep me");
		await expect(input).toHaveValue("keep me");
		// The field itself, to read it after its composer is gone.
		const field = await input.elementHandle();
		const other = await agentId(request, "name=codex@apparish");
		await page.evaluate((id) => {
			location.hash = `#/a/${encodeURIComponent(id)}`;
		}, other);
		await expect
			.poll(() => field!.evaluate((el) => el.isConnected))
			.toBe(false);
		expect(await speech(page, "calls")).toEqual(["start", "abort"]);
		await speech(page, "say", "keep me", " and more");
		expect(
			await field!.evaluate((el) => (el as HTMLTextAreaElement).value),
		).toBe("keep me");
	});

	test(`Esc cancels and puts the draft back (${platform})`, async ({
		page,
		request,
	}) => {
		await fakeSpeech(page);
		const composer = await openAgent(page, request, "name=apparish-auth");
		const input = composer.locator(".composer-input");
		await input.fill("Keep this");
		await composer.getByRole("button", { name: "Dictate" }).click();
		await speech(page, "say", "oops wrong words");
		await expect(input).toHaveValue("Keep this oops wrong words");
		await page.keyboard.press("Escape");
		await expect(input).toHaveValue("Keep this");
		await expect(
			composer.getByRole("button", { name: "Dictate" }),
		).toBeVisible();
		expect(await speech(page, "calls")).toEqual(["start", "abort"]);
		// The page is still here (Esc didn't close or leave anything).
		await expect(input).toBeVisible();
	});

	test(`typing keeps the words and stops listening (${platform})`, async ({
		page,
		request,
	}) => {
		await fakeSpeech(page);
		const composer = await openAgent(page, request, "name=apparish-auth");
		const input = composer.locator(".composer-input");
		await composer.getByRole("button", { name: "Dictate" }).click();
		await speech(page, "say", "hello");
		await expect(input).toHaveValue("hello");
		await input.focus();
		await page.keyboard.type("!");
		await expect(input).toHaveValue("hello!");
		await expect(
			composer.getByRole("button", { name: "Dictate" }),
		).toBeVisible();
		expect(await speech(page, "calls")).toEqual(["start", "abort"]);
		await speech(page, "say", "hello more");
		await expect(input).toHaveValue("hello!");
	});

	test(`a denied microphone says so (${platform})`, async ({
		page,
		request,
	}) => {
		await fakeSpeech(page);
		const composer = await openAgent(page, request, "name=apparish-auth");
		await composer.getByRole("button", { name: "Dictate" }).click();
		await speech(page, "error", "not-allowed");
		const card = page.locator("[data-sonner-toast]");
		await expect(card).toContainText("Microphone access was denied");
		await expect(
			composer.getByRole("button", { name: "Dictate" }),
		).toBeVisible();
	});

	test(`no mic where the browser can't dictate (${platform})`, async ({
		page,
		request,
	}) => {
		await fakeSpeech(page, false);
		const composer = await openAgent(page, request, "name=apparish-auth");
		await expect(
			composer.getByRole("button", { name: "Attach files" }),
		).toBeVisible();
		await expect(composer.getByRole("button", { name: "Dictate" })).toHaveCount(
			0,
		);
	});
}
