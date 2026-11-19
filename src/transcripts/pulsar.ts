/**
 * Pulsar's own MCP tool calls, read from any harness's transcript: which
 * Pulsar tool a call is, and what its arguments and plain-text result say
 * (the formats in src/mcp.ts and src/format.ts). Pure: shared by the app's
 * bespoke Pulsar card and its tests.
 */

/** Every tool the Pulsar MCP server answers, hidden aliases included. */
export const PULSAR_TOOLS = [
	"list_agents",
	"who",
	"send",
	"ask",
	"respond",
	"reply",
	"ack",
	"done",
	"nack",
	"wait",
	"inbox",
	"history",
	"set_identity",
	"whoami",
] as const;

export type PulsarTool = (typeof PULSAR_TOOLS)[number];

const TOOLS = new Set<string>(PULSAR_TOOLS);

/**
 * The Pulsar tool a call name stands for, or null. Names by harness: Claude
 * `mcp__pulsar__send`, pi `mcp_pulsar_send`, omp `mcp__pulsar_send`, OpenCode
 * `pulsar_send`, and `pulsar__send` / `pulsar.send`. A bare `send` or `wait`
 * is some other tool (Codex has its own `wait`).
 */
export function pulsarTool(name: string): PulsarTool | null {
	const m = /^(?:mcp__?)?pulsar(?:__|_|\.)([a-z_]+)$/i.exec(name);
	if (!m) return null;
	const tool = m[1]!.toLowerCase().replace(/^_+/, "");
	return TOOLS.has(tool) ? (tool as PulsarTool) : null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: typeof v === "string" && v.trim().startsWith("{")
			? parseObject(v)
			: {};

function parseObject(s: string): Record<string, unknown> {
	try {
		const v = JSON.parse(s) as unknown;
		return v && typeof v === "object" && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// ------------------------------------------------------------------ people

/** An agent named in a call or its result; `id` when the result gave it. */
export interface PulsarAgent {
	name: string;
	harness?: string;
	id?: string;
	/** What the agent said it is doing (list results). */
	activity?: string;
	/** idle, busy, … (list results). */
	status?: string;
}

/** A recipient: an agent by name, or a group in plain words. */
export interface Recipient {
	/** "reviewer", "everyone on apparish", "everyone". */
	label: string;
	/** Set for a single agent (name or id), to link and draw its avatar. */
	agent?: string;
	/** The selector as typed, for a group. */
	selector?: string;
}

/** `to` in plain words: "*" → everyone, "project=apparish" → everyone on apparish. */
export function recipients(to: string): Recipient[] {
	const t = to.trim();
	if (!t) return [];
	if (t === "*") return [{ label: "everyone", selector: "*" }];
	if (!t.includes("=")) return [{ label: t, agent: t }];
	const terms = t.split(/\s+/).filter(Boolean);
	const parts: string[] = [];
	let who = "everyone";
	for (const term of terms) {
		const [k = "", v = ""] = term.split("=");
		switch (k.toLowerCase()) {
			case "project":
				parts.push(`on ${v}`);
				break;
			case "branch":
				parts.push(`on branch ${v}`);
				break;
			case "harness":
				who = `every ${v} agent`;
				break;
			case "machine":
				parts.push(`on ${v}`);
				break;
			case "status":
				parts.push(v === "idle" ? "who is idle" : `who is ${v}`);
				break;
			case "model":
				parts.push(`running ${v}`);
				break;
			default:
				parts.push(`tagged ${k}:${v}`);
		}
	}
	return [{ label: [who, ...parts].join(" "), selector: t }];
}

/** How urgent a send is, as the person reading it says it. */
export function priorityLabel(p: string | undefined): string | undefined {
	switch (p) {
		case "urgent":
			return "Interrupt now";
		case "normal":
			return "Next turn";
		case "fyi":
			return "Don't wake";
		default:
			return undefined;
	}
}

// ------------------------------------------------------------------ results

/** A result without the notes Pulsar appends for the agent (unread count, "You are …"). */
export function resultBody(text: string): string {
	return text
		.replace(/\n*📨 \d+ unread Pulsar messages?:.*$/s, "")
		.replace(/\nYou are [^\n]+ \([^\n)]+\)\.\s*$/, "")
		.trim();
}

/** An error result: "pulsar: no agent matches" → "No agent matches". */
export function errorMessage(text: string): string {
	const t = text
		.trim()
		.replace(/^pulsar:\s*/i, "")
		.replace(/^MCP error -?\d+:\s*/i, "");
	return t.charAt(0).toUpperCase() + t.slice(1);
}

export interface Receipt {
	name: string;
	state: string;
	detail?: string;
}

/** `- reviewer: delivered via push (…)` lines. */
function parseReceipts(text: string): Receipt[] {
	const out: Receipt[] = [];
	for (const line of text.split("\n")) {
		const m =
			/^- (.+?): ([a-z]+)(?: · attempt \d+)?(?: via \S+)?(?: \((.*)\))?$/.exec(
				line.trim(),
			);
		if (m)
			out.push({
				name: m[1]!,
				state: m[2]!,
				...(m[3] ? { detail: m[3] } : {}),
			});
	}
	return out;
}

/** States a recipient has the message in. */
const REACHED = new Set(["delivered", "read", "replied", "done", "acked"]);

/** "delivered to 3 · 1 queued": receipts counted by state, reached first. */
export function receiptSummary(receipts: Receipt[]): string[] {
	if (!receipts.length) return [];
	const counts = new Map<string, number>();
	let reached = 0;
	for (const r of receipts) {
		if (REACHED.has(r.state)) reached++;
		else counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
	}
	const out = reached ? [`delivered to ${reached}`] : [];
	for (const [state, n] of counts)
		out.push(state === "sent" ? `sent to ${n}` : `${n} ${state}`);
	return out;
}

/** A message in an inbox, history or wait result. */
export interface PulsarMessage {
	id: string;
	from: PulsarAgent;
	body: string;
	ago?: string;
	priority?: string;
	wantsReply?: boolean;
	replyTo?: string;
}

/**
 * `- m_1 · from reviewer [codex] · 3m ago · urgent · wants a reply` then the
 * body indented by two spaces (src/format.ts messageText). A cut result
 * keeps the messages it holds.
 */
export function parseMessages(text: string): PulsarMessage[] {
	const out: PulsarMessage[] = [];
	let cur: PulsarMessage | null = null;
	for (const line of text.split("\n")) {
		const head =
			/^- (\S+) · from (.+?)(?: \[([^\]]+)\])? · (\d+[smhd] ago)(.*)$/.exec(
				line,
			);
		if (head) {
			const rest = head[5] ?? "";
			cur = {
				id: head[1]!,
				from: { name: head[2]!, ...(head[3] ? { harness: head[3] } : {}) },
				body: "",
				ago: head[4]!,
				...(/ · (urgent|fyi)\b/.exec(rest)
					? { priority: / · (urgent|fyi)\b/.exec(rest)![1] }
					: {}),
				...(rest.includes("wants a reply") ? { wantsReply: true } : {}),
				...(/ · reply to (\S+)/.exec(rest)
					? { replyTo: / · reply to (\S+)/.exec(rest)![1] }
					: {}),
			};
			out.push(cur);
			continue;
		}
		if (!cur) continue;
		if (line.startsWith("  ")) {
			cur.body = cur.body ? `${cur.body}\n${line.slice(2)}` : line.slice(2);
		} else {
			cur = null;
		}
	}
	return out;
}

/** Agents in a list_agents or who result, and how many matched in all. */
export function parseAgents(text: string): {
	agents: PulsarAgent[];
	total: number;
	empty?: string;
} {
	const t = resultBody(text);
	const none = /^(No live agents match "[^"]*"\.|Nobody matches .*)$/s.exec(t);
	if (none) return { agents: [], total: 0, empty: none[1]!.split("\n")[0] };
	const agents: PulsarAgent[] = [];
	let cur: PulsarAgent | null = null;
	for (const line of t.split("\n")) {
		// list: `- name · [harness] · project=x · … · idle · push`
		const list = /^- (.+?) · \[([^\]]+)\](.*)$/.exec(line);
		if (list) {
			const bits = (list[3] ?? "").split(" · ").map((b) => b.trim());
			const status = bits.find((b) =>
				/^(idle|busy|working|needs-you|waiting|offline|unknown)$/.test(b),
			);
			cur = {
				name: list[1]!,
				harness: list[2]!,
				...(status ? { status } : {}),
			};
			agents.push(cur);
			continue;
		}
		// who: `- name (id) machine/project [state]`
		const who = /^- (.+?) \(([^)\s]+)\)(?: \S+)? \[([^\]]+)\]$/.exec(line);
		if (who) {
			const id = who[2]!;
			cur = {
				name: who[1]!,
				id,
				status: who[3]!,
				...(/^([a-z]+):/.test(id)
					? { harness: /^([a-z]+):/.exec(id)![1] }
					: {}),
			};
			agents.push(cur);
			continue;
		}
		if (!cur) continue;
		const doing = /^\s+doing: (.*)$/.exec(line);
		if (doing) cur.activity = doing[1]!;
		const id = /^\s+id: (\S+)$/.exec(line);
		if (id) cur.id = id[1]!;
	}
	const header = /^(\d+) agents? \(/.exec(t);
	const more = /\n\((\d+) more\)\s*$/.exec(t);
	const total = header
		? Number(header[1])
		: agents.length + (more ? Number(more[1]) : 0);
	return { agents, total };
}

