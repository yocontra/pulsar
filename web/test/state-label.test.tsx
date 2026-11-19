/**
 * Status labels never read "Idle 0s": under a minute the state stands alone,
 * then "Idle 1m", "Idle 3h", "Idle 2d". Every place that shows how long a
 * state has held goes through stateLabel / heldFor.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentStatus } from "../src/components/ui/status.tsx";
import { heldFor, stateLabel } from "../src/lib/format.ts";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

describe("stateLabel", () => {
	test("under a minute the state has no duration", () => {
		expect(stateLabel("Idle", NOW, NOW)).toBe("Idle");
		expect(stateLabel("Idle", NOW - 1 * SEC, NOW)).toBe("Idle");
		expect(stateLabel("Idle", NOW - 59 * SEC, NOW)).toBe("Idle");
		expect(stateLabel("Idle", NOW - 59_999, NOW)).toBe("Idle");
		// A clock a little behind the server's.
		expect(stateLabel("Idle", NOW + 5 * SEC, NOW)).toBe("Idle");
		expect(stateLabel("Working", NOW, NOW)).toBe("Working");
	});

	test("from a minute on it reads minutes, hours, days", () => {
		expect(stateLabel("Idle", NOW - MIN, NOW)).toBe("Idle 1m");
		expect(stateLabel("Idle", NOW - 2 * MIN, NOW)).toBe("Idle 2m");
		expect(stateLabel("Idle", NOW - 59 * MIN, NOW)).toBe("Idle 59m");
		expect(stateLabel("Idle", NOW - HOUR, NOW)).toBe("Idle 1h");
		expect(stateLabel("Idle", NOW - 5 * HOUR, NOW)).toBe("Idle 5h");
		expect(stateLabel("Idle", NOW - 72 * HOUR, NOW)).toBe("Idle 3d");
		expect(stateLabel("Done", NOW - 3 * MIN, NOW)).toBe("Done 3m");
	});

	test("no time known: the bare state", () => {
		expect(stateLabel("Idle", undefined, NOW)).toBe("Idle");
		expect(stateLabel("Idle", null, NOW)).toBe("Idle");
		expect(stateLabel("Idle", 0, NOW)).toBe("Idle");
		expect(heldFor(NOW - 30 * SEC, NOW)).toBeNull();
		expect(heldFor(NOW - 2 * MIN, NOW)).toBe("2m");
	});
});

describe("status labels in the app", () => {
	test("the row badge", () => {
		const html = (since: number) =>
			renderToStaticMarkup(
				<AgentStatus state="idle" since={since} now={NOW} />,
			);
		expect(html(NOW)).toContain(">Idle<");
		expect(html(NOW)).not.toMatch(/\b0s\b/);
		expect(html(NOW - 40 * SEC)).toContain(">Idle<");
		expect(html(NOW - 40 * MIN)).toContain(">Idle 40m<");
		expect(
			renderToStaticMarkup(<AgentStatus state="busy" since={NOW} now={NOW} />),
		).toContain(">Working<");
	});
});
