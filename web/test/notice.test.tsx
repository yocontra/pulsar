/**
 * The agent-team / task notice card (NoticeCard.tsx), rendered to static
 * HTML from the chat-blocks gallery's synthetic Claude log and from
 * hand-built events.
 */
import "./window-shim.ts";
import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { galleryEvents } from "../mock/blocks.ts";
import type { TranscriptEvent } from "../src/api/types.ts";

// Streamdown renders only in a browser: here Markdown is its source text in
// a marked box (the chat's Markdown pipeline is tested elsewhere).
mock.module("../src/components/ai-elements/message.tsx", () => ({
	MessageResponse: ({ children }: { children?: ReactNode }) => (
		<div className="md">{children}</div>
	),
}));
const { NoticeCard, isLong, noticeLabel } = await import(
	"../src/session/NoticeCard.tsx"
);
const { SystemRow } = await import("../src/session/Transcript.tsx");

type Notice = NonNullable<TranscriptEvent["notice"]>;
const card = (ev: TranscriptEvent) =>
	renderToStaticMarkup(
		<NoticeCard ev={ev as TranscriptEvent & { notice: Notice }} />,
	);
const ev = (
	notice: Notice,
	text = "",
	extra: object = {},
): TranscriptEvent => ({
	id: "e1",
	ts: Date.UTC(2026, 10, 18, 16, 12),
	role: "peer",
	kind: "peer",
	text,
	from: "worker",
	notice,
	...extra,
});
const events = galleryEvents((id) => `/img/${id}`);
const gallery = (re: RegExp) =>
	events.find((e) => e.notice && re.test(e.text))!;

describe("notice card", () => {
	test("a finished teammate: color dot, label, title, Markdown body, clamp", () => {
		const html = card(gallery(/four fixes/));
		expect(html).toContain('data-notice="idle_notification"');
		expect(html).toContain(
			'class="ds-agent-mark ds-notice-dot" data-agent-color="blue"',
		);
		expect(html).toContain(">parser<");
		expect(html).toContain(">Finished<");
		expect(html).toContain(
			'<div class="ds-notice-title">Four fixes ready for review</div>',
		);
		expect(html).toContain("| Defect | PR |");
		expect(html).toContain("ds-notice-body is-clamped");
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain(">Show more<");
		expect(html).not.toContain("{&quot;type&quot;");
	});

	test("an idle teammate with nothing to say is one quiet line", () => {
		const html = card(ev({ type: "idle_notification", color: "green" }));
		expect(html).toContain("ds-notice-quiet");
		expect(html).toContain('role="status"');
		expect(html).toContain(">idle<");
		expect(html).not.toContain("ds-notice-card");
	});

	test("a failed teammate reads as an error", () => {
		const html = card(gallery(/Chromium did not start/));
		expect(html).toContain('ds-notice-label is-error">Failed<');
		expect(html).not.toContain("Show more");
	});

	test("a plain teammate message has no label, a short body no clamp", () => {
		const html = card(gallery(/drafted the \*\*Setup\*\*/));
		expect(html).not.toContain("ds-notice-label");
		expect(html).toContain("README section drafted");
		expect(html).not.toContain("is-clamped");
	});

	test("a background task result renders through SystemRow", () => {
		const task = events.find((e) => e.notice?.type === "task_notification")!;
		const html = renderToStaticMarkup(<SystemRow ev={task} />);
		expect(html).toContain("Background task");
		expect(html).toContain(">Task done<");
		expect(html).toContain("Survey the callers");
	});

	test("content is text, never markup", () => {
		const html = card(
			ev(
				{ type: "message", summary: "<img src=x onerror=alert(1)>" },
				"<script>alert(1)</script>",
				{ from: '"><svg onload=alert(1)>' },
			),
		);
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<svg");
	});
});

describe("notice labels", () => {
	test("each protocol type has words", () => {
		const l = (type: string, status?: string, text = true) =>
			noticeLabel({ type, ...(status ? { status } : {}) }, text);
		expect(l("message")).toBeUndefined();
		expect(l("idle_notification", "available", false)).toBe("Idle");
		expect(l("idle_notification", "available")).toBe("Finished");
		expect(l("idle_notification", "failed")).toBe("Failed");
		expect(l("plan_approval_request")).toBe("Plan for approval");
		expect(l("plan_approval_response", "approved")).toBe("Plan approved");
		expect(l("plan_approval_response", "rejected")).toBe(
			"Plan changes requested",
		);
		expect(l("shutdown_request")).toBe("Asked to shut down");
		expect(l("shutdown_response", "approved")).toBe("Shutting down");
		expect(l("task_notification", "completed")).toBe("Task done");
		expect(l("task_notification", "killed")).toBe("Task stopped");
		expect(l("frob_event")).toBe("Frob event");
	});

	test("clamp after ~8 lines", () => {
		expect(isLong("a\nb\nc")).toBe(false);
		expect(isLong(Array(10).fill("line").join("\n"))).toBe(true);
		expect(isLong("x".repeat(1000))).toBe(true);
	});
});
