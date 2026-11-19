/**
 * Whether an agent's last turn ended with an error from the harness itself
 * (an API error, a refused model, a usage limit), read from the end of its
 * session log. A failing tool call is not a failed turn, and neither is the
 * operator stopping the turn.
 *
 * Each reader takes the log's last bytes (whole lines; a cut first line is
 * skipped) and walks back to the record that ended the turn. Formats were
 * read from real logs: Claude Code 2.x, Codex 0.169, pi and omp.
 */

/** Records of `tail`, newest first; lines that are not JSON are skipped. */
function* newestFirst(tail: string): Generator<Record<string, unknown>> {
	const lines = tail.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line?.startsWith("{")) continue;
		try {
			const v = JSON.parse(line) as unknown;
			if (v && typeof v === "object") yield v as Record<string, unknown>;
		} catch {}
	}
}

const obj = (v: unknown): Record<string, unknown> | null =>
	v && typeof v === "object" ? (v as Record<string, unknown>) : null;

/** A Claude `user` record the person typed (not a tool result or a meta note). */
function claudePrompt(r: Record<string, unknown>): boolean {
	if (r.type !== "user" || r.isMeta === true) return false;
	const content = obj(r.message)?.content;
	if (typeof content === "string") return true;
	return (
		Array.isArray(content) &&
		!content.some((c) => obj(c)?.type === "tool_result")
	);
}

/**
 * Claude Code: the last main-thread assistant record of the last turn. A
 * turn that failed ends with a synthetic one marked `isApiErrorMessage`
 * ("API Error: 500", "You've hit your limit"); a retry that then answered
 * ends with a normal one. A prompt (or the "[Request interrupted by user]"
 * note) after it starts another turn, so an older failure is not this one.
 */
export function claudeTurnFailed(tail: string): boolean {
	for (const r of newestFirst(tail)) {
		if (r.isSidechain === true) continue;
		if (r.type === "assistant") return r.isApiErrorMessage === true;
		if (claudePrompt(r)) return false;
	}
	return false;
}

/**
 * Codex: the last turn event. `task_complete` carries `error` when the turn
 * failed (a refused model, an API error); older versions write a separate
 * `error` event. `turn_aborted` is the operator stopping it.
 */
export function codexTurnFailed(tail: string): boolean {
	for (const r of newestFirst(tail)) {
		if (r.type !== "event_msg") continue;
		const p = obj(r.payload);
		switch (p?.type) {
			case "task_complete":
				return p.error !== undefined && p.error !== null;
			case "error":
				return true;
			case "turn_aborted":
			case "task_started":
				return false;
		}
	}
	return false;
}

/**
 * pi and omp: the last assistant message of the last turn. `stopReason:
 * "error"` is a failed request; `aborted` is the operator stopping it. A
 * user message after it starts another turn.
 */
export function piTurnFailed(tail: string): boolean {
	for (const r of newestFirst(tail)) {
		if (r.type !== "message") continue;
		const m = obj(r.message);
		if (m?.role === "assistant") return m.stopReason === "error";
		if (m?.role === "user") return false;
	}
	return false;
}
