/**
 * What a push notification says: title, body, tag and the screen a tap
 * opens. Pure functions, unit tested (test/push-copy.test.ts).
 *
 * Bodies show on the lock screen, so every piece of agent or harness text
 * goes through `clean` (secrets redacted first, then markdown, control and
 * bidi characters stripped) and is cut short at a word boundary. Titles say
 * who and what happened ("api-fix finished"); bodies say the specific thing
 * ("Run `bun test auth`? · pulsar"). No ids, no exclamation marks.
 *
 * With previews off (a subscription's "Show previews on the lock screen"),
 * `generic` gives the same notice without names or text.
 */
import type {
	Approval,
	LimitWarning,
	SecurityNotice,
	TurnKind,
	TurnSummary,
} from "../http/wire.ts";

export type { TurnSummary };

import { redactSecrets } from "../search/redact.ts";
import { describeCall, toolLabel } from "../transcripts/describe.ts";
import type { Agent } from "../types.ts";

export const TITLE_MAX = 40;
export const BODY_MAX = 120;
/** Longest summary or error text a turn record keeps (the pool feed carries it). */
export const SUMMARY_MAX = 200;

export interface Notice {
	title: string;
	body: string;
	/** One notification per tag: a newer one replaces it. */
	tag: string;
	/** The app route a tap opens (`/#/…`). */
	url: string;
}

/** Who a notice is about. */
export interface Who {
	name: string;
	project: string | null;
	/** Shown only when the pool has more than one machine. */
	machine: string | null;
}

// ------------------------------------------------------------------ text

/** Control, format (bidi, zero-width) characters; newlines stay for the markdown rules. */
const INVISIBLE = /(?!\n)[\p{Cc}\p{Cf}]/gu;

/**
 * Agent or harness text made safe and plain for a notification: secrets
 * redacted (before anything is cut, so a token is never left half-matched),
 * markdown, control and bidi characters removed, whitespace collapsed.
 */
