import { canonicalJson, sha256hex } from "../canonical.ts";
import type {
	InteractionAnswer,
	InteractionKind,
	InteractionOption,
	InteractionPrompt,
	InteractionQuestion,
	PlanChoice,
} from "../http/wire.ts";
import { RpcError } from "../rpc.ts";

/**
 * Interactions: prompts that need the operator.
 * Shapes are checked here, once, for every source: a harness hook, the
 * pi/omp extension, a peer's records and the app's answers.
 */

export const KINDS: readonly InteractionKind[] = [
	"permission",
	"question",
	"plan",
	"confirm",
	"select",
	"input",
];

const MAX_TEXT = 4000;
const MAX_PLAN = 200_000;
const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 50;

const str = (v: unknown, max: number): string | null =>
	typeof v === "string" ? v.slice(0, max) : null;

function option(raw: unknown): InteractionOption | null {
	if (typeof raw === "string") return raw ? { label: raw.slice(0, 500) } : null;
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const label = str(o.label, 500);
	if (!label) return null;
	const description = str(o.description, 2000);
	return description ? { label, description } : { label };
}

/** The well-formed items of a list, after capping it at `max`; not a list gives none. */
function items<T>(
	raw: unknown,
	max: number,
	item: (v: unknown, i: number) => T | null,
): T[] {
	return Array.isArray(raw)
		? raw
				.slice(0, max)
				.map(item)
				.filter((x): x is T => x !== null)
		: [];
}

const options = (raw: unknown) => items(raw, MAX_OPTIONS, option);

function question(raw: unknown, i: number): InteractionQuestion | null {
	if (!raw || typeof raw !== "object") return null;
	const q = raw as Record<string, unknown>;
	const text = str(q.question, MAX_TEXT);
	if (!text) return null;
	const opts = options(q.options);
	const header = str(q.header, 100);
	return {
		id: str(q.id, 1000) || text || `q${i}`,
		question: text,
		...(header ? { header } : {}),
		multiSelect: q.multiSelect === true,
		options: opts,
		// No options: free text is the only way to answer.
		allowOther: opts.length === 0 || q.allowOther !== false,
		...(q.multiline === true ? { multiline: true } : {}),
		...(q.secret === true ? { secret: true } : {}),
	};
}

function choice(raw: unknown): PlanChoice | null {
	if (!raw || typeof raw !== "object") return null;
	const c = raw as Record<string, unknown>;
	const id = str(c.id, 100);
	const label = str(c.label, 200);
	if (!id || !label) return null;
	return {
		id,
		label,
		approves: c.approves === true,
		...(c.feedback === true ? { feedback: true } : {}),
	};
}

/** A prompt, checked (or null when malformed). Strings are capped, never rewritten. */
export function cleanPrompt(raw: unknown): InteractionPrompt | null {
	if (!raw || typeof raw !== "object") return null;
	const p = raw as Record<string, unknown>;
	switch (p.kind) {
		case "question": {
			const qs = items(p.questions, MAX_QUESTIONS, question);
			if (!qs.length) return null;
			// Answers are keyed by id: two questions may not share one.
			if (new Set(qs.map((q) => q.id)).size !== qs.length) return null;
			const title = str(p.title, 300);
			return { kind: "question", ...(title ? { title } : {}), questions: qs };
		}
		case "plan": {
			const plan = str(p.plan, MAX_PLAN);
			const choices = items(p.choices, 10, choice);
			if (plan === null || !choices.length) return null;
			return {
				kind: "plan",
				plan,
				planFile: str(p.planFile, 4096),
				choices,
			};
		}
		case "confirm": {
			const title = str(p.title, 500);
			if (title === null) return null;
			return {
				kind: "confirm",
				title,
				message: str(p.message, MAX_TEXT) ?? "",
			};
		}
		case "select": {
			const title = str(p.title, 500);
			const opts = options(p.options);
			if (title === null || !opts.length) return null;
			return { kind: "select", title, options: opts };
		}
		case "input": {
			const title = str(p.title, 500);
			if (title === null) return null;
			const placeholder = str(p.placeholder, 500);
			const prefill = str(p.prefill, MAX_TEXT);
			return {
				kind: "input",
				title,
				...(placeholder ? { placeholder } : {}),
				...(prefill ? { prefill } : {}),
				...(p.multiline === true ? { multiline: true } : {}),
				...(p.secret === true ? { secret: true } : {}),
			};
		}
		default:
			return null;
	}
}

const bad = (m: string) => new RpcError("bad_request", m);

/**
 * The app's answer, checked against the prompt it answers: picked labels
 * must be options unless free text is allowed, a plan choice must be one
 * of the plan's. Throws `bad_request`.
 */
