import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	InteractionAnswer,
	InteractionKind,
	InteractionPrompt,
	InteractionQuestion,
} from "./http/wire.ts";

/**
 * Relays pi/omp dialogs to the pulsar app (docs/interactive-tools.md).
 *
 * The extension's `ctx.ui` is the object the host's own tools use too (omp
 * builds one UI context for tools and extensions in TUI mode), so wrapping
 * its methods relays extension dialogs, omp's `ask` form (`formDialog`) and
 * omp's tool approvals (`approve`). Each wrapped call races the local dialog
 * against the app: the first answer wins. An app answer aborts the local
 * dialog through its `signal`; a local answer tells the daemon
 * (`interaction.local`) so the app card shows "Answered on <machine>".
 */

/** What the daemon resolves `interaction.ask` with (src/service/approvals.ts). */
export interface RelayResult {
	decision: "allow-once" | "allow-session" | "deny" | "answer";
	answer: InteractionAnswer | null;
	note: string | null;
}

export interface RelayRequest {
	ref: string;
	kind: InteractionKind;
	tool: string;
	input?: Record<string, unknown>;
	prompt?: InteractionPrompt;
	sessionRules?: string[] | null;
	timeoutMs?: number | null;
}

export interface Relay {
	/** Asks the app; null when nobody can answer there (or the daemon is away). */
	ask(req: RelayRequest): Promise<RelayResult | null>;
	/** The local dialog answered first. */
	local(ref: string): void;
}

type DialogOptions = { signal?: AbortSignal; timeout?: number } & Record<
	string,
	unknown
>;

type Fn = (...args: unknown[]) => Promise<unknown>;

/**
 * Runs the local dialog and the app side by side; resolves with whichever
 * answers first. `map` turns the app's result into the dialog's own return
 * value (undefined: the app's answer does not fit, keep waiting locally).
 */
function race<T>(
	relay: Relay,
	req: Omit<RelayRequest, "ref">,
	opts: DialogOptions | undefined,
	local: (opts: DialogOptions) => Promise<T>,
	map: (r: RelayResult) => { value: T } | undefined,
): Promise<T> {
	const ref = globalThis.crypto.randomUUID();
	const ac = new AbortController();
	const signal = opts?.signal
		? AbortSignal.any([opts.signal, ac.signal])
		: ac.signal;
	let done = false;
	return new Promise<T>((resolve, reject) => {
		const fromApp = relay.ask({
			...req,
			ref,
			timeoutMs: req.timeoutMs ?? opts?.timeout ?? null,
		});
		const answeredLocally =
			<V>(settle: (v: V) => void) =>
			(v: V) => {
				if (done) return;
				done = true;
				relay.local(ref);
				settle(v);
			};
		local({ ...opts, signal }).then(
			answeredLocally(resolve),
			answeredLocally(reject),
		);
		fromApp.then(
			(r) => {
				if (done || !r) return;
				const m = map(r);
				if (!m) return;
				done = true;
				ac.abort();
				resolve(m.value);
			},
			() => {},
		);
	});
}

const label = (o: unknown): string =>
	typeof o === "string"
		? o
		: String((o as { label?: unknown } | null)?.label ?? "");

/**
 * The usual `race` map: a cancel resolves the dialog with `cancelled`, an
 * answer of `kind` with `pick(answer)`; any other answer keeps waiting.
 */
function answerOf<K extends InteractionAnswer["kind"]>(
	kind: K,
	cancelled: unknown,
	pick: (a: Extract<InteractionAnswer, { kind: K }>) => unknown,
): (r: RelayResult) => { value: unknown } | undefined {
	return (r) => {
		const a = r.answer;
		if (a?.kind === "cancel") return { value: cancelled };
		if (a?.kind === kind)
			return { value: pick(a as Extract<InteractionAnswer, { kind: K }>) };
		return undefined;
	};
}

/** omp's own HTML form parser (`@oh-my-pi/pi-tui`), loaded from the host's install. */
interface FormKit {
	parseHtmlForm(html: string): {
		fields: Array<
			| {
					kind: "choice";
					name: string;
					multi: boolean;
					other: boolean;
					label: { text: string }[];
					options: {
						value: string;
						label: { text: string }[];
						disabled: boolean;
					}[];
			  }
			| {
					kind: "text";
					name: string;
					type: string;
					multiline: boolean;
					label: { text: string }[];
					placeholder: string;
			  }
		>;
	};
	fieldQuestions(form: unknown): Map<unknown, string>;
}

