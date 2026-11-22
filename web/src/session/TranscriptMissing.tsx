import { useEffect, useState } from "react";
import { harnessName } from "../components/ui/agent-avatar.tsx";
import type { TranscriptMissing } from "../data/patch.ts";
import { TranscriptSkeleton } from "./ConversationView.tsx";

/**
 * How long a transcript not found yet shows as loading before the notice
 * says why. A new session's log is usually written within a second or two.
 */
export const TRANSCRIPT_WAIT_MS = 6000;

/**
 * What a conversation shows while it has no events and no transcript was
 * found (`missing`):
 * - `unsupported`: the harness keeps none Pulsar can read. Said plainly.
 * - `not_found`, `no_session`: the transcript may still come (a log not
 *   written yet, a session not started). Loading at first; after
 *   `TRANSCRIPT_WAIT_MS`, the reason with Retry. The page keeps asking
 *   meanwhile (data/hooks.ts `useTranscript`), so it shows once found.
 */
export function TranscriptMissingNotice({
	missing,
	harness,
	subject,
	variant,
	onRetry,
}: {
	missing: TranscriptMissing;
	harness: string;
	subject: "agent" | "subagent";
	variant: "desktop" | "phone";
	onRetry: () => void;
}) {
	const pending = missing !== "unsupported";
	const [waited, setWaited] = useState(false);
	useEffect(() => {
		setWaited(false);
		if (!pending) return;
		const t = setTimeout(() => setWaited(true), TRANSCRIPT_WAIT_MS);
		return () => clearTimeout(t);
	}, [pending, missing]);

	if (missing === "unsupported")
		return (
			<div
				className="ds-banner banner"
				role="status"
				data-transcript-missing={missing}
			>
				{subject === "agent"
					? "No transcript for this agent. You can still message it; replies show here."
					: "No transcript for this subagent."}
			</div>
		);
	if (!waited) return <TranscriptSkeleton variant={variant} />;
	const name = harnessName(harness);
	const why =
		missing === "no_session"
			? `${name} hasn't started a session for this ${subject} yet.`
			: `${name} hasn't written this ${subject}'s log yet, or Pulsar can't find it.`;
	return (
		<div
			className="ds-banner banner"
			role="status"
			data-transcript-missing={missing}
		>
			No transcript yet. {why} It shows here once it's found.{" "}
			<button type="button" className="link" onClick={onRetry}>
				Retry
			</button>
		</div>
	);
}