/** Identity lines: `You are name (id)`, `activity: …`, `tags: a, b`. */
export function parseIdentity(text: string): {
	name?: string;
	id?: string;
	harness?: string;
	activity?: string;
	tags: string[];
	unread?: number;
} {
	const t = resultBody(text);
	const me = /You are (.+?) \(([^)]+)\)/.exec(t);
	const field = (k: string) => {
		const v = new RegExp(`^${k}: (.*)$`, "m").exec(t)?.[1]?.trim();
		return v && v !== "-" ? v : undefined;
	};
	const tags = field("tags");
	const unread = field("unread");
	const harness = field("harness");
	const activity = field("activity");
	return {
		...(me ? { name: me[1]!, id: me[2]! } : {}),
		...(harness ? { harness } : {}),
		...(activity ? { activity } : {}),
		tags: tags ? tags.split(/,\s*/).filter(Boolean) : [],
		...(unread !== undefined ? { unread: Number(unread) } : {}),
	};
}

// ------------------------------------------------------------------ calls

/** What a send or ask returned. */
export interface SendOutcome {
	messageId?: string;
	receipts: Receipt[];
	/** The reply that came back inline (await_reply / ask). */
	reply?: { from: string; body: string; id?: string };
	/** await_reply ran out of time. */
	timedOut?: boolean;
	/** The recipient declined, or Pulsar gave up delivering. */
	declined?: "declined" | "given up";
}

