import type { InteractionPrompt, InteractionQuestion } from "../http/wire.ts";
import {
	freshProcessSnapshot,
	type ProcessInfo,
	processSnapshot,
} from "../processes.ts";
import { cleanPrompt } from "../service/interactions.ts";
import { opencodeRequest, opencodeServiceRunning } from "./opencode-api.ts";
import type { ServerPrompt, ServerReply } from "./types.ts";

/**
 * OpenCode's prompts, read from and answered on its own server (verified
 * with OpenCode 2.2.5 against a scratch server):
 *
 * - Permissions: `GET /api/session/:id/permission` lists pending ones
 *   (`{id, action, resources, save}`); `POST …/permission/:rid/reply
 *   {decision: "once" | "always" | "reject", message?}` answers, and the
 *   TUI's own prompt closes.
 * - The `question` tool is a form: `GET /api/session/:id/form` lists
 *   `{id, title, fields: [{key, title, description, type: "string" |
 *   "multiselect" | …, options, custom}]}`; `POST …/form/:fid/reply
 *   {answer: {q0: "<value>", q1: ["a","b"]}}` answers; `DELETE …/form/:fid`
 *   dismisses it.
 *
 * Pending lists are per session (the global ones are scoped to one folder),
 * so this reads each active session's.
 */

interface PermissionRequest {
	id?: string;
	sessionID?: string;
	action?: string;
	resources?: unknown[];
	save?: unknown[];
	message?: string;
}

interface FormField {
	key?: string;
	title?: string;
	description?: string;
	type?: string;
	options?: { value?: unknown; label?: string; description?: string }[];
	custom?: boolean;
}

interface FormRequest {
	id?: string;
	sessionID?: string;
	title?: string;
	metadata?: { kind?: string };
	fields?: FormField[];
}

const list = <T>(raw: unknown): T[] => {
	const d = (raw as { data?: unknown } | null)?.data ?? raw;
	return Array.isArray(d) ? (d as T[]) : [];
};

/** A read for the poll: null when unreadable (never "nothing pending"). */
async function read(
	table: Map<number, ProcessInfo>,
	path: string,
): Promise<unknown> {
	const r = await opencodeRequest(table, "GET", path);
	return r.ok ? r.body : null;
}

/** Sends a request whose answer does not matter; false when it failed. */
async function send(
	method: "POST" | "DELETE",
	path: string,
	body?: unknown,
): Promise<boolean> {
	const table = await processSnapshot(2000, "user");
	const r = await opencodeRequest(table, method, path, {
		...(body !== undefined ? { body } : {}),
		lane: "user",
	});
	return r.ok;
}

/** The value OpenCode expects for a picked label (its `value`, else the label). */
type ValueMap = Record<string, Record<string, unknown>>;

export function formPrompt(
	form: FormRequest,
): { prompt: InteractionPrompt; values: ValueMap } | null {
	const values: ValueMap = {};
	const questions: InteractionQuestion[] = [];
	for (const f of form.fields ?? []) {
		if (!f.key) continue;
		const opts = (f.options ?? []).filter((o) => o.label || o.value);
		const byLabel: Record<string, unknown> = {};
		for (const o of opts)
			byLabel[String(o.label ?? o.value)] = o.value ?? o.label;
		const boolean = f.type === "boolean";
		values[f.key] = boolean ? { Yes: true, No: false } : byLabel;
		questions.push({
			id: f.key,
			question: f.description || f.title || f.key,
			...(f.title && f.description ? { header: f.title } : {}),
			multiSelect: f.type === "multiselect",
			options: boolean
				? [{ label: "Yes" }, { label: "No" }]
				: opts.map((o) => ({
						label: String(o.label ?? o.value),
						...(o.description ? { description: o.description } : {}),
					})),
			allowOther: !boolean && (f.custom === true || opts.length === 0),
		});
	}
	const prompt = cleanPrompt({
		kind: "question",
		...(form.title && form.title !== "Questions" ? { title: form.title } : {}),
		questions,
	});
	return prompt ? { prompt, values } : null;
}

