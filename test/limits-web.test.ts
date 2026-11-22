import { describe, expect, test } from "bun:test";
import type { LimitState } from "../src/http/wire.ts";
import {
	levelOf,
	parseThresholds,
	resetText,
	usedText,
	warningText,
	worst,
} from "../web/src/features/limits/text.ts";

/** The app's wording and levels for plan usage limits (web/src/features/limits). */

const l = (used: number, o: Partial<LimitState> = {}): LimitState => ({
	harness: "codex",
	account: "codex",
	window: "m10080",
	label: "Weekly",
	usedPercent: used,
	reached: used >= 100,
	resetsAt: null,
	at: 0,
	plan: null,
	...o,
});

describe("limits in the app", () => {
	test("levels against the thresholds", () => {
		expect(levelOf(l(50), [80, 95])).toBe("ok");
		expect(levelOf(l(80), [80, 95])).toBe("near");
		expect(levelOf(l(95.5), [80, 95])).toBe("high");
		expect(levelOf(l(100), [80, 95])).toBe("reached");
		expect(levelOf(l(60), [])).toBe("ok");
	});

	test("the header shows the fullest limit past a threshold", () => {
		expect(worst([l(70)], [80, 95])).toBeNull();
		const five = l(91, { window: "m300", label: "5-hour" });
		expect(worst([l(85), five], [80, 95])).toBe(five);
		const hit = l(100, { harness: "claude", window: "seven_day" });
		expect(worst([five, hit], [80, 95])).toBe(hit);
	});

	test("plain sentences", () => {
		expect(
			warningText(
				{
					harness: "codex",
					label: "Weekly",
					level: 95,
					reached: false,
					usedPercent: 96.4,
					resetsAt: null,
				},
				"Codex",
			),
		).toBe("Codex is at 96% of its weekly limit");
		expect(
			warningText(
				{
					harness: "claude",
					label: "5-hour",
					level: 100,
					reached: true,
					usedPercent: 100,
					resetsAt: null,
				},
				"Claude Code",
			),
		).toBe("Claude Code hit its 5-hour limit");
		expect(usedText(l(62.4))).toBe("62% used");
		expect(usedText(l(100))).toBe("Limit reached");
		expect(resetText(null)).toBeNull();
		const now = new Date(2026, 10, 21, 9, 0).getTime();
		expect(resetText(now + 3_600_000, now)).toMatch(/^Resets 10:00/);
		expect(resetText(now + 2 * 86_400_000, now)).toMatch(/^Resets Mon /);
	});

	test("thresholds typed in Settings", () => {
		expect(parseThresholds("80, 95")).toEqual([80, 95]);
		expect(parseThresholds("95% 80%")).toEqual([80, 95]);
		expect(parseThresholds("90,90")).toEqual([90]);
		for (const bad of ["", "0", "100", "50.5", "1 2 3 4", "abc"])
			expect(parseThresholds(bad)).toBeNull();
	});
});