let formKit: Promise<FormKit | null> | null = null;

/** Finds pi-tui next to the running omp (argv[1] is omp's cli.js). */
export function loadFormKit(argv1 = process.argv[1]): Promise<FormKit | null> {
	formKit ??= (async () => {
		try {
			const req = createRequire(await realpath(argv1 ?? ""));
			const root = dirname(req.resolve("@oh-my-pi/pi-tui/package.json"));
			const parse = await import(
				pathToFileURL(join(root, "src/html-form/parse.ts")).href
			);
			const data = await import(
				pathToFileURL(join(root, "src/html-form/data.ts")).href
			);
			if (
				typeof parse.parseHtmlForm !== "function" ||
				typeof data.fieldQuestions !== "function"
			)
				return null;
			return {
				parseHtmlForm: parse.parseHtmlForm,
				fieldQuestions: data.fieldQuestions,
			};
		} catch {
			return null;
		}
	})();
	return formKit;
}

const spans = (s: { text: string }[]) =>
	s
		.map((x) => x.text)
		.join("")
		.trim();

/**
 * omp's `ask` form as typed questions (never its HTML), plus the way back:
 * the app's answers as the form data omp's dialog would have submitted.
 */
export function formToQuestions(
	kit: FormKit,
	html: string,
): {
	prompt: InteractionPrompt;
	toData(a: InteractionAnswer): Record<string, string | number | string[]>;
} | null {
	const form = kit.parseHtmlForm(html);
	const asked = kit.fieldQuestions(form);
	const fields = form.fields.filter((f) => f.name);
	if (!fields.length) return null;
	const questions: InteractionQuestion[] = fields.map((f) => {
		const question = asked.get(f) || spans(f.label) || f.name;
		if (f.kind === "choice")
			return {
				id: f.name,
				question,
				multiSelect: f.multi,
				options: f.options
					.filter((o) => !o.disabled)
					.map((o) => ({ label: spans(o.label) || o.value })),
				allowOther: f.other,
			};
		return {
			id: f.name,
			question,
			multiSelect: false,
			options: [],
			allowOther: true,
			...(f.multiline ? { multiline: true } : {}),
			...(f.type === "password" ? { secret: true } : {}),
		};
	});
	return {
		prompt: { kind: "question", questions },
		toData(a) {
			const out: Record<string, string | number | string[]> = {};
			if (a.kind !== "question") return out;
			for (const f of fields) {
				const got = a.answers[f.name] ?? [];
				if (f.kind === "choice") {
					const byLabel = new Map(
						f.options.map((o) => [spans(o.label) || o.value, o.value]),
					);
					const values = got.map((g) => byLabel.get(g) ?? g);
					if (f.multi) out[f.name] = values;
					else if (values[0] !== undefined) out[f.name] = values[0];
				} else {
					const text = got[0] ?? "";
					out[f.name] =
						(f.type === "number" || f.type === "range") &&
						text.trim() !== "" &&
						Number.isFinite(Number(text))
							? Number(text)
							: text;
				}
			}
			return out;
		},
	};
}

const wrapped = new WeakSet<object>();
/** Marks a dialog method this module already wrapped. */
const RELAYED = Symbol.for("pulsar.relayed");

/**
 * Wraps a host UI context's dialog methods once. Returns false when the
 * object can't be changed (then dialogs stay local only).
 */
