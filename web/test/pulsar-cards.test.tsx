/**
 * The bespoke card for Pulsar's own MCP calls: its head line per tool and
 * harness naming, and its expanded body, rendered to static HTML from the
 * gallery's synthetic logs (web/mock/pulsar-blocks.ts).
 */
import "./window-shim.ts";
import { describe, expect, mock, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { pulsarTool } from "../../src/transcripts/pulsar.ts";
import { galleryEvents } from "../mock/blocks.ts";
import { buildItems, type Item } from "../src/session/items.ts";

mock.module("../src/components/ai-elements/message.tsx", () => ({
	MessageResponse: ({ children }: { children?: ReactNode }) => (
		<div className="md">{children}</div>
	),
}));
const { ToolCard } = await import("../src/session/ToolCard.tsx");
const { default: PulsarBody } = await import(
	"../src/session/tools/PulsarBody.tsx"
);
const { knownMessages, PulsarMessages } = await import(
	"../src/session/tools/pulsar-messages.ts"
);

const html = (el: ReactElement) => renderToStaticMarkup(el);
const text = (h: string) =>
	h
		.replace(/<[^>]+>/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();

const events = galleryEvents();
const known = knownMessages(events);
type ToolItem = Extract<Item, { t: "tool" }>;
const tools = buildItems(events).filter(
	(i): i is ToolItem =>
		i.t === "tool" && !!pulsarTool(i.call?.tool?.name ?? ""),
);
const nameOf = (it: ToolItem) => it.call!.tool!.name;
const pick = (name: string, nth = 0) =>
	tools.filter((t) => nameOf(t) === name)[nth]!;

const card = (it: ToolItem) =>
	html(
		<PulsarMessages.Provider value={known}>
			<ToolCard item={it} />
		</PulsarMessages.Provider>,
	);
const head = (it: ToolItem) => text(card(it));
const body = (it: ToolItem) =>
	html(
		<PulsarMessages.Provider value={known}>
			<PulsarBody
				name={nameOf(it)}
				input={it.call!.tool!.input}
				output={(it.result?.text ?? "").trim()}
				isError={!!it.result?.tool?.isError}
				layout="unified"
				done={!!it.result}
			/>
		</PulsarMessages.Provider>,
	);

describe("Pulsar cards in the gallery", () => {
	test("every harness's naming gets the bespoke card", () => {
		const names = new Set(tools.map(nameOf));
		for (const n of [
			"mcp__pulsar__send",
			"mcp__pulsar_send",
			"mcp_pulsar_send",
			"mcp_pulsar_wait",
			"mcp__pulsar_reply",
		])
			expect(names.has(n)).toBe(true);
		for (const it of tools) {
			const h = card(it);
			expect(h).toContain("is-pulsar");
			// Never the generic "Called pulsar.send" line.
			expect(text(h)).not.toContain("Called");
		}
	});

	test("send: recipients, priority, result summary", () => {
		expect(head(pick("mcp__pulsar__send"))).toBe(
			"Sent to reviewer Urgent reply from reviewer",
		);
		expect(head(pick("mcp__pulsar__send", 1))).toBe(
			"Sent to everyone on demo Don't wake delivered to 2 1 queued",
		);
		expect(head(pick("mcp_pulsar_send"))).toContain("Sent to everyone");
		const b = body(pick("mcp__pulsar__send"));
		expect(b).toContain("ds-pulsar-msg"); // the inline reply as a bubble
		expect(text(b)).toContain("Three tries is fine.");
		expect(text(b)).toContain("Is a **3-try** limit enough");
	});

	test("respond: names the sender of the answered message", () => {
		expect(head(pick("mcp__pulsar__respond"))).toBe(
			"Working on it reviewer@demo",
		);
		expect(head(pick("mcp__pulsar__respond", 1))).toBe(
			"Replied to reviewer@demo delivered to 1",
		);
		const b = text(body(pick("mcp__pulsar__respond", 1)));
		expect(b).toContain("Can you look at the flaky retry test");
		expect(b).toContain("Fixed: the test now uses fake timers.");
		// A message this transcript doesn't hold: no raw id in the card's words.
		expect(head(pick("mcp__pulsar__respond", 2))).toBe(
			"Declined (retry later)",
		);
		const declined = text(body(pick("mcp__pulsar__respond", 2)));
		expect(declined).toContain("In answer to a message");
		expect(declined).toContain(
			"The sender sees it was declined for now and can ask again later.",
		);
		// The note is the app's, not the tool's text to the agent.
		const working = text(body(pick("mcp__pulsar__respond")));
		expect(working).toContain("The sender sees it's being worked on.");
		expect(working).not.toContain("respond done");
		// A message read with wait answers the reply in the pi section.
		expect(head(pick("mcp_pulsar_reply"))).toBe(
			"Replied to builder delivered to 1",
		);
	});

	test("wait, lookup, inbox, identity", () => {
		expect(head(pick("mcp__pulsar__wait"))).toBe(
			"Waited for reviewer to finish timed out after 5 min",
		);
		expect(head(pick("mcp_pulsar_wait"))).toBe(
			"Waited for a message message from builder 4 s",
		);
		expect(head(pick("mcp__pulsar__list_agents"))).toBe(
			"Looked up agents everyone on demo 3 agents",
		);
		const list = body(pick("mcp__pulsar__list_agents"));
		expect(list).toContain('href="#/a/codex%3Ademo-reviewer"');
		expect(text(list)).toContain("Reviewing PR 12");
		expect(head(pick("mcp__pulsar__list_agents", 1))).toBe(
			"Looked up agents who is editing src/net/retry.ts 1 agent",
		);
		expect(head(pick("mcp__pulsar__inbox"))).toBe(
			"Read 2 messages docs reviewer",
		);
		expect(text(body(pick("mcp__pulsar__inbox")))).toContain(
			"CI is red on main",
		);
		expect(head(pick("mcp__pulsar__set_identity"))).toBe(
			"Set status: Fixing the flaky retry test pr:12 role:author",
		);
		expect(head(pick("mcp__pulsar__whoami"))).toBe("Checked its identity");
	});

	test("errors read in red, as their message", () => {
		const it = pick("mcp__pulsar__send", 2);
		const h = card(it);
		expect(h).toContain("is-error");
		// The head says it failed; the reason shows once, in the body.
		expect(text(h)).toBe("Sent to ghost Failed , failed");
		const b = text(body(it));
		expect(b).toContain("No live agent matches \u201cghost\u201d");
		expect(b.match(/No live agent matches/g)?.length).toBe(1);
		expect(body(it)).toContain("ds-pulsar-error");
	});

	test("raw JSON stays behind Show details", () => {
		for (const it of tools) {
			const b = body(it);
			expect(text(b)).toContain("Show details");
			expect(b).not.toContain("ds-json-block");
			expect(b).not.toContain("ds-args");
		}
	});
});