export function parseSend(text: string): SendOutcome {
	const t = resultBody(text);
	const reply = /^Reply from (.+?):\n([\s\S]*?)(?:\n\(message (\S+)\))?$/.exec(
		t,
	);
	if (reply)
		return {
			receipts: [],
			reply: {
				from: reply[1]!,
				body: reply[2]!,
				...(reply[3] ? { id: reply[3] } : {}),
			},
		};
	const none =
		/^No reply to (\S+) within \d+s\. Delivery:\n([\s\S]*?)(?:\nA later reply|$)/.exec(
			t,
		);
	if (none)
		return {
			messageId: none[1]!,
			receipts: parseReceipts(none[2]!),
			timedOut: true,
		};
	const nack = /^(\S+) (was declined|was given up on): ([\s\S]*)$/.exec(t);
	if (nack)
		return {
			messageId: nack[1]!,
			receipts: parseReceipts(nack[3]!),
			declined: nack[2] === "was declined" ? "declined" : "given up",
		};
	const sent =
		/^(?:Sent|Replied with) (\S+?)(?: to \d+ agents?)?:\n([\s\S]*)$/.exec(t);
	if (sent) return { messageId: sent[1]!, receipts: parseReceipts(sent[2]!) };
	return { receipts: [] };
}

/** What a wait returned. */
export interface WaitOutcome {
	timedOut?: boolean;
	message?: PulsarMessage;
	/** `idle:<agent>`: that agent finished its turn. */
	idle?: string;
	event?: string;
	receipts?: Receipt[];
}

export function parseWait(text: string): WaitOutcome {
	const t = resultBody(text);
	if (/^Nothing happened within \d+s\.$/.test(t)) return { timedOut: true };
	const idle = /^(.+) is idle\.$/.exec(t);
	if (idle) return { idle: idle[1]! };
	const ev = /^([a-z]+):\n([\s\S]*)$/.exec(t);
	if (ev) {
		const message = parseMessages(ev[2]!)[0];
		if (message) return { event: ev[1]!, message };
		return { event: ev[1]!, receipts: parseReceipts(ev[2]!) };
	}
	return { event: t.split("\n")[0] };
}

/** "2 min", "45 s", "1 h": a span as people say it. */
function spanText(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	if (s < 3600) return `${Math.round(s / 60)} min`;
	return `${Math.round(s / 360) / 10} h`;
}

/** The message id a respond-family call answers. */
export function answeredId(input: unknown): string {
	return str(rec(input).message_id);
}

/** What a respond-family call does: reply, working, done or declined. */
export type RespondState = "reply" | "working" | "done" | "declined";

