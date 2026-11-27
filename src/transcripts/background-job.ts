import { NOTICE_TEXT_CAP, type TranscriptEvent } from "./types.ts";

/** Keep task output in the shared expandable row and out of its title. */
export function backgroundJob(
	base: Pick<TranscriptEvent, "id" | "ts">,
	summary: string,
	status: string,
	body: string,
): TranscriptEvent {
	return {
		...base,
		role: "system",
		kind: "system",
		subtype: "task",
		notice: { type: "background_job", summary, status },
		text:
			body.length > NOTICE_TEXT_CAP
				? `${body.slice(0, NOTICE_TEXT_CAP)}\n…`
				: body,
	};
}
