import { ScanFaceIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useAsksFaceId } from "../approval/faceid.ts";
import { btn } from "./buttons.ts";
import type { InteractionRendererProps, PromptOf } from "./types.ts";

// The transcript's Markdown renderer (sanitized; never the agent's HTML).
const Markdown = lazy(() =>
	import("../components/ai-elements/message.tsx").then((m) => ({
		default: m.MessageResponse,
	})),
);

/**
 * Plan approval (Claude's ExitPlanMode, omp's plan review): the plan as
 * Markdown, then the harness's choices. A choice that takes feedback
 * (Keep planning, Refine) opens a note first.
 */
export function PlanReview({
	approval,
	prompt,
	mobile,
	disabled,
	submit,
}: InteractionRendererProps<PromptOf<"plan">>) {
	const asks = useAsksFaceId(approval);
	const [feedbackFor, setFeedbackFor] = useState<string | null>(null);
	const [feedback, setFeedback] = useState("");
	const chosen = prompt.choices.find((c) => c.id === feedbackFor);
	return (
		<div className={`ix-plan${mobile ? " mobile" : ""}`}>
			{prompt.planFile && (
				<p className="ix-plan-file mono small muted">{prompt.planFile}</p>
			)}
			<section className="ix-plan-body" aria-label="Plan">
				<Suspense fallback={<pre className="ix-plan-raw">{prompt.plan}</pre>}>
					<Markdown>{prompt.plan}</Markdown>
				</Suspense>
			</section>
			{chosen ? (
				<form
					className="ix-feedback"
					onSubmit={(e) => {
						e.preventDefault();
						submit({
							kind: "plan",
							choice: chosen.id,
							...(feedback.trim() ? { feedback: feedback.trim() } : {}),
						});
					}}
				>
					<textarea
						className="ix-text"
						rows={3}
						aria-label="Feedback for the agent"
						placeholder="What should change? (optional)"
						value={feedback}
						disabled={disabled}
						// biome-ignore lint/a11y/noAutofocus: opened by the person's click
						autoFocus
						onChange={(e) => setFeedback(e.target.value)}
					/>
					<div className="ix-actions">
						<button
							type="button"
							className={btn(mobile, "secondary")}
							onClick={() => setFeedbackFor(null)}
						>
							Back
						</button>
						<button
							type="submit"
							className={btn(mobile, "primary")}
							disabled={disabled}
						>
							{mobile && asks && (
								<ScanFaceIcon className="size-5 faceid-mark" />
							)}{" "}
							{chosen.label}
						</button>
					</div>
				</form>
			) : (
				<div className="ix-actions ix-plan-choices">
					{prompt.choices.map((c) => (
						<button
							key={c.id}
							type="button"
							className={btn(mobile, c.approves ? "primary" : "secondary")}
							disabled={disabled}
							onClick={() =>
								c.feedback
									? setFeedbackFor(c.id)
									: submit({ kind: "plan", choice: c.id })
							}
						>
							{mobile && asks && c.approves && (
								<ScanFaceIcon className="size-5 faceid-mark" />
							)}{" "}
							{c.label}
							{c.feedback ? "…" : ""}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