export function cleanAnswer(
	raw: unknown,
	prompt: InteractionPrompt,
): InteractionAnswer {
	if (!raw || typeof raw !== "object") throw bad("an answer object is needed");
	const a = raw as Record<string, unknown>;
	if (a.kind === "cancel") return { kind: "cancel" };
	if (a.kind !== prompt.kind)
		throw bad(`this prompt takes a ${prompt.kind} answer`);
	switch (prompt.kind) {
		case "question": {
			const given = a.answers;
			if (!given || typeof given !== "object" || Array.isArray(given))
				throw bad("answers: an object of question id to strings");
			const answers: Record<string, string[]> = {};
			for (const q of prompt.questions) {
				const v = (given as Record<string, unknown>)[q.id];
				// A missing answer becomes [undefined], which the filter drops.
				const list = (Array.isArray(v) ? v : [v])
					.map((x) => str(x, MAX_TEXT))
					.filter((x): x is string => x !== null && x.length > 0);
				if (!list.length) throw bad(`no answer for "${q.question}"`);
				if (!q.multiSelect && list.length > 1)
					throw bad(`"${q.question}" takes one answer`);
				const labels = new Set(q.options.map((o) => o.label));
				const free = list.filter((x) => !labels.has(x));
				if (free.length > (q.allowOther ? 1 : 0))
					throw bad(`"${q.question}": pick from the options`);
				answers[q.id] = list;
			}
			return { kind: "question", answers };
		}
		case "plan": {
			const c = prompt.choices.find((x) => x.id === a.choice);
			if (!c) throw bad("choice: one of the plan's choices");
			const feedback = str(a.feedback, MAX_TEXT)?.trim();
			return {
				kind: "plan",
				choice: c.id,
				...(feedback && c.feedback ? { feedback } : {}),
			};
		}
		case "confirm":
			if (typeof a.confirmed !== "boolean") throw bad("confirmed: a boolean");
			return { kind: "confirm", confirmed: a.confirmed };
		case "select": {
			const value = str(a.value, 500);
			if (!value || !prompt.options.some((o) => o.label === value))
				throw bad("value: one of the options");
			return { kind: "select", value };
		}
		case "input": {
			const value = str(a.value, MAX_TEXT);
			if (value === null) throw bad("value: a string");
			return { kind: "input", value };
		}
	}
}

/** What a passkey signature over an answer covers (in the binding's note hash). */
export function answerHash(answer: InteractionAnswer): string {
	return sha256hex(canonicalJson({ v: 1, answer }));
}

/** The needs-you line for a pending interaction. */
export function needsDetail(
	kind: InteractionKind,
	tool: string,
	prompt: InteractionPrompt | null,
): string {
	if (kind === "permission" || !prompt) return `Approve ${tool}`;
	switch (prompt.kind) {
		case "question":
			return `Answer: ${prompt.questions[0]?.header ?? prompt.title ?? prompt.questions[0]?.question ?? tool}`.slice(
				0,
				120,
			);
		case "plan":
			return "Review plan";
		case "confirm":
			// A yes/no reads as itself ("Delete file?", "Confirm: forget ci").
			return prompt.title.slice(0, 120);
		default:
			return `Answer: ${prompt.title}`.slice(0, 120);
	}
}

/** "Answered: Green", "Plan approved": the first half of an outcome line. */
export function answerLabel(
	answer: InteractionAnswer,
	prompt: InteractionPrompt | null,
): string {
	switch (answer.kind) {
		case "cancel":
			return "Declined";
		case "question": {
			const all = Object.values(answer.answers).map((v) => v.join(", "));
			return `Answered: ${all.join(" · ")}`.slice(0, 200);
		}
		case "plan": {
			const c =
				prompt?.kind === "plan"
					? prompt.choices.find((x) => x.id === answer.choice)
					: null;
			return c ? c.label : answer.choice;
		}
		case "confirm":
			return answer.confirmed ? "Confirmed" : "Declined";
		case "select":
			return `Picked: ${answer.value}`.slice(0, 200);
		case "input":
			return "Answered";
	}
}

/** True when an answer lets the agent go ahead (for the allowed/denied state). */
export function answerApproves(
	answer: InteractionAnswer,
	prompt: InteractionPrompt | null,
): boolean {
	if (answer.kind === "cancel") return false;
	if (answer.kind === "confirm") return answer.confirmed;
	if (answer.kind === "plan")
		return (
			prompt?.kind === "plan" &&
			prompt.choices.some((c) => c.id === answer.choice && c.approves)
		);
	return true;
}

/** Shown in place of a secret answer (a password field). */
export const SECRET = "••••••";

/**
 * The answer as it is stored, shown in the app and shared with the pool:
 * secret fields (passwords) replaced. The agent still gets the real answer.
 */
export function redactAnswer(
	answer: InteractionAnswer,
	prompt: InteractionPrompt | null,
): InteractionAnswer {
	if (answer.kind === "input" && prompt?.kind === "input" && prompt.secret)
		return { kind: "input", value: SECRET };
	if (answer.kind === "question" && prompt?.kind === "question") {
		const secret = new Set(
			prompt.questions.filter((q) => q.secret).map((q) => q.id),
		);
		if (!secret.size) return answer;
		const answers: Record<string, string[]> = {};
		for (const [id, v] of Object.entries(answer.answers))
			answers[id] = secret.has(id) ? [SECRET] : v;
		return { kind: "question", answers };
	}
	return answer;
}
