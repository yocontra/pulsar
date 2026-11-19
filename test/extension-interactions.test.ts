import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	formToQuestions,
	loadFormKit,
	planPrompt,
	type Relay,
	type RelayRequest,
	type RelayResult,
	relayUi,
} from "../src/extension-interactions.ts";

/** A relay whose app answer the test gives (or never gives). */
function fakeRelay() {
	const asked: RelayRequest[] = [];
	const locals: string[] = [];
	let answer: (r: RelayResult | null) => void = () => {};
	const relay: Relay = {
		ask: (req) => {
			asked.push(req);
			return new Promise((r) => {
				answer = r;
			});
		},
		local: (ref) => locals.push(ref),
	};
	return { relay, asked, locals, answer: (r: RelayResult | null) => answer(r) };
}

/** A host dialog that answers when told, and closes on abort. */
function dialog<T>() {
	let finish: (v: T) => void = () => {};
	let aborted = false;
	const fn = (..._args: unknown[]) => {
		const opts = _args.find(
			(a) => a && typeof a === "object" && "signal" in (a as object),
		) as { signal?: AbortSignal } | undefined;
		return new Promise<T | undefined>((resolve) => {
			finish = resolve as (v: T) => void;
			opts?.signal?.addEventListener("abort", () => {
				aborted = true;
				resolve(undefined);
			});
		});
	};
	return { fn, finish: (v: T) => finish(v), aborted: () => aborted };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("relayUi", () => {
	test("select: the app answers first; the local dialog is aborted", async () => {
		const d = dialog<string>();
		const ui: Record<string, unknown> = { select: d.fn };
		const f = fakeRelay();
		expect(relayUi(ui, f.relay)).toBe(true);
		const p = (ui.select as (...a: unknown[]) => Promise<unknown>)(
			"Deploy where?",
			["staging", { label: "prod" }],
			{ timeout: 5000 },
		);
		await tick();
		expect(f.asked[0]).toMatchObject({
			kind: "select",
			tool: "ui.select",
			timeoutMs: 5000,
			prompt: {
				kind: "select",
				title: "Deploy where?",
				options: [{ label: "staging" }, { label: "prod" }],
			},
		});
		f.answer({
			decision: "answer",
			answer: { kind: "select", value: "prod" },
			note: null,
		});
		expect(await p).toBe("prod");
		expect(d.aborted()).toBe(true);
		expect(f.locals).toEqual([]);
	});

	test("confirm: the terminal answers first; the daemon hears it", async () => {
		const d = dialog<boolean>();
		const ui: Record<string, unknown> = { confirm: d.fn };
		const f = fakeRelay();
		relayUi(ui, f.relay);
		const p = (ui.confirm as (...a: unknown[]) => Promise<unknown>)(
			"Sure?",
			"really",
		);
		await tick();
		d.finish(true);
		expect(await p).toBe(true);
		expect(f.locals).toEqual([f.asked[0]!.ref]);
		// A late app answer changes nothing.
		f.answer({
			decision: "answer",
			answer: { kind: "confirm", confirmed: false },
			note: null,
		});
		await tick();
		expect(await p).toBe(true);
	});

	test("nobody can answer from the app: the local dialog decides alone", async () => {
		const d = dialog<string>();
		const ui: Record<string, unknown> = { input: d.fn };
		const f = fakeRelay();
		relayUi(ui, f.relay);
		const p = (ui.input as (...a: unknown[]) => Promise<unknown>)(
			"Name",
			"placeholder",
		);
		await tick();
		f.answer(null);
		await tick();
		expect(d.aborted()).toBe(false);
		d.finish("typed");
		expect(await p).toBe("typed");
	});

	test("approve: allow-for-session maps to omp's 'session'; cancel to undefined for input", async () => {
		const d = dialog<string>();
		const ui: Record<string, unknown> = { approve: d.fn };
		const f = fakeRelay();
		relayUi(ui, f.relay);
		const p = (ui.approve as (...a: unknown[]) => Promise<unknown>)({
			full: "rm -rf build",
			compact: "rm",
			session: "Allow rm for this session",
		});
		await tick();
		expect(f.asked[0]).toMatchObject({
			kind: "permission",
			input: { command: "rm -rf build" },
			sessionRules: ["Allow rm for this session"],
		});
		f.answer({ decision: "allow-session", answer: null, note: null });
		expect(await p).toBe("session");
	});

	test("wraps an object once, also through a new proxy per event", () => {
		const ui: Record<string, unknown> = { select: async () => "x" };
		const f = fakeRelay();
		expect(relayUi(ui, f.relay)).toBe(true);
		expect(relayUi(ui, f.relay)).toBe(false);
		const select = ui.select;
		expect(relayUi(new Proxy(ui, {}), f.relay)).toBe(false);
		expect(ui.select).toBe(select);
	});
});

describe("omp plan review", () => {
	test("approving choices and refine (with feedback); save and disabled are left out", () => {
		const p = planPrompt({
			reviewId: "r",
			planContent: "# Plan",
			planFilePath: "/p.md",
			options: [
				{ id: "execute", label: "Execute" },
				{ id: "compact", label: "Compact and execute", disabled: true },
				{ id: "refine", label: "Refine", disabled: true },
				{ id: "save", label: "Save" },
			],
		});
		expect(p).toEqual({
			kind: "plan",
			plan: "# Plan",
			planFile: "/p.md",
			choices: [
				{ id: "execute", label: "Execute", approves: true },
				{ id: "refine", label: "Refine", approves: false, feedback: true },
			],
		});
	});
});

describe("omp ask form (fake form kit)", () => {
	type Kit = Parameters<typeof formToQuestions>[0];
	type Field = ReturnType<Kit["parseHtmlForm"]>["fields"][number];
	const t = (text: string) => [{ text }];
	const FIELDS: Field[] = [
		{
			kind: "choice",
			name: "db",
			multi: false,
			other: false,
			label: t("Database"),
			options: [
				{ value: "pg", label: t(" Postgres "), disabled: false },
				{ value: "mysql", label: t("MySQL"), disabled: true },
				{ value: "sqlite", label: [], disabled: false },
			],
		},
		{
			kind: "choice",
			name: "f",
			multi: true,
			other: true,
			label: t("Features"),
			options: [
				{ value: "a", label: t("Auth"), disabled: false },
				{ value: "b", label: t("Billing"), disabled: false },
			],
		},
		{
			kind: "text",
			name: "token",
			type: "password",
			multiline: false,
			label: t("API token"),
			placeholder: "",
		},
		{
			kind: "text",
			name: "count",
			type: "number",
			multiline: false,
			label: t("How many?"),
			placeholder: "",
		},
		{
			kind: "text",
			name: "notes",
			type: "text",
			multiline: true,
			label: [],
			placeholder: "",
		},
		{
			kind: "text",
			name: "",
			type: "text",
			multiline: false,
			label: t("unnamed: dropped"),
			placeholder: "",
		},
	];
	const kit: Kit = {
		parseHtmlForm: (html) => {
			expect(html).toBe("<form>…</form>");
			return { fields: FIELDS };
		},
		// The kit's own question text wins over the field's label.
		fieldQuestions: () =>
			new Map<unknown, string>([[FIELDS[0], "Which database?"]]),
	};

	test("fields become typed questions: secret passwords, no disabled options, labels shown", () => {
		const form = formToQuestions(kit, "<form>…</form>")!;
		expect(form.prompt).toEqual({
			kind: "question",
			questions: [
				{
					id: "db",
					question: "Which database?",
					multiSelect: false,
					options: [{ label: "Postgres" }, { label: "sqlite" }],
					allowOther: false,
				},
				{
					id: "f",
					question: "Features",
					multiSelect: true,
					options: [{ label: "Auth" }, { label: "Billing" }],
					allowOther: true,
				},
				{
					id: "token",
					question: "API token",
					multiSelect: false,
					options: [],
					allowOther: true,
					secret: true,
				},
				{
					id: "count",
					question: "How many?",
					multiSelect: false,
					options: [],
					allowOther: true,
				},
				{
					id: "notes",
					question: "notes",
					multiSelect: false,
					options: [],
					allowOther: true,
					multiline: true,
				},
			],
		});
	});

	test("answers become form data: labels to values, numbers coerced", () => {
		const form = formToQuestions(kit, "<form>…</form>")!;
		expect(
			form.toData({
				kind: "question",
				answers: {
					db: ["Postgres"],
					f: ["Billing", "Typed in"],
					token: ["s3cret"],
					count: [" 42 "],
					notes: ["line"],
				},
			}),
		).toEqual({
			db: "pg",
			f: ["b", "Typed in"],
			token: "s3cret",
			count: 42,
			notes: "line",
		});
		// Not a number: kept as typed. Unanswered text: empty.
		expect(
			form.toData({
				kind: "question",
				answers: { db: ["sqlite"], count: ["many"] },
			}),
		).toEqual({ db: "sqlite", f: [], token: "", count: "many", notes: "" });
	});

	test("a form with no named fields is not relayed", () => {
		expect(
			formToQuestions(
				{
					parseHtmlForm: () => ({ fields: [FIELDS[5]!] }),
					fieldQuestions: () => new Map(),
				},
				"<form>…</form>",
			),
		).toBeNull();
	});
});

const OMP = join(
	homedir(),
	".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
);

describe.skipIf(!existsSync(OMP))("omp ask form (installed omp)", () => {
	test("an HTML form becomes typed questions and the answers become its form data", async () => {
		const kit = await loadFormKit(OMP);
		expect(kit).not.toBeNull();
		const html = `<form>
			<p>Which database?</p>
			<label><input type="radio" name="db" value="pg"> Postgres</label>
			<label><input type="radio" name="db" value="sqlite"> SQLite</label>
			<p>Features</p>
			<label><input type="checkbox" name="f" value="a"> Auth</label>
			<label><input type="checkbox" name="f" value="b"> Billing</label>
			<label>Notes <textarea name="notes"></textarea></label>
		</form>`;
		const form = formToQuestions(kit!, html)!;
		expect(form.prompt.kind).toBe("question");
		if (form.prompt.kind !== "question") return;
		const [db, f, notes] = form.prompt.questions;
		expect(db).toMatchObject({ id: "db", multiSelect: false });
		expect(db!.options.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);
		expect(f).toMatchObject({ id: "f", multiSelect: true });
		expect(notes).toMatchObject({ id: "notes", options: [], multiline: true });
		expect(
			form.toData({
				kind: "question",
				answers: { db: ["SQLite"], f: ["Auth", "Billing"], notes: ["ok"] },
			}),
		).toEqual({ db: "sqlite", f: ["a", "b"], notes: "ok" });
	});
});
