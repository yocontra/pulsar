/**
 * Messages Pulsar pushed, as the transcript renders them: the operator's
 * own turn (their name, "via Pulsar on <machine>", body only), an
 * unverified app send, and a peer message from another agent. The events
 * come from the daemon's own frame and parser, so the two stay in step.
 */
import "./window-shim.ts";
import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseCodex } from "../../src/harnesses/codex-transcript.ts";
import { formatPush, type PushMessage } from "../../src/push-frame.ts";
import { newParseState } from "../../src/transcripts/types.ts";
import type { TranscriptEvent } from "../src/api/types.ts";

mock.module("../src/components/ai-elements/message.tsx", () => ({
	MessageResponse: ({ children }: { children?: ReactNode }) => (
		<div className="md">{children}</div>
	),
}));
const { Transcript } = await import("../src/session/Transcript.tsx");
const { setLocalSend } = await import("../src/data/pending.ts");

const MSG: PushMessage = {
	id: "m_7f3a9c21",
	threadId: "t",
	fromId: "user:me@example.com",
	fromName: "user",
	to: "x",
	body: "tighten the refresh lock and add a test",
	priority: "normal",
	replyTo: null,
	expectReply: false,
	createdAt: 0,
};
const APP = { name: "user", harness: "user", project: null, machine: "mbp" };

/** The event a Codex transcript holds for one pushed text. */
function pushed(text: string): TranscriptEvent {
	const line = JSON.stringify({
		timestamp: "2026-11-18T16:56:00.000Z",
		type: "response_item",
		payload: {
			type: "message",
			id: "u-1",
			role: "user",
			content: [{ type: "input_text", text }],
		},
	});
	return parseCodex(`${line}\n`, newParseState({ atStart: false }))[0]!;
}

const render = (ev: TranscriptEvent) =>
	renderToStaticMarkup(
		<Transcript events={[ev]} variant="desktop" agent={null} />,
	);
const visible = (h: string) =>
	h
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, " ")
		.trim();

describe("pushed messages in the transcript", () => {
	test("an operator send is the operator's turn, without the frame", () => {
		const h = render(
			pushed(formatPush(MSG, APP, { kind: "human", name: "Ada Lovelace" })),
		);
		expect(h).toContain("ds-turn--user");
		expect(h).not.toContain("ds-turn--peer");
		expect(visible(h)).toMatch(
			/^Ada Lovelace via Pulsar on mbp \S+(?: [AP]M)? tighten the refresh lock and add a test$/,
		);
		expect(h).toContain('title="Pulsar message m_7f3a9c21"');
		expect(h).toContain('data-pulsar-id="m_7f3a9c21"');
		for (const frame of ["human operator", "respond", "— ", "Another agent"])
			expect(visible(h)).not.toContain(frame);
	});

	test("an unverified app send is the app's, neither operator nor agent", () => {
		const h = render(pushed(formatPush(MSG, APP, { kind: "unverified" })));
		expect(h).toContain("ds-turn--peer is-app");
		expect(visible(h)).toContain("From the Pulsar app (not verified) on mbp");
		expect(visible(h)).not.toContain("Another agent");
		expect(visible(h)).not.toContain("respond");
	});

	test("an agent's push is a peer message under the agent's name", () => {
		const h = render(
			pushed(
				formatPush(MSG, {
					name: "codex@api",
					harness: "codex",
					project: "api",
					machine: "studio",
				}),
			),
		);
		expect(h).toContain("ds-turn--peer");
		expect(visible(h)).toContain("codex@api Another agent");
		expect(visible(h)).not.toContain("[pulsar]");
		expect(visible(h)).not.toContain("respond");
	});
});

describe("an optimistic send under its bubble", () => {
	const local = (sender: "operator" | "app"): TranscriptEvent => ({
		id: "local:c_test1",
		ts: Date.parse("2026-11-18T16:56:00Z"),
		role: sender === "operator" ? "user" : "peer",
		kind: "text",
		text: "ship it",
		from: "you",
		pulsar: { sender },
	});
	const html = (ev: TranscriptEvent) =>
		renderToStaticMarkup(
			<Transcript events={[ev]} variant="desktop" agent={null} />,
		);
	const noop = () => {};

	test("Sending…, then Not sent with Retry and Delete; on either side", () => {
		for (const sender of ["operator", "app"] as const) {
			setLocalSend("local:c_test1", {
				state: "sending",
				retry: noop,
				discard: noop,
			});
			const sending = html(local(sender));
			expect(sending).toContain('data-send-state="sending"');
			expect(sending).toContain("Sending…");
			setLocalSend("local:c_test1", {
				state: "failed",
				error: "offline",
				retry: noop,
				discard: noop,
			});
			const failed = html(local(sender));
			expect(failed).toContain("Not sent: offline.");
			expect(failed).toContain(">Retry<");
			expect(failed).toContain(">Delete<");
			expect(failed).not.toContain("Sending…");
		}
		setLocalSend("local:c_test1", null);
	});

	test("an accepted line from another tab, or a real line not sent here, shows no state", () => {
		setLocalSend("local:c_test1", {
			state: "sent",
			retry: noop,
			discard: noop,
		});
		const ev = {
			...local("operator"),
			pulsar: { sender: "operator" as const, messageId: "m_elsewhere" },
		};
		const out = html(ev);
		expect(out).not.toContain("ds-send-state");
		expect(out).not.toContain("ds-delivery");
		setLocalSend("local:c_test1", null);
	});
});
