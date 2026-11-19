import { describe, expect, test } from "bun:test";
import { parseClaude } from "../src/harnesses/claude-transcript.ts";
import { taskNotice, teammateMessages } from "../src/transcripts/team.ts";
import { NOTICE_TEXT_CAP, newParseState } from "../src/transcripts/types.ts";

/** Synthetic Claude Code agent-team records: nothing here is real content. */
const tag = (attrs: string, body: string) =>
	`<teammate-message ${attrs}>\n${body}\n</teammate-message>`;
const wrapped = (...m: string[]) =>
	`Another Claude session sent a message:\n${m.join("\n\n")}\n\nThis came from another Claude session — not typed by your user.`;
const idle = (extra: object = {}) =>
	JSON.stringify({
		type: "idle_notification",
		from: "worker",
		timestamp: "2026-11-18T16:12:28.623Z",
		...extra,
	});
let n = 0;
const userLine = (content: unknown, extra: object = {}) =>
	JSON.stringify({
		type: "user",
		uuid: `u${++n}`,
		timestamp: "2026-11-18T16:12:30.000Z",
		message: { role: "user", content },
		...extra,
	});
const parse = (line: string) => parseClaude(line, newParseState());

describe("teammate messages", () => {
	test("idle notification with a result: Markdown body, no JSON", () => {
		const result = "Done.\n\n| A | B |\n|---|---|\n| 1 | 2 |";
		const [e, ...rest] = parse(
			userLine(
				wrapped(
					tag(
						'teammate_id="worker" color="blue" summary="Fixes ready"',
						idle({ idleReason: "available", result }),
					),
				),
			),
		);
		expect(rest).toEqual([]);
		expect(e).toMatchObject({
			role: "peer",
			kind: "peer",
			from: "worker",
			text: result,
			notice: {
				type: "idle_notification",
				color: "blue",
				summary: "Fixes ready",
				status: "available",
			},
		});
		expect(e!.text).not.toContain('"type"');
		expect(e!.text).not.toContain("This came from another Claude session");
	});

	test("several messages in one record: one event each, ids from the line", () => {
		const line = userLine(
			wrapped(
				tag('teammate_id="a" color="green"', idle({ from: "a" })),
				tag('teammate_id="b" summary="hi"', "plain **text**"),
				tag('teammate_id="c" color="red"', idle({ from: "c", result: "ok" })),
			),
		);
		const events = parse(line);
		expect(events.map((e) => e.from)).toEqual(["a", "b", "c"]);
		const id = events[0]!.id;
		expect(events.map((e) => e.id)).toEqual([id, `${id}#t1`, `${id}#t2`]);
		expect(events[0]).toMatchObject({ text: "", notice: { color: "green" } });
		expect(events[1]).toMatchObject({
			text: "plain **text**",
			notice: { type: "message", summary: "hi" },
		});
		expect(events[1]!.notice?.color).toBeUndefined();
		// Same ids when the line is parsed again with fresh state.
		expect(parse(line).map((e) => e.id)).toEqual(events.map((e) => e.id));
	});

	test("bare tags (a teammate's own log) are peer events, not user text", () => {
		const events = parse(
			userLine(
				tag(
					'teammate_id="team-lead" color="orange" summary="Take the task"',
					"Please take the parser task.",
				),
				{ isSidechain: true, agentId: "agent-1" },
			),
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			role: "peer",
			from: "team-lead",
			sidechain: "agent-1",
			text: "Please take the parser task.",
			notice: { type: "message", color: "orange", summary: "Take the task" },
		});
	});

	test("queued while busy (attachment) and with a peer origin", () => {
		const body = wrapped(tag('teammate_id="w"', idle({ result: "r" })));
		const [a] = parse(
			JSON.stringify({
				type: "attachment",
				uuid: "q1",
				timestamp: "2026-11-18T16:12:30.000Z",
				attachment: { type: "queued_command", prompt: body },
			}),
		);
		expect(a).toMatchObject({ role: "peer", text: "r", from: "worker" });
		const [b] = parse(userLine(body, { origin: { kind: "peer", name: "w" } }));
		expect(b).toMatchObject({ role: "peer", text: "r" });
	});

	test("failed idle: status failed, the failure as body", () => {
		const [e] = teammateMessages(
			tag(
				'teammate_id="t"',
				idle({ idleReason: "failed", failureReason: "Browser died" }),
			),
		)!;
		expect(e).toMatchObject({
			text: "Browser died",
			notice: { type: "idle_notification", status: "failed" },
		});
	});

	test("failed after a result: both, the failure last", () => {
		const [e] = teammateMessages(
			tag(
				'teammate_id="t"',
				idle({
					idleReason: "failed",
					result: "Half done",
					failureReason: "OOM",
				}),
			),
		)!;
		expect(e!.text).toBe("Half done\n\n**Failed:** OOM");
		expect(e!.notice.status).toBe("failed");
	});

	test("protocol responses: approve becomes approved/rejected", () => {
		const [yes, no] = teammateMessages(
			tag(
				'teammate_id="x"',
				'{"type":"plan_approval_response","request_id":"r","approve":true}',
			) +
				tag(
					'teammate_id="x"',
					'{"type":"shutdown_response","request_id":"r","approve":false,"reason":"busy"}',
				),
		)!;
		expect(yes!.notice).toMatchObject({
			type: "plan_approval_response",
			status: "approved",
		});
		expect(no).toMatchObject({
			text: "busy",
			notice: { type: "shutdown_response", status: "rejected" },
		});
	});

	test("unknown type with no text field: its fields as a JSON block", () => {
		const [e] = teammateMessages(
			tag('teammate_id="x"', '{"type":"frob_event","count":3}'),
		)!;
		expect(e!.notice.type).toBe("frob_event");
		expect(e!.text).toContain("```json");
		expect(e!.text).toContain('"count": 3');
	});

	test("malformed or unexpected JSON falls back to the plain body", () => {
		for (const body of [
			'{"type":"idle_notification", "result": "cut',
			'{"no_type": true}',
			'{"type": 7}',
			'{"type": "<img src=x onerror=alert(1)>"}',
			"[1, 2]",
		]) {
			const [e] = teammateMessages(tag('teammate_id="x"', body))!;
			expect(e).toMatchObject({ text: body, notice: { type: "message" } });
		}
	});

	test("missing fields and hostile attributes stay bounded", () => {
		const [e] = teammateMessages(
			tag(
				`teammate_id="${"n".repeat(500)}" color="#fff;background:url(x)" summary="${"s ".repeat(400)}"`,
				'{"type":"idle_notification"}',
			),
		)!;
		expect(e!.text).toBe("");
		expect(e!.notice.color).toBeUndefined();
		expect(e!.notice.summary!.length).toBeLessThanOrEqual(200);
		expect(e!.from!.length).toBeLessThanOrEqual(80);
		const [bare] = teammateMessages("<teammate-message>hi</teammate-message>")!;
		expect(bare).toEqual({ text: "hi", notice: { type: "message" } });
	});

	test("a huge result is cut at the cap", () => {
		const [e] = teammateMessages(
			tag('teammate_id="x"', idle({ result: "x".repeat(200_000) })),
		)!;
		expect(e!.text.length).toBeLessThanOrEqual(NOTICE_TEXT_CAP + 3);
		expect(e!.text.endsWith("…")).toBe(true);
	});

	test("ordinary text that mentions the tag is left alone", () => {
		const [e] = parse(
			userLine("Why does <teammate-message> show raw JSON in the app?"),
		);
		expect(e).toMatchObject({ role: "user", kind: "text" });
		expect(e!.notice).toBeUndefined();
	});

	test("other cross-session tags keep the plain peer rendering", () => {
		const [e] = parse(
			userLine(
				'Another Claude session sent a message:\n<cross-session-message from-name="pal">\nhello\n</cross-session-message>',
				{ origin: { kind: "peer", name: "pal" } },
			),
		);
		expect(e).toMatchObject({ role: "peer", from: "pal" });
		expect(e!.notice).toBeUndefined();
	});
});

describe("task notifications", () => {
	test("a result becomes a notice; without one, the summary row stays", () => {
		const withResult =
			"<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent done</summary>\n<result>Found **3**</result>\n</task-notification>";
		expect(taskNotice(withResult)).toEqual({
			text: "Found **3**",
			notice: {
				type: "task_notification",
				summary: "Agent done",
				status: "completed",
			},
		});
		const [e] = parse(
			userLine(withResult, { origin: { kind: "task-notification" } }),
		);
		expect(e).toMatchObject({
			role: "system",
			subtype: "task",
			text: "Found **3**",
		});
		const [plain] = parse(
			userLine(
				"<task-notification>\n<summary>Done</summary>\n</task-notification>",
				{
					origin: { kind: "task-notification" },
				},
			),
		);
		expect(plain).toMatchObject({ subtype: "task", text: "Done" });
		expect(plain!.notice).toBeUndefined();
	});
});
