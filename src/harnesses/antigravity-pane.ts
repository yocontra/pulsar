import { freshProcessSnapshot } from "../processes.ts";
import {
	capture,
	isPane,
	paneOf,
	panePid,
	pasteText,
	sendKeys,
	type TmuxOptions,
} from "../tmux.ts";
import type { Agent } from "../types.ts";
import {
	ANTIGRAVITY_SESSION_ID,
	antigravityProcess,
	nativeAntigravityProcess,
} from "./antigravity-ident.ts";
import { readScreen } from "./screens.ts";
import type { DeliveryResult, InterruptOutcome } from "./types.ts";

/** This CLI must own both the conversation and the pane's root process. */
export async function antigravityPane(agent: Agent, opts: TmuxOptions = {}) {
	if (
		!agent.pid ||
		agent.meta.subagentOf ||
		!agent.sessionId ||
		!ANTIGRAVITY_SESSION_ID.test(agent.sessionId)
	)
		return null;
	const pane = await paneOf(agent, opts);
	if (!pane || (await panePid(pane, opts)) !== agent.pid) return null;
	const proc = (await freshProcessSnapshot(0, "user"))?.get(agent.pid);
	if (!proc || !nativeAntigravityProcess(proc.args)) return null;
	return (await antigravityProcess(agent.pid)).sessionId === agent.sessionId
		? pane
		: null;
}
export const hasAntigravityPane = (agent: Agent) =>
	!!agent.pid &&
	!agent.meta.subagentOf &&
	!!agent.sessionId &&
	ANTIGRAVITY_SESSION_ID.test(agent.sessionId) &&
	isPane(agent.meta.tmux);

const pending = new Map<string, Promise<unknown>>();
export function withAntigravityPane<T>(
	id: string,
	action: () => Promise<T>,
): Promise<T> {
	const next = (pending.get(id) ?? Promise.resolve()).then(action, action);
	pending.set(id, next);
	return next.finally(() => {
		if (pending.get(id) === next) pending.delete(id);
	});
}
const screen = async (pane: string, opts: TmuxOptions) =>
	readScreen(
		"antigravity",
		(await capture(pane, { ...opts, ansi: true })) ?? "",
	);
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal sends may contain LF or TAB only
const CONTROL_BYTES = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 80));

export function interruptAntigravity(
	agent: Agent,
	opts: TmuxOptions = {},
): Promise<InterruptOutcome> {
	return withAntigravityPane(agent.id, async () => {
		const via = "tmux";
		const pane = await antigravityPane(agent, opts);
		const state = pane ? await screen(pane, opts) : null;
		if (!pane || !state?.recognized || state.input !== "empty")
			return {
				result: "unsupported",
				via,
				detail: "The native turn has no confirmed empty terminal prompt.",
			};
		if (!state.busy) return { result: "not-running", via };
		if (!(await sendKeys(pane, { keys: ["Escape"] }, opts)).ok)
			return { result: "unsupported", via, detail: "Could not send Escape." };
		for (let i = 0; i < 12; i++) {
			await settle();
			const now = await screen(pane, opts);
			if (now.recognized && !now.busy) return { result: "interrupted", via };
		}
		return {
			result: "unsupported",
			via,
			detail: "Antigravity did not confirm the interruption.",
		};
	});
}

/** The TUI inserts visual line breaks at words or at the last column. */
export function matchesAntigravityDraft(
	draft: string | undefined,
	original: string,
): boolean {
	if (draft === undefined) return false;
	const rows = draft.split("\n");
	let row = 0;
	for (const line of original.split("\n").map((value) => value.trimEnd())) {
		const first = rows[row++];
		if (first === undefined || !line.startsWith(first)) return false;
		let offset = first.length;
		while (offset < line.length) {
			const part = rows[row++];
			if (!part) return false;
			if (line[offset] === " " && line.startsWith(part, offset + 1)) offset++;
			if (!line.startsWith(part, offset)) return false;
			offset += part.length;
		}
	}
	return row === rows.length;
}
export function wakeAntigravityPane(
	agent: Agent,
	text: string,
	opts: TmuxOptions = {},
): Promise<DeliveryResult> {
	return withAntigravityPane(agent.id, async () => {
		const via = "tmux";
		const pane = await antigravityPane(agent, opts);
		const state = pane ? await screen(pane, opts) : null;
		// Control bytes can change terminal state even inside a paste.
		if (
			!pane ||
			!agent.pid ||
			!state?.recognized ||
			state.busy ||
			state.input !== "empty" ||
			CONTROL_BYTES.test(text) ||
			text.trimStart().startsWith("/")
		)
			return {
				ok: false,
				via,
				detail:
					"No idle, empty Antigravity prompt is available for this message.",
			};
		if (!(await pasteText(pane, agent.pid, text, opts)))
			return {
				ok: false,
				via,
				detail: "The native terminal declined bracketed paste.",
			};
		for (let i = 0; i < 12; i++) {
			await settle();
			if (!matchesAntigravityDraft((await screen(pane, opts)).draft, text))
				continue;
			if (
				(await antigravityPane(agent, opts)) !== pane ||
				!matchesAntigravityDraft((await screen(pane, opts)).draft, text)
			)
				break;
			const enter = await sendKeys(pane, { keys: ["Enter"] }, opts);
			if (!enter.ok)
				return {
					ok: false,
					uncertain: true,
					via,
					detail: "The terminal did not confirm Enter.",
				};
			for (let j = 0; j < 12; j++) {
				await settle();
				const now = await screen(pane, opts);
				if (now.recognized && now.input === "empty") return { ok: true, via };
			}
			return {
				ok: false,
				uncertain: true,
				via,
				detail: "The terminal did not confirm it submitted the draft.",
			};
		}
		return {
			ok: false,
			uncertain: true,
			via,
			detail:
				"The draft could not be verified. Inspect the native terminal before retrying.",
		};
	});
}
