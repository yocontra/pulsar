import { ScanFaceIcon } from "lucide-react";
import { useId, useState } from "react";
import type { InteractionQuestion } from "../api/types.ts";
import { faceIdLabel, useAsksFaceId } from "../approval/faceid.ts";
import { btn } from "./buttons.ts";
import type { InteractionRendererProps, PromptOf } from "./types.ts";

interface Pick {
	labels: string[];
	other: string;
	otherOn: boolean;
}

const empty: Pick = { labels: [], other: "", otherOn: false };

/** The answer list for one question: picked labels, then the free text. */
function answerOf(q: InteractionQuestion, p: Pick): string[] {
	const other = p.otherOn || q.options.length === 0 ? p.other.trim() : "";
	return [...p.labels, ...(other ? [other] : [])];
}

/**
 * A multiple-choice question card (Claude's AskUserQuestion, OpenCode's
 * `question`, omp's `ask` form): one block per question with its chip,
 * options as radios or checkboxes with descriptions, and "Other" free text.
 */
export function QuestionForm({
	approval,
	prompt,
	mobile,
	disabled,
	submit,
}: InteractionRendererProps<PromptOf<"question">>) {
	const [picks, setPicks] = useState<Record<string, Pick>>({});
	const asks = useAsksFaceId(approval);
	const base = useId();
	const get = (q: InteractionQuestion) => picks[q.id] ?? empty;
	const set = (q: InteractionQuestion, p: Partial<Pick>) =>
		setPicks((all) => ({ ...all, [q.id]: { ...get(q), ...p } }));
	const complete = prompt.questions.every((q) => answerOf(q, get(q)).length);

	return (
		<form
			className={`ix-question${mobile ? " mobile" : ""}`}
			onSubmit={(e) => {
				e.preventDefault();
				if (!complete || disabled) return;
				const answers: Record<string, string[]> = {};
				for (const q of prompt.questions) answers[q.id] = answerOf(q, get(q));
				submit({ kind: "question", answers });
			}}
		>
			{prompt.title && <p className="ix-title">{prompt.title}</p>}
			{prompt.questions.map((q, qi) => {
				const p = get(q);
				const name = `${base}-q${qi}`;
				const freeOnly = q.options.length === 0;
				return (
					<fieldset key={q.id} className="ix-q">
						<legend>
							{q.header && <span className="ix-chip">{q.header}</span>}
							<span
								className={`ix-q-text${q.question.length > 160 ? " long" : ""}`}
							>
								{q.question}
							</span>
							{q.multiSelect && <span className="ix-hint">Pick any</span>}
						</legend>
						{q.options.map((o) => {
							const on = p.labels.includes(o.label);
							return (
								<label key={o.label} className={`ix-opt${on ? " on" : ""}`}>
									<input
										type={q.multiSelect ? "checkbox" : "radio"}
										name={name}
										checked={on}
										disabled={disabled}
										onChange={() =>
											set(
												q,
												q.multiSelect
													? {
															labels: on
																? p.labels.filter((l) => l !== o.label)
																: [...p.labels, o.label],
														}
													: { labels: [o.label], otherOn: false },
											)
										}
									/>
									<span className="ix-opt-body">
										<span className="ix-opt-label">{o.label}</span>
										{o.description && (
											<span className="ix-opt-desc">{o.description}</span>
										)}
									</span>
								</label>
							);
						})}
						{q.allowOther && !freeOnly && (
							<label className={`ix-opt${p.otherOn ? " on" : ""}`}>
								<input
									type={q.multiSelect ? "checkbox" : "radio"}
									name={name}
									checked={p.otherOn}
									disabled={disabled}
									onChange={() =>
										set(
											q,
											q.multiSelect
												? { otherOn: !p.otherOn }
												: { labels: [], otherOn: true },
										)
									}
								/>
								<span className="ix-opt-body">
									<span className="ix-opt-label">Other</span>
								</span>
							</label>
						)}
						{(freeOnly || p.otherOn) &&
							(q.multiline ? (
								<textarea
									className="ix-text"
									rows={3}
									aria-label={
										freeOnly ? q.question : `Other answer: ${q.question}`
									}
									value={p.other}
									disabled={disabled}
									onChange={(e) => set(q, { other: e.target.value })}
								/>
							) : (
								<input
									className="ix-text"
									type={q.secret ? "password" : "text"}
									aria-label={
										freeOnly ? q.question : `Other answer: ${q.question}`
									}
									placeholder={freeOnly ? "Your answer" : "Type your answer"}
									value={p.other}
									disabled={disabled}
									// biome-ignore lint/a11y/noAutofocus: the field the person just chose
									autoFocus={!freeOnly}
									onChange={(e) => set(q, { other: e.target.value })}
								/>
							))}
					</fieldset>
				);
			})}
			<div className="ix-actions">
				<button
					type="button"
					className={btn(mobile, "secondary")}
					disabled={disabled}
					onClick={() => submit({ kind: "cancel" })}
				>
					Decline
				</button>
				<button
					type="submit"
					className={btn(mobile, "primary")}
					disabled={disabled || !complete}
					aria-label={faceIdLabel("Send answer", asks)}
				>
					{mobile && asks && <ScanFaceIcon className="size-5 faceid-mark" />}{" "}
					Send answer
				</button>
			</div>
		</form>
	);
}