export function clean(text: string): string {
	return redactSecrets(text)
		.replace(INVISIBLE, " ")
		.replace(/```[^\n]*\n?/g, " ")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
		.replace(/`/g, "")
		.replace(/<\/?[a-z][^>]*>/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** A command or path: secrets redacted and invisible characters removed, markdown kept as typed. */
export function cleanCode(text: string): string {
	return redactSecrets(text)
		.replace(INVISIBLE, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** `text` cut to `max` characters at a word boundary, with an ellipsis. */
export function clip(text: string, max: number): string {
	const t = text.trim();
	if (t.length <= max) return t;
	if (max <= 1) return "…";
	const room = t.slice(0, max - 1);
	// A word that ends right at the cut stays whole.
	const space = t[max - 1] === " " ? room.length : room.lastIndexOf(" ");
	const cut = space >= Math.floor(max * 0.5) ? room.slice(0, space) : room;
	return `${cut.replace(/[\s.,;:!?…-]+$/, "")}…`;
}

/** The first sentence of cleaned text; a closing "!" becomes ".". */
export function firstSentence(text: string): string {
	const m = /^(.+?[.!?])(?=\s+["'(`A-Z0-9]|\s*$)/.exec(text);
	const s = (m ? m[1]! : text).trim();
	return s.replace(/!+$/, ".");
}

/** Openers that say nothing on their own ("Done.", "All set."). */
const FILLER =
	/^(?:done|all (?:set|done)|finished|complete[d]?|ok(?:ay)?|great|perfect|got it|sure)\b[\s\w]{0,8}[.!]?$/i;

/** The first sentence that says something: a filler opener is skipped. */
export function gist(text: string): string {
	let rest = text.trim();
	for (let i = 0; i < 3 && rest; i++) {
		const s = firstSentence(rest);
		const after = rest
			.slice(rest.indexOf(s.replace(/\.$/, "")) + s.length)
			.trim();
		if (!FILLER.test(s) || !after) return s;
		rest = after;
	}
	return firstSentence(text);
}

/** "45 s", "4 min", "1 h 5 min", "3 days 2 h". */
export function duration(ms: number): string {
	const s = Math.max(1, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	const min = Math.round(s / 60);
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	if (h >= 24) {
		const days = Math.floor(h / 24);
		const rest = h % 24;
		return `${days} ${days === 1 ? "day" : "days"}${rest ? ` ${rest} h` : ""}`;
	}
	const rest = min % 60;
	return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** "api-fix finished": the name is cut so the verb always shows. */
function title(who: Who, what: string): string {
	const name = who.machine ? `${who.name} on ${who.machine}` : who.name;
	const room = TITLE_MAX - what.length - 1;
	const fit =
		name.length <= room || !who.machine
			? clip(name, room)
			: clip(who.name, room);
	return `${fit} ${what}`;
}

/** The parts joined with " · ", the first one cut so the rest fit. */
function body(main: string, ...rest: Array<string | null | undefined>): string {
	const tail = rest.filter((p): p is string => !!p).join(" · ");
	if (!main) return clip(tail, BODY_MAX);
	if (!tail) return clip(main, BODY_MAX);
	const room = BODY_MAX - tail.length - 3;
	if (room < 24) return clip(main, BODY_MAX);
	return `${clip(main, room)} · ${tail}`;
}

/** The project, unless the agent's name already says it. */
function where(who: Who): string | null {
	if (!who.project) return null;
	return who.name.toLowerCase().includes(who.project.toLowerCase())
		? null
		: who.project;
}

/** The few registry reads `whoOf` needs. */
export interface WhoSource {
	find(id: string): Agent | undefined;
	/** Set when this machine is in a pool with others. */
	readonly pool: unknown;
}

/** Who an agent is, for a notice ("An agent" when it is gone). */
export function whoOf(registry: WhoSource, agentId: string): Who {
	const a = registry.find(agentId);
	const name = clip(clean(a?.name ?? ""), TITLE_MAX) || "An agent";
	const project = a?.project ? clip(clean(a.project), 40) || null : null;
	const machine =
		registry.pool && a?.machine ? clip(clean(a.machine), 24) || null : null;
	return { name, project, machine };
}

const agentUrl = (agentId: string) => `/#/a/${encodeURIComponent(agentId)}`;
const approvalUrl = (agentId: string) =>
	`/#/approval/${encodeURIComponent(agentId)}`;
/** One notification per agent: a prompt, then its finish, replace each other. */
export const agentTag = (ref: string) => `agent:${ref}`;

// ------------------------------------------------------------- approvals

/** Present participles `describeCall` uses → the imperative for a question. */
const IMPERATIVE: Record<string, string> = {
	Running: "Run",
	Editing: "Edit",
	Writing: "Write",
	Creating: "Create",
	Reading: "Read",
	Fetching: "Fetch",
	Searching: "Search",
	Listing: "List",
	Calling: "Use",
	Patching: "Edit",
	Deleting: "Delete",
	Viewing: "View",
	Opening: "Open",
	Starting: "Start",
};

/** "Run `bun test auth`?", "Edit src/auth/session.ts?", "Use Notebook edit?" */
export function actionLine(
	tool: string,
	input: unknown,
	cwd: string | null,
	max = BODY_MAX,
): string {
	let line: ReturnType<typeof describeCall> | null = null;
	try {
		line = describeCall(tool, input, { cwd, done: false });
	} catch {}
	const verb = line ? IMPERATIVE[line.verb] : undefined;
	const target = line?.target ? cleanCode(line.target.text) : "";
	if (!verb || !target) return `Use ${clip(clean(toolLabel(tool)), max - 5)}?`;
	if (line?.target?.as === "cmd") {
		const room = max - verb.length - 4;
		return `${verb} \`${clip(target.replace(/`/g, "'"), room)}\`?`;
	}
	return `${verb} ${clip(target, max - verb.length - 2)}?`;
}

/** A plan's first sentence: a short title heading ("# Plan") is skipped. */
function planLine(plan: string): string {
	const lines = plan.split("\n").filter((l) => l.trim());
	const label = (l: string) =>
		/^\s{0,3}#/.test(l) && l.replace(/#/g, "").trim().split(/\s+/).length <= 3;
	return firstSentence(clean(lines.find((l) => !label(l)) ?? lines[0] ?? ""));
}

/** A prompt waiting for the operator: a permission, a question, a plan. */
export function approvalNotice(a: Approval, who: Who, ref: string): Notice {
	const p = a.prompt;
	const kind = a.kind ?? "permission";
	const proj = where(who);
	const base = { tag: agentTag(ref), url: approvalUrl(a.agentId) };
	if (kind === "permission" || !p) {
		const room = proj ? BODY_MAX - proj.length - 3 : BODY_MAX;
		return {
			...base,
			title: title(who, "needs approval"),
			body: body(actionLine(a.tool, a.input, a.cwd, room), proj),
		};
	}
	switch (p.kind) {
		case "question": {
			const qs = p.questions.map((q) => clean(q.question)).filter(Boolean);
			const more = qs.length > 1 ? `+${qs.length - 1} more` : null;
			return {
				...base,
				title: title(who, qs.length > 1 ? "has questions" : "has a question"),
				body: body(qs[0] ?? clean(p.title ?? ""), more, proj),
			};
		}
		case "plan":
			return {
				...base,
				title: title(who, "has a plan to review"),
				body: body(planLine(p.plan), proj),
			};
		case "confirm":
			return {
				...base,
				title: title(who, "asks you to confirm"),
				body: body(clean(p.message || p.title), proj),
			};
		case "select":
			return {
				...base,
				title: title(who, "asks you to choose"),
				body: body(clean(p.title), proj),
			};
		case "input":
			return {
				...base,
				title: title(who, "needs your input"),
				body: body(clean(p.title), proj),
			};
	}
	return { ...base, title: title(who, "needs you"), body: body("", proj) };
}

// ----------------------------------------------------------------- turns

/** Harness errors in plain words; anything else, its first sentence. */
export function plainError(raw: string): string {
	const t = clean(raw);
	const code = /\b(?:API Error|status)[: ]+(\d{3})\b/i.exec(t)?.[1];
	const resets = /\bresets? (?:at )?([^·()\n]{2,24}?)(?:\s*[·(]|$)/i.exec(
		t,
	)?.[1];
	if (/hit your (?:\w+ )?limit|usage limit|limit reached/i.test(t))
		return resets
			? `Usage limit reached. Resets ${resets.trim()}.`
			: "Usage limit reached.";
	if (/overloaded|\b529\b/i.test(t))
		return "The model service is overloaded. Try again soon.";
	if (/rate.?limit|\b429\b/i.test(t))
		return "The model service is rate limiting requests.";
	if (/prompt is too long|context (?:window|length)|too many tokens/i.test(t))
		return "The conversation is too long for the model.";
	if (/invalid api key|authenticat|\b401\b|oauth token/i.test(t))
		return "Sign-in to the model service failed.";
	if (
		/stream disconnected|connection (?:reset|closed|error)|ECONNRESET|fetch failed/i.test(
			t,
		)
	)
		return "The connection to the model service dropped.";
	if (code) return `The model service returned an error (${code}).`;
	const s = firstSentence(t);
	if (!s) return "The harness stopped the turn with an error.";
	const cap = s.charAt(0).toUpperCase() + s.slice(1);
	return /[.?]$/.test(cap) ? cap : `${cap}.`;
}

/** An agent finished its turn, or stopped with an error. */
export function turnNotice(
	kind: TurnKind,
	agentId: string,
	who: Who,
	ref: string,
	s: TurnSummary = {},
	at = Date.now(),
): Notice {
	const proj = where(who);
	const took =
		s.startedAt && at > s.startedAt ? duration(at - s.startedAt) : null;
	const files =
		s.files && s.files > 0
			? `${s.files} ${s.files === 1 ? "file" : "files"} changed`
			: null;
	const base = { tag: agentTag(ref), url: agentUrl(agentId) };
	if (kind === "failed")
		return {
			...base,
			title: title(who, "stopped with an error"),
			body: body(
				s.error ? plainError(s.error) : "Open it to see what went wrong.",
				proj,
			),
		};
	const said = s.text ? gist(clean(s.text)) : "";
	return {
		...base,
		title: title(who, "finished"),
		body: said
			? body(said, proj, took, files)
			: body(
					took ? `Took ${took}` : "Ready for your next message",
					proj,
					files,
				),
	};
}

// ---------------------------------------------------------------- limits

/** "in 2 h 10 min" from now; the daemon's clock zone is not the phone's. */
function resetsIn(at: number | null, now: number): string | null {
	if (at === null || at <= now) return null;
	return `Resets in ${duration(Math.max(60_000, at - now))}.`;
}

const inline = (label: string) =>
	label === "Usage" ? "usage" : label.charAt(0).toLowerCase() + label.slice(1);

/** A plan usage limit passed a threshold or was reached. */
export function limitNotice(
	w: LimitWarning,
	harness: string,
	machine: string | null,
	now = Date.now(),
): Notice {
	const used = Math.round(w.usedPercent ?? w.level);
	const on = machine ? ` on ${machine}` : "";
	const resets = resetsIn(w.resetsAt, now);
	return {
		title: clip(
			w.reached
				? `${harness} hit its ${inline(w.label)} limit`
				: `${harness} at ${used}% of ${inline(w.label)} limit`,
			TITLE_MAX,
		),
		body: clip(
			w.reached
				? `Agents${on} pause until it resets.${resets ? ` ${resets}` : ""}`
				: `${resets ?? "Plan the rest of the window."} Usage page has the details.`,
			BODY_MAX,
		),
		tag: `limit:${w.harness}:${w.label}`,
		url: "/#/usage",
	};
}

// -------------------------------------------------------------- security

const SECURITY_TITLES: Record<SecurityNotice["kind"], string> = {
	"passkey-added": "New passkey added",
	"passkey-removed": "Passkey removed",
	enrollment: "New device enrolled",
	"push-subscribed": "Notifications turned on",
	"pool-changed": "Machines in your pool changed",
	"pool-conflict": "A machine was refused",
	"pool-reinstall": "A machine was reinstalled",
	"reply-failed": "An answer did not reach the agent",
};

/** A passkey, enrollment or pool change; the body is the notice's own line. */
export function securityNotice(n: SecurityNotice): Notice {
	return {
		title: SECURITY_TITLES[n.kind] ?? "Security notice",
		body: clip(
			`${clean(n.message)}. Not you? Check Settings.`.replace(/\.\./g, "."),
			BODY_MAX,
		),
		tag: "security",
		url: "/",
	};
}

// --------------------------------------------------------------- generic

/** The same notice without names or text (previews off). */
export function generic(
	kind: "approval" | "question" | TurnKind | "limit" | "security",
	n: Notice,
): Notice {
	const copy: Record<typeof kind, [string, string]> = {
		approval: ["Approval needed", "An agent is waiting for your approval."],
		question: ["Answer needed", "An agent is waiting for your answer."],
		finished: ["An agent finished", "Open Pulsar to see what it did."],
		failed: [
			"An agent stopped with an error",
			"Open Pulsar to see what went wrong.",
		],
		limit: [
			"Usage limit warning",
			"Open Pulsar to see which plan and when it resets.",
		],
		security: [
			"Security notice",
			"A passkey or device change. Open Pulsar to check.",
		],
	};
	const [t, b] = copy[kind];
	return { ...n, title: t, body: b };
}