/** The form reply for the app's answers (labels mapped back to values). */
export function formAnswer(
	form: FormRequest,
	values: ValueMap,
	answers: Record<string, string[]>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of form.fields ?? []) {
		const key = f.key;
		if (!key) continue;
		const map = values[key] ?? {};
		const got = (answers[key] ?? []).map((a) =>
			Object.hasOwn(map, a) ? map[a] : a,
		);
		if (f.type === "multiselect") out[key] = got;
		else if (
			f.type === "number" &&
			got[0] !== undefined &&
			Number.isFinite(Number(got[0]))
		)
			out[key] = Number(got[0]);
		else if (got[0] !== undefined) out[key] = got[0];
	}
	return out;
}

/** Whether the last poll saw OpenCode's shared server. */
let serverSeen = true;
/** Process-table age the poll accepts while the server runs, and while it does not. */
const RUNNING_MAX_AGE_MS = 2000;
const IDLE_MAX_AGE_MS = 10_000;

export async function opencodePending(): Promise<ServerPrompt[]> {
	// `opencode api` starts a service when none runs; only look when one does.
	// A failed `ps` is not "no server": that would close every open card.
	// While none runs, an older table (a scan's) will do: a server that just
	// started is seen a few seconds late. While one runs, the table is fresh,
	// so a server that just stopped is never started again by the poll.
	const table = await freshProcessSnapshot(
		serverSeen ? RUNNING_MAX_AGE_MS : IDLE_MAX_AGE_MS,
	);
	if (!table) throw new Error("process list unreadable");
	serverSeen = opencodeServiceRunning(table);
	if (!serverSeen) return [];
	const active = (await read(table, "/api/session/active")) as {
		data?: Record<string, unknown>;
	} | null;
	// Unreadable is not "no prompts": that would close every open card.
	if (active === null) throw new Error("opencode api failed");
	const ids = Object.keys(active.data ?? {});
	const out: ServerPrompt[] = [];
	for (const sid of ids) {
		const [perms, forms] = await Promise.all([
			read(table, `/api/session/${encodeURIComponent(sid)}/permission`),
			read(table, `/api/session/${encodeURIComponent(sid)}/form`),
		]);
		if (perms === null || forms === null)
			throw new Error("opencode api failed");
		for (const p of list<PermissionRequest>(perms)) {
			if (!p.id) continue;
			const action = String(p.action ?? "tool");
			const resources = (p.resources ?? []).map(String);
			const save = (p.save ?? []).map(String);
			out.push({
				key: p.id,
				sessionId: sid,
				kind: "permission",
				tool: action,
				input: {
					action,
					resources,
					...(p.message ? { message: p.message } : {}),
				},
				prompt: null,
				// "Always allow": OpenCode remembers these patterns.
				sessionRules: save.length ? save.map((s) => `${action}: ${s}`) : null,
				data: { type: "permission", id: p.id },
			});
		}
		for (const f of list<FormRequest>(forms)) {
			if (!f.id) continue;
			const mapped = formPrompt(f);
			if (!mapped) continue;
			out.push({
				key: f.id,
				sessionId: sid,
				kind: "question",
				tool: f.metadata?.kind === "question" ? "question" : "form",
				input: {},
				prompt: mapped.prompt,
				sessionRules: null,
				data: { type: "form", id: f.id, form: f, values: mapped.values },
			});
		}
	}
	return out;
}

export async function opencodeReply(
	p: ServerPrompt,
	r: ServerReply,
): Promise<boolean> {
	const d = p.data as
		| { type: "permission"; id: string }
		| { type: "form"; id: string; form: FormRequest; values: ValueMap };
	const base = `/api/session/${p.sessionId}`;
	if (d.type === "permission") {
		let decision = "reject";
		if (r.decision === "allow-session") decision = "always";
		else if (r.decision === "allow-once") decision = "once";
		const body = {
			decision,
			...(decision === "reject"
				? {
						message: r.note
							? `Denied from the Pulsar app: ${r.note}`
							: "Denied from the Pulsar app",
					}
				: {}),
		};
		return send("POST", `${base}/permission/${d.id}/reply`, body);
	}
	if (r.answer?.kind === "question")
		return send("POST", `${base}/form/${d.id}/reply`, {
			answer: formAnswer(d.form, d.values, r.answer.answers),
		});
	return send(
		"DELETE",
		`${base}/form/${d.id}?message=${encodeURIComponent("The user declined to answer from the Pulsar app.")}`,
	);
}
