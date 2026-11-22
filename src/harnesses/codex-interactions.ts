import type { InteractionPrompt } from "../http/wire.ts";
import { cleanPrompt } from "../service/interactions.ts";
import type { Agent } from "../types.ts";
import { statAsync, tailAsync } from "../util.ts";
import type { ServerPrompt } from "./types.ts";

/**
 * Codex prompts read from the rollout, shown read-only: the fallback for a
 * thread the app-server daemon doesn't run (a TUI started with
 * `--no-daemon`), whose prompts only its own terminal can answer. Threads
 * in the daemon are answered from the app (codex-watch.ts). The rollout
 * records the model's call before the answer, so an unanswered call there
 * is a pending prompt: the app shows a read-only card.
 */

interface Line {
	type?: string;
	payload?: {
		type?: string;
		name?: string;
		arguments?: string;
		call_id?: string;
		command?: unknown;
		reason?: string;
	};
}

/** Prompts still waiting in one rollout's text (its tail). */
export function codexPendingIn(
	text: string,
): Omit<ServerPrompt, "sessionId">[] {
	const calls = new Map<string, Omit<ServerPrompt, "sessionId">>();
	const done = new Set<string>();
	for (const raw of text.split("\n")) {
		if (!raw.includes("call_id")) continue;
		let l: Line;
		try {
			l = JSON.parse(raw);
		} catch {
			continue;
		}
		const p = l.payload;
		const id = p?.call_id;
		if (!p || !id) continue;
		if (
			p.type === "function_call_output" ||
			p.type === "custom_tool_call_output" ||
			p.type === "exec_command_end" ||
			p.type === "patch_apply_end"
		) {
			done.add(id);
			continue;
		}
		if (p.type === "function_call" && p.name === "request_user_input") {
			const prompt = questionPrompt(p.arguments);
			if (prompt)
				calls.set(id, {
					key: id,
					kind: "question",
					tool: "request_user_input",
					input: {},
					prompt,
					sessionRules: null,
					readOnly: true,
				});
		} else if (
			l.type === "event_msg" &&
			(p.type === "exec_approval_request" ||
				p.type === "apply_patch_approval_request")
		) {
			let command: string | undefined;
			if (Array.isArray(p.command)) command = p.command.map(String).join(" ");
			else if (typeof p.command === "string") command = p.command;
			calls.set(id, {
				key: id,
				kind: "permission",
				tool: p.type === "exec_approval_request" ? "exec" : "apply_patch",
				input: {
					...(command ? { command } : {}),
					...(p.reason ? { reason: p.reason } : {}),
				},
				prompt: null,
				sessionRules: null,
				readOnly: true,
			});
		}
	}
	return [...calls.values()].filter((c) => !done.has(c.key));
}

/** `request_user_input` arguments: `{questions: [{id, header, question, options, isOther, isSecret}]}`. */
function questionPrompt(args: string | undefined): InteractionPrompt | null {
	let a: { questions?: unknown };
	try {
		a = JSON.parse(args ?? "");
	} catch {
		return null;
	}
	return codexQuestions(a.questions);
}

/** Codex's questions (`request_user_input`, the app-server's `requestUserInput`) as a card. */
export function codexQuestions(questions: unknown): InteractionPrompt | null {
	const list = Array.isArray(questions)
		? (questions as Record<string, unknown>[])
		: [];
	return cleanPrompt({
		kind: "question",
		questions: list.map((q, i) => ({
			id: q.id ?? `q${i}`,
			question: q.question,
			header: q.header,
			multiSelect: false,
			options: Array.isArray(q.options) ? q.options : [],
			allowOther: q.isOther === true,
			secret: q.isSecret === true,
		})),
	});
}

/** How much of a rollout's end is read for its pending calls. */
const TAIL_BYTES = 256 * 1024;

/** Each rollout's pending calls, kept while its size and mtime stay the same. */
const pendingCache = new Map<
	string,
	{ size: number; mtimeMs: number; pending: Omit<ServerPrompt, "sessionId">[] }
>();

/** Bytes read from rollouts so far (tests check that unchanged files are not re-read). */
export const codexReadStats = { bytes: 0 };

/**
 * Pending prompts of every live Codex thread. A rollout that has not changed
 * since the last poll is not read again: most polls only stat each file.
 */
export async function codexPending(
	agents: Agent[],
	rollout: (threadId: string) => Promise<string | null>,
): Promise<ServerPrompt[]> {
	const out: ServerPrompt[] = [];
	const seen = new Set<string>();
	for (const a of agents) {
		// Codex reports no busy/idle: every live thread is checked.
		if (!a.sessionId || a.status === "gone") continue;
		const file = await rollout(a.sessionId);
		const st = file ? await statAsync(file) : null;
		if (!file || !st) continue;
		seen.add(file);
		let hit = pendingCache.get(file);
		if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
			const text = await tailAsync(file, TAIL_BYTES);
			codexReadStats.bytes += Buffer.byteLength(text);
			hit = {
				size: st.size,
				mtimeMs: st.mtimeMs,
				pending: codexPendingIn(text),
			};
			pendingCache.set(file, hit);
		}
		for (const p of hit.pending) out.push({ ...p, sessionId: a.sessionId });
	}
	// Threads that ended (or left the registry) drop out of the cache.
	for (const file of pendingCache.keys())
		if (!seen.has(file)) pendingCache.delete(file);
	return out;
}
