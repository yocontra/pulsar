import { describe, expect, test } from "bun:test";
import {
	describePulsar,
	parseAgents,
	parseIdentity,
	parseMessages,
	parseSend,
	parseWait,
	pulsarTool,
	receiptSummary,
	recipients,
	resultBody,
} from "../src/transcripts/pulsar.ts";

describe("pulsarTool: names by harness", () => {
	test.each([
		["mcp__pulsar__send", "send"], // Claude Code
		["mcp_pulsar_reply", "reply"], // pi
		["mcp__pulsar_set_identity", "set_identity"], // omp (minted)
		["pulsar_list_agents", "list_agents"], // OpenCode
		["pulsar__wait", "wait"],
		["pulsar.inbox", "inbox"],
		["mcp__pulsar__whoami", "whoami"],
	])("%s → %s", (name, tool) => {
		expect(pulsarTool(name)).toBe(tool as never);
	});

	test.each([
		"send",
		"wait",
		"reply",
		"mcp__linear__send",
		"mcp__pulsar__unknown_tool",
		"pulsarsend",
		"mcp__pulsarx__send",
	])("%s is not a Pulsar call", (name) => {
		expect(pulsarTool(name)).toBeNull();
	});
});

describe("recipients", () => {
	test("plain words for selectors", () => {
		expect(recipients("*")).toEqual([{ label: "everyone", selector: "*" }]);
		expect(recipients("project=apparish")[0]!.label).toBe(
			"everyone on apparish",
		);
		expect(recipients("harness=codex status=idle")[0]!.label).toBe(
			"every codex agent who is idle",
		);
		expect(recipients("reviewer")).toEqual([
			{ label: "reviewer", agent: "reviewer" },
		]);
	});
});

const SEND_OUT = `Sent m_42 to 4 agents:
- reviewer: delivered via push
- builder: read
- docs: queued
- old: sent via cli (handed over)

📨 2 unread Pulsar messages: call inbox to read.`;

describe("results", () => {
	test("resultBody strips the unread note and the You-are line", () => {
		expect(resultBody(SEND_OUT)).not.toContain("📨");
		expect(
			resultBody("2 agents (*):\n- a · [codex]\nYou are me (claude:1)."),
		).toBe("2 agents (*):\n- a · [codex]");
	});

	test("send receipts summarized", () => {
		const r = parseSend(SEND_OUT);
		expect(r.messageId).toBe("m_42");
		expect(r.receipts.map((x) => x.state)).toEqual([
			"delivered",
			"read",
			"queued",
			"sent",
		]);
		expect(r.receipts[3]!.detail).toBe("handed over");
		expect(receiptSummary(r.receipts)).toEqual([
			"delivered to 2",
			"1 queued",
			"sent to 1",
		]);
	});

	test("inline reply, timeout and decline", () => {
		expect(
			parseSend("Reply from reviewer:\nLooks good.\nShip it.\n(message m_9)")
				.reply,
		).toEqual({
			from: "reviewer",
			body: "Looks good.\nShip it.",
			id: "m_9",
		});
		const t = parseSend(
			"No reply to m_1 within 120s. Delivery:\n- reviewer: delivered\nA later reply will reach you as a normal message.",
		);
		expect(t.timedOut).toBe(true);
		expect(t.receipts).toHaveLength(1);
		expect(
			parseSend("m_1 was declined: - reviewer: nacked (busy)").declined,
		).toBe("declined");
	});

	test("messages, including a cut last one", () => {
		const m = parseMessages(`2 message(s):
- m_1 · from reviewer [codex] · 3m ago · urgent · wants a reply
  Please look at
  the diff.
- m_2 · from builder [claude] · 10s ago · reply to m_0
  Done`);
		expect(m).toHaveLength(2);
		expect(m[0]).toMatchObject({
			id: "m_1",
			from: { name: "reviewer", harness: "codex" },
			body: "Please look at\nthe diff.",
			priority: "urgent",
			wantsReply: true,
		});
		expect(m[1]!.replyTo).toBe("m_0");
	});

	test("list_agents and who", () => {
		const list = parseAgents(`14 agents (project=apparish):
- reviewer · [codex] · project=apparish · branch=main · idle · push
  doing: Reviewing PR 12
  id: codex:019a
- builder · [claude] · project=apparish · busy · pull-only
  id: claude:abc
- cut · [pi] · project=app`);
		expect(list.total).toBe(14);
		expect(list.agents[0]).toEqual({
			name: "reviewer",
			harness: "codex",
			status: "idle",
			activity: "Reviewing PR 12",
			id: "codex:019a",
		});
		expect(list.agents).toHaveLength(3);
		const who = parseAgents(
			"- reviewer (codex:019a) mbp/apparish [idle]\n    edits src/a.ts\n(3 more)",
		);
		expect(who.agents[0]).toMatchObject({
			name: "reviewer",
			id: "codex:019a",
			harness: "codex",
		});
		expect(who.total).toBe(4);
		expect(parseAgents('No live agents match "x".').empty).toBeTruthy();
	});

	test("identity", () => {
		expect(
			parseIdentity(
				"You are builder (claude:1)\nharness: claude\nactivity: Fixing #12\ntags: role:author, pr:12\nunread: 0",
			),
		).toEqual({
			name: "builder",
			id: "claude:1",
			harness: "claude",
			activity: "Fixing #12",
			tags: ["role:author", "pr:12"],
			unread: 0,
		});
	});

	test("wait outcomes", () => {
		expect(parseWait("Nothing happened within 300s.").timedOut).toBe(true);
		expect(parseWait("reviewer is idle.").idle).toBe("reviewer");
		const w = parseWait(
			"reply:\n- m_3 · from reviewer [codex] · 0s ago\n  Yes",
		);
		expect(w.event).toBe("reply");
		expect(w.message?.body).toBe("Yes");
	});
});