export function relayUi(ui: Record<string, unknown>, relay: Relay): boolean {
	if (!ui || typeof ui !== "object" || wrapped.has(ui)) return false;
	// Hosts hand each event a new proxy over one UI object, and the proxy may
	// wrap methods on every read: mark the object itself (sets go through).
	if ((ui as { [RELAYED]?: unknown })[RELAYED]) return false;
	let changed = false;
	const wrap = (name: string, make: (orig: Fn) => Fn) => {
		const orig = ui[name];
		if (typeof orig !== "function" || (orig as { [RELAYED]?: true })[RELAYED])
			return;
		const bound = (orig as Fn).bind(ui);
		try {
			const fn = make(bound) as Fn & { [RELAYED]?: true };
			fn[RELAYED] = true;
			ui[name] = fn;
			changed = true;
		} catch {}
	};

	wrap("select", (orig) => (title, options, opts) => {
		const list = Array.isArray(options) ? options : [];
		const labels = list.map(label).filter(Boolean);
		if (!labels.length) return orig(title, options, opts);
		return race(
			relay,
			{
				kind: "select",
				tool: "ui.select",
				prompt: {
					kind: "select",
					title: String(title ?? ""),
					options: labels.map((l) => ({ label: l })),
				},
			},
			opts as DialogOptions,
			(o) => orig(title, options, o),
			answerOf("select", undefined, (a) => a.value),
		);
	});

	wrap(
		"confirm",
		(orig) => (title, message, opts) =>
			race(
				relay,
				{
					kind: "confirm",
					tool: "ui.confirm",
					prompt: {
						kind: "confirm",
						title: String(title ?? ""),
						message: String(message ?? ""),
					},
				},
				opts as DialogOptions,
				(o) => orig(title, message, o),
				answerOf("confirm", false, (a) => a.confirmed),
			),
	);

	const text =
		(method: "input" | "editor") =>
		(orig: Fn): Fn =>
		(title, second, opts, ...rest) =>
			race(
				relay,
				{
					kind: "input",
					tool: `ui.${method}`,
					prompt: {
						kind: "input",
						title: String(title ?? ""),
						...(method === "input" && typeof second === "string" && second
							? { placeholder: second }
							: {}),
						...(method === "editor" && typeof second === "string" && second
							? { prefill: second }
							: {}),
						...(method === "editor" ? { multiline: true } : {}),
						...((opts as DialogOptions | undefined)?.secret === true
							? { secret: true }
							: {}),
					},
				},
				opts as DialogOptions,
				(o) => orig(title, second, o, ...rest),
				answerOf("input", undefined, (a) => a.value),
			);
	wrap("input", text("input"));
	wrap("editor", text("editor"));

	// omp's `ask` tool: an HTML form, relayed as typed questions.
	wrap("formDialog", (orig) => async (html, opts) => {
		const kit = typeof html === "string" ? await loadFormKit() : null;
		let form: ReturnType<typeof formToQuestions> = null;
		try {
			form = kit ? formToQuestions(kit, html as string) : null;
		} catch {}
		if (!form) return orig(html, opts);
		const f = form;
		return race(
			relay,
			{ kind: "question", tool: "ask", prompt: f.prompt },
			opts as DialogOptions,
			(o) => orig(html, o),
			answerOf("question", undefined, (a) => ({ data: f.toData(a) })),
		);
	});

	// omp's tool approvals.
	wrap("approve", (orig) => (prompt, opts) => {
		const p = (prompt ?? {}) as {
			full?: string;
			compact?: string;
			session?: string;
		};
		return race(
			relay,
			{
				kind: "permission",
				tool: "approval",
				input: { command: String(p.full ?? p.compact ?? "") },
				sessionRules: p.session ? [p.session] : null,
			},
			opts as DialogOptions,
			(o) => orig(prompt, o),
			// No cancel case: anything but an allow denies.
			(r) => {
				if (r.decision === "allow-session") return { value: "session" };
				if (r.decision === "allow-once") return { value: "once" };
				return { value: "deny" };
			},
		);
	});

	wrapped.add(ui);
	try {
		(ui as { [RELAYED]?: unknown })[RELAYED] = true;
	} catch {}
	return changed;
}

/** omp's plan review choices, as the app shows them (save is not an answer). */
const PLAN_CHOICES: Record<string, { approves: boolean; feedback?: boolean }> =
	{
		execute: { approves: true },
		compact: { approves: true },
		keep: { approves: true },
		refine: { approves: false, feedback: true },
	};

export interface PlanReviewEvent {
	reviewId: string;
	title?: string;
	planFilePath?: string;
	planContent?: string;
	options?: { id: string; label: string; disabled?: boolean }[];
}

/** The app's plan prompt for an omp plan review; null when nothing can be answered. */
export function planPrompt(e: PlanReviewEvent): InteractionPrompt | null {
	const choices = (e.options ?? [])
		.filter((o) => PLAN_CHOICES[o.id] && (!o.disabled || o.id === "refine"))
		.map((o) => ({ id: o.id, label: o.label, ...PLAN_CHOICES[o.id]! }));
	if (!choices.length) return null;
	return {
		kind: "plan",
		plan: e.planContent ?? "",
		planFile: e.planFilePath ?? null,
		choices,
	};
}
