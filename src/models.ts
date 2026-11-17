import {
	claudeTranscript,
	codexRollout,
	head,
	opencodeMessages,
	tail,
} from "./transcripts.ts";

/** The last model id written in a JSONL log, skipping placeholders like `<synthetic>`. */
function lastModel(text: string): string | null {
	const re = /"model"\s*:\s*"([^"<>]+)"/g;
	let found: string | null = null;
	for (let m = re.exec(text); m; m = re.exec(text)) found = m[1] ?? found;
	return found;
}

/** Claude Code: the model on the latest assistant entry of the session transcript. */
export function claudeModel(
	cwd: string | null,
	sessionId: string,
): string | null {
	const file = claudeTranscript(cwd, sessionId);
	return file ? lastModel(tail(file)) : null;
}

/** Codex: the model in the thread's latest turn context (long rollouts state it near the start). */
export function codexModel(threadId: string): string | null {
	const file = codexRollout(threadId);
	if (!file) return null;
	return lastModel(tail(file, 512 * 1024)) ?? lastModel(head(file));
}

/** OpenCode: the model of the session's newest assistant message. */
export async function opencodeModel(sessionId: string): Promise<string | null> {
	for (const m of (await opencodeMessages(sessionId)) as Array<{
		type?: string;
		model?: { id?: string };
	}>) {
		if (m.type === "assistant" && m.model?.id) return m.model.id;
	}
	return null;
}