export function respondState(
	tool: PulsarTool,
	input: unknown,
): RespondState | null {
	switch (tool) {
		case "respond": {
			const s = str(rec(input).state);
			return s === "reply" ||
				s === "working" ||
				s === "done" ||
				s === "declined"
				? s
				: null;
		}
		case "reply":
			return "reply";
		case "ack":
			return "working";
		case "done":
			return "done";
		case "nack":
			return "declined";
		default:
			return null;
	}
}

/** The text a call sends: a message body, an answer, a result or a reason. */
export function sentText(tool: PulsarTool, input: unknown): string {
	const a = rec(input);
	switch (tool) {
		case "send":
		case "ask":
		case "reply":
			return str(a.body);
		case "respond":
			return str(a.text);
		case "done":
			return str(a.result);
		case "nack":
			return str(a.reason);
		default:
			return "";
	}
}

/** The set of things a set_identity call changes; empty for a read. */
export function identityChange(input: unknown): {
	activity?: string;
	tagsAdd: string[];
	tagsRemove: string[];
	other: string[];
} {
	const a = rec(input);
	const activity =
		typeof a.activity === "string"
			? a.activity
			: typeof a.summary === "string"
				? a.summary
				: undefined;
	const other = ["name", "model", "inbound", "cwd"].filter(
		(k) => typeof a[k] === "string" && (a[k] as string) !== "",
	);
	return {
		...(activity !== undefined ? { activity } : {}),
		tagsAdd: strings(a.tags_add),
		tagsRemove: strings(a.tags_remove),
		other,
	};
}

// ------------------------------------------------------------------ the line

/** A chip in the card's line: an agent (avatar + name) or a group in words. */
export interface LineChip {
	label: string;
	agent?: string;
	/** A selector in plain words ("everyone on apparish"). */
	group?: boolean;
	harness?: string;
	id?: string;
}

/**
 * The card's one line: verb, who or what (chips or text), a small label
 * (priority), and short result facts. `quote` is the message id a
 * respond-family call answers, for the app to name its sender.
 */
export interface PulsarLine {
	tool: PulsarTool;
	verb: string;
	chips: LineChip[];
	/** Text after the verb when there are no chips (a question, an activity). */
	text?: string;
	label?: string;
	facts: string[];
	answers?: string;
	error?: string;
}

const noun = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/**
 * The line for a Pulsar call. `done` is false while the call runs;
 * `output` is the result text (empty while running); `ms` how long it took.
 */