describe("describePulsar", () => {
	test("send while running and done", () => {
		const input = { to: "project=apparish", body: "hi", await_reply: true };
		const running = describePulsar("send", input, { done: false });
		expect(running).toMatchObject({
			verb: "Sending to",
			label: "Interrupt now",
			facts: ["waiting for reply"],
		});
		expect(running.chips[0]!.label).toBe("everyone on apparish");
		const done = describePulsar("send", input, {
			done: true,
			output: "Reply from reviewer:\nYes\n(message m_2)",
		});
		expect(done.facts).toEqual(["reply from reviewer"]);
		const plain = describePulsar(
			"send",
			{ to: "reviewer", body: "x", priority: "fyi" },
			{ done: true, output: SEND_OUT },
		);
		expect(plain.label).toBe("Don't wake");
		expect(plain.facts[0]).toBe("delivered to 2");
	});

	test("respond family", () => {
		expect(
			describePulsar(
				"respond",
				{ message_id: "m_1", state: "declined", text: "busy", retry: true },
				{ done: true, output: "m_1 will come back to you later." },
			),
		).toMatchObject({ verb: "Declined (retry later)", answers: "m_1" });
		expect(
			describePulsar(
				"ack",
				{ message_id: "m_1" },
				{ done: true, output: "Working on m_1." },
			).verb,
		).toBe("Working on it");
		expect(
			describePulsar(
				"done",
				{ message_id: "m_1" },
				{ done: true, output: "Marked m_1 done." },
			).verb,
		).toBe("Marked done");
		expect(
			describePulsar(
				"reply",
				{ message_id: "m_1", body: "ok" },
				{ done: true, output: "Replied with m_5:\n- reviewer: delivered" },
			).facts,
		).toEqual(["delivered to 1"]);
	});

	test("wait, lookup, inbox, identity", () => {
		expect(
			describePulsar(
				"wait",
				{ for: "idle:reviewer", timeout_seconds: 300 },
				{ done: true, output: "Nothing happened within 300s." },
			),
		).toMatchObject({
			verb: "Waited for",
			text: "to finish",
			facts: ["timed out after 5 min"],
		});
		expect(
			describePulsar(
				"list_agents",
				{ selector: "project=apparish" },
				{
					done: true,
					output:
						"2 agents (project=apparish):\n- a · [codex]\n  id: codex:1\n- b · [pi]\n  id: pi:2",
				},
			),
		).toMatchObject({
			verb: "Looked up agents",
			text: "everyone on apparish",
			facts: ["2 agents"],
		});
		const inbox = describePulsar(
			"inbox",
			{},
			{
				done: true,
				output:
					"2 message(s):\n- m_1 · from reviewer [codex] · 1m ago\n  a\n- m_2 · from reviewer [codex] · 1m ago\n  b",
			},
		);
		expect(inbox.verb).toBe("Read 2 messages");
		expect(inbox.chips).toEqual([
			{ label: "reviewer", agent: "reviewer", harness: "codex" },
		]);
		expect(describePulsar("set_identity", {}, { done: true }).verb).toBe(
			"Checked its identity",
		);
		expect(
			describePulsar(
				"set_identity",
				{ activity: "Fixing #12", tags_add: ["pr:12"] },
				{ done: true },
			),
		).toMatchObject({
			verb: "Set status:",
			text: "Fixing #12",
			chips: [{ label: "pr:12" }],
		});
	});

	test("a call that returned nothing claims no result", () => {
		expect(
			describePulsar("list_agents", {}, { done: true, output: "" }).facts,
		).toEqual([]);
		expect(
			describePulsar("inbox", {}, { done: true, output: "" }).facts,
		).toEqual([]);
	});

	test("errors read as their message", () => {
		expect(
			describePulsar(
				"send",
				{ to: "x", body: "y" },
				{ done: true, isError: true, output: 'pulsar: no agent matches "x"' },
			).error,
		).toBe("No agent matches \u201cx\u201d");
	});
});
