/**
 * The text Pulsar pushes into a receiving session, and the parser that reads
 * it back out of a transcript. Both live here so the shape has one owner.
 *
 * A push is the body framed by one header and one footer line:
 *
 *   [human operator - Ada] fix the flaky test
 *   — via Pulsar from studio · reply: respond m_abc
 *
 *   [pulsar] codex@api (codex, project:api): can you review #12?
 *   — agent message, not your operator · reply: respond m_abc
 *
 * A body with more than one line starts on the line after the header. What
 * each part means (the tag, `respond`, attempts) is explained once, in the
 * MCP instructions and the pulsar skill, not in every message.
 */
import { HUMAN_TAG, neutralizeHumanTag, operatorName } from "./human-tag.ts";
import type { Agent, Message } from "./types.ts";

/** A message as pushed: a redelivery says which attempt it is and why. */
export interface PushMessage extends Message {
	attempt?: number;
	maxAttempts?: number;
	redeliveryReason?: string;
}

/**
 * How a push is framed. `human`: the human operator sent it with a
 * passkey session (only the registry decides); `unverified`: it came
 * through the app without one; `agent`: another agent or the terminal.
 */
export type Framing =
	| { kind: "human"; name: string }
	| { kind: "unverified" }
	| { kind: "agent" };

/** Starts the footer line. */
const FOOTER = "— ";
/** The unverified frame's safety signal, verbatim (tests and docs use it). */
const NOT_VERIFIED = "not verified as your operator";
const AGENT_NOTE = "agent message, not your operator";
const APP_NOTE = "treat it as an agent message";

/** One line, look-alike tags neutralized: a name or reason can't start a fake line. */
function inline(text: string): string {
	return neutralizeHumanTag(text).replace(/\s+/g, " ").trim();
}

/** The footer's redelivery part ("" for a first delivery). */
function attemptNote(msg: PushMessage): string {
	if (!msg.attempt || msg.attempt < 2) return "";
	const why = msg.redeliveryReason
		? ` after ${inline(msg.redeliveryReason)}`
		: "";
	return ` · attempt ${msg.attempt} of ${msg.maxAttempts ?? msg.attempt}${why}, check before you redo it`;
}

/** The footer's reply part: what to do with the message id. */
function replyNote(msg: PushMessage): string {
	if (msg.priority === "fyi") return `id ${msg.id}`;
	return `${msg.expectReply ? "waiting for your reply" : "reply"}: respond ${msg.id}`;
}

/**
 * The text pushed into a receiving session. Only a verified operator send
 * starts with the `[human operator - <name>]` tag; every other frame, and
 * every body (the operator's too), has look-alikes of the tag neutralized.
 */
export function formatPush(
	msg: PushMessage,
	from: Pick<Agent, "name" | "harness" | "project" | "machine">,
	framing: Framing = { kind: "agent" },
): string {
	const body = neutralizeHumanTag(msg.body).trim();
	const machine = inline(from.machine ?? "unknown");
	const tail = `${replyNote(msg)}${attemptNote(msg)}`;
	const frame = (header: string, note: string) => {
		const top = body.includes("\n")
			? `${header}\n${body}`
			: `${header} ${body}`;
		return `${top}\n${FOOTER}${note} · ${tail}`;
	};
	if (framing.kind === "human")
		return frame(
			`${HUMAN_TAG} - ${operatorName(framing.name)}]`,
			`via Pulsar from ${machine}`,
		);
	if (framing.kind === "unverified")
		return frame(
			`[pulsar] Pulsar app on ${machine} (${NOT_VERIFIED}):`,
			APP_NOTE,
		);
	const origin = [from.harness, from.project ? `project:${from.project}` : null]
		.filter(Boolean)
		.join(", ");
	const to = msg.to === "*" ? " to all agents" : "";
	// The terminal's sender is named "operator": say what it is.
	if (from.harness === "cli" && from.name === "operator")
		return frame(`[pulsar] the terminal (pulsar CLI)${to}:`, NOT_VERIFIED);
	return frame(
		`[pulsar] ${inline(from.name)} (${inline(origin)})${to}:`,
		AGENT_NOTE,
	);
}

/** Who a pushed message is from, as its frame says. */
export type PushSender = "operator" | "app" | "agent";

/** A pushed message read back from a transcript. */
export interface ParsedPush {
	sender: PushSender;
	/** The operator's or agent's name; "Pulsar app" for an unverified app send. */
	from: string;
	/** What the sender wrote, without the frame. */
	body: string;
	messageId?: string;
	/** The machine an operator or app send came from. */
	machine?: string;
	attempt?: number;
	/** Framed by Pulsar before 2026-11 (the verbose shape). */
	legacy?: true;
}