export function describePulsar(
	tool: PulsarTool,
	input: unknown,
	o: { done: boolean; output?: string; isError?: boolean; ms?: number },
): PulsarLine {
	const a = rec(input);
	const out = o.output ?? "";
	// Facts come from the result text: none for a call that returned nothing.
	const ran = o.done && !o.isError && !!out.trim();
	const error =
		o.done && o.isError && out.trim() ? errorMessage(out) : undefined;
	const base = {
		tool,
		chips: [] as LineChip[],
		facts: [] as string[],
		...(error ? { error } : {}),
	};
	switch (tool) {
		case "send":
		case "ask": {
			const awaits = tool === "ask" || a.await_reply === true;
			const chips = recipients(str(a.to)).map((r) => ({
				label: r.label,
				...(r.agent ? { agent: r.agent } : { group: true }),
			}));
			const p = str(a.priority) || (awaits ? "urgent" : "");
			const label = str(a.priority) || awaits ? priorityLabel(p) : undefined;
			const facts: string[] = [];
			if (!o.done) {
				if (awaits) facts.push("waiting for reply");
			} else if (ran) {
				const r = parseSend(out);
				if (r.reply) facts.push(`reply from ${r.reply.from}`);
				else if (r.timedOut)
					facts.push(
						`no reply in ${spanText((Number(a.timeout_seconds) || 120) * 1000)}`,
					);
				else if (r.declined) facts.push(r.declined);
				else facts.push(...receiptSummary(r.receipts));
			}
			return {
				...base,
				verb: o.done
					? tool === "ask"
						? "Asked"
						: "Sent to"
					: tool === "ask"
						? "Asking"
						: "Sending to",
				chips,
				...(label ? { label } : {}),
				facts,
			};
		}
		case "respond":
		case "reply":
		case "ack":
		case "done":
		case "nack": {
			const s = respondState(tool, input);
			const id = answeredId(input);
			const retry = a.retry === true;
			const verb =
				s === "reply"
					? o.done
						? "Replied"
						: "Replying"
					: s === "working"
						? "Working on it"
						: s === "done"
							? o.done
								? "Marked done"
								: "Marking done"
							: s === "declined"
								? retry
									? "Declined (retry later)"
									: "Declined"
								: "Responded";
			const facts: string[] = [];
			if (ran) {
				if (s === "reply")
					facts.push(...receiptSummary(parseSend(out).receipts));
				const already = / is already (\w+)\.$/.exec(resultBody(out));
				if (already) facts.push(`already ${already[1]}`);
			}
			return { ...base, verb, ...(id ? { answers: id } : {}), facts };
		}
		case "wait": {
			const what = str(a.for) || "message";
			const chips: LineChip[] = [];
			let text: string | undefined;
			if (what.startsWith("idle:")) {
				const who = what.slice(5);
				chips.push({ label: who, agent: who });
				text = "to finish";
			} else if (what.startsWith("reply:")) text = "a reply";
			else text = what === "message" ? "a message" : what;
			const facts: string[] = [];
			if (ran) {
				const w = parseWait(out);
				if (w.timedOut)
					facts.push(
						`timed out after ${spanText((Number(a.timeout_seconds) || 60) * 1000)}`,
					);
				else if (w.message)
					facts.push(
						`${w.event === "reply" ? "reply" : "message"} from ${w.message.from.name}`,
					);
				else if (w.idle) facts.push(`${w.idle} is idle`);
				else if (w.event) facts.push(w.event);
				if (!w.timedOut && o.ms !== undefined && o.ms >= 1000)
					facts.push(spanText(o.ms));
			}
			return {
				...base,
				verb: o.done ? "Waited for" : "Waiting for",
				chips,
				...(text ? { text } : {}),
				facts,
			};
		}
		case "list_agents":
		case "who": {
			const q = str(a.question).trim();
			const sel = str(a.selector).trim();
			const text =
				q || (sel && sel !== "*" ? recipients(sel)[0]?.label : undefined);
			const facts: string[] = [];
			if (ran) {
				const r = parseAgents(out);
				facts.push(
					r.empty
						? q
							? "nobody matches"
							: "no agents"
						: noun(r.total, "agent"),
				);
			}
			return {
				...base,
				verb: o.done ? "Looked up agents" : "Looking up agents",
				...(text ? { text } : {}),
				facts,
			};
		}
		case "inbox":
		case "history": {
			const search = str(a.query);
			const thread = str(a.thread_id) || str(a.message_id);
			const facts: string[] = [];
			const chips: LineChip[] = [];
			let verb = o.done ? "Read inbox" : "Reading inbox";
			if (search)
				verb = o.done ? "Searched messages for" : "Searching messages for";
			else if (thread) verb = o.done ? "Read thread" : "Reading thread";
			if (ran) {
				const msgs = parseMessages(resultBody(out));
				const header = /^(\d+) message\(s\):/.exec(out.trim());
				const n = header ? Number(header[1]) : msgs.length;
				if (!search && !thread)
					verb = n ? `Read ${noun(n, "message")}` : "Read inbox";
				else facts.push(noun(n, "message"));
				if (!n && !search && !thread) facts.push("nothing new");
				const seen = new Set<string>();
				for (const m of msgs) {
					if (seen.has(m.from.name)) continue;
					seen.add(m.from.name);
					chips.push({
						label: m.from.name,
						agent: m.from.name,
						...(m.from.harness ? { harness: m.from.harness } : {}),
					});
				}
			}
			return {
				...base,
				verb,
				chips: search || thread ? [] : chips,
				...(search ? { text: search } : thread ? { text: thread } : {}),
				facts,
			};
		}
		case "set_identity":
		case "whoami": {
			const c = identityChange(input);
			const writes =
				tool === "set_identity" &&
				(c.activity !== undefined ||
					c.tagsAdd.length ||
					c.tagsRemove.length ||
					c.other.length);
			if (!writes)
				return {
					...base,
					verb: o.done ? "Checked its identity" : "Checking its identity",
					facts: [],
				};
			const chips = c.tagsAdd.map((t) => ({ label: t }));
			if (c.activity !== undefined)
				return {
					...base,
					verb: c.activity ? "Set status:" : "Cleared its status",
					...(c.activity ? { text: c.activity } : {}),
					chips,
				};
			return {
				...base,
				verb:
					c.tagsAdd.length || c.tagsRemove.length
						? "Tagged itself"
						: "Updated its identity",
				chips,
				facts: c.tagsRemove.length
					? [`removed ${c.tagsRemove.join(", ")}`]
					: c.other.length && !c.tagsAdd.length
						? [c.other.join(", ")]
						: [],
			};
		}
	}
}