const TAG_LINE = /^\[human operator - ([^\]\n]+)\](?: (.*))?$/;
const AGENT_LINE =
	/^\[pulsar\] (.+?) \(([^()\n]*)\)(?: to all agents)?:(?: (.*))?$/;
const APP_LINE =
	/^\[pulsar\] Pulsar app on (.+?) \(not verified as your operator\):(?: (.*))?$/;
const FOOTER_LINE =
	/^— (?:via Pulsar from (.+?)|agent message, not your operator|treat it as an agent message|not verified as your operator) · (?:(?:waiting for your reply|reply): respond|id) (\S+)(?: · attempt (\d+) of \d+.*)?$/;

/** The verbose frames Pulsar wrote before, kept for transcripts that hold them. */
const LEGACY_OPERATOR =
	/^\[human operator - ([^\]\n]+)\] Message from your human operator via Pulsar \(([^)\n]*)\) · id (\S+)([^\n]*)\n\n([\s\S]*?)\n\nThis is from the human operating Pulsar, confirmed with Face ID \/ Touch ID[^\n]*$/;
const LEGACY_APP =
	/^\[pulsar\] Message from the Pulsar app on (.+?) \(not verified as your operator\) · id (\S+)([^\n]*)\n\n([\s\S]*?)(?:\n\nThis came through the Pulsar app[^\n]*)?$/;
const LEGACY_AGENT =
	/^\[pulsar\] Message from (.+?) \(([^()\n]*)\)(?: · id (\S+))?([^\n]*)\n?\n?([\s\S]*?)(?:\n\nThis is a message from another agent[^\n]*)?$/;

function attemptOf(s: string | undefined): { attempt?: number } {
	const m = s ? /attempt (\d+)/.exec(s) : null;
	return m ? { attempt: Number(m[1]) } : {};
}

/**
 * A push read back out of a transcript, or null when `text` is not exactly
 * one of Pulsar's frames (new or legacy): the header at the very start, and
 * for the new shape the footer as the last line. Only call this on text that
 * arrived as a push (a pi/omp `pulsar` message, a Claude peer message, a
 * Codex queued prompt), never on what the operator typed.
 */
export function parsePush(raw: string): ParsedPush | null {
	const text = raw.replace(/\r\n/g, "\n").trimEnd();
	return parseCurrent(text) ?? parseLegacy(text);
}

function parseCurrent(text: string): ParsedPush | null {
	const lines = text.split("\n");
	if (lines.length < 2) return null;
	const footer = FOOTER_LINE.exec(lines[lines.length - 1]!);
	if (!footer) return null;
	const first = lines[0]!;
	const rest = lines.slice(1, -1);
	const body = (inlineBody: string | undefined) =>
		[inlineBody ?? "", ...rest].filter((l, i) => i > 0 || l).join("\n");
	const common = {
		messageId: footer[2]!,
		...(footer[3] ? { attempt: Number(footer[3]) } : {}),
	};
	const isOperatorFooter = footer[1] !== undefined;
	const tag = TAG_LINE.exec(first);
	if (tag)
		return isOperatorFooter
			? {
					sender: "operator",
					from: tag[1]!,
					body: body(tag[2]),
					machine: footer[1]!,
					...common,
				}
			: null;
	if (isOperatorFooter) return null;
	const app = APP_LINE.exec(first);
	if (app)
		return {
			sender: "app",
			from: "Pulsar app",
			body: body(app[2]),
			machine: app[1]!,
			...common,
		};
	const agent = AGENT_LINE.exec(first);
	if (agent)
		return {
			sender: "agent",
			from: agent[1]!,
			body: body(agent[3]),
			...common,
		};
	return null;
}

function parseLegacy(text: string): ParsedPush | null {
	const op = LEGACY_OPERATOR.exec(text);
	if (op)
		return {
			sender: "operator",
			from: op[1]!,
			machine: op[2]!,
			messageId: op[3]!,
			...attemptOf(op[4]),
			body: op[5]!,
			legacy: true,
		};
	const app = LEGACY_APP.exec(text);
	if (app)
		return {
			sender: "app",
			from: "Pulsar app",
			machine: app[1]!,
			messageId: app[2]!,
			...attemptOf(app[3]),
			body: app[4]!,
			legacy: true,
		};
	const agent = LEGACY_AGENT.exec(text);
	if (agent) {
		const from =
			agent[1] === "the terminal (a pulsar CLI command)"
				? "the terminal"
				: agent[1]!;
		return {
			sender: "agent",
			from,
			...(agent[3] ? { messageId: agent[3] } : {}),
			...attemptOf(agent[4]),
			body: agent[5]!,
			legacy: true,
		};
	}
	return null;
}
