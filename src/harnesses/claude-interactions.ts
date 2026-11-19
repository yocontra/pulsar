import type {
	InteractionAnswer,
	InteractionPrompt,
	PlanChoice,
} from "../http/wire.ts";
import { cleanPrompt } from "../service/interactions.ts";
import type { HookDecision } from "./types.ts";

/**
 * Claude Code's interactive tools, relayed through the PermissionRequest hook.
 * Verified with Claude Code 2.1.327 in tmux:
 *
 * - AskUserQuestion: `allow` with `updatedInput: {...input, answers}`, where
 *   `answers` maps each question's text to the picked label, labels joined
 *   with ", " for multi-select, or the typed text for "Other".
 * - ExitPlanMode: `allow` must carry `updatedInput` (the input as it came) or
 *   the plan dialog stays open; `deny` with a message keeps Claude planning
 *   and the model reads the message.
 */

const PLAN_CHOICES: PlanChoice[] = [
	{ id: "approve", label: "Approve plan", approves: true },
	{
		id: "keep-planning",
		label: "Keep planning",
		approves: false,
		feedback: true,
	},
];

export function classifyClaude(
	tool: string,
	input: Record<string, unknown>,
): InteractionPrompt | null {
	if (tool === "AskUserQuestion") {
		const qs = Array.isArray(input.questions) ? input.questions : [];
		return cleanPrompt({
			kind: "question",
			questions: qs.map((q) => {
				const x = (q ?? {}) as Record<string, unknown>;
				// Claude keys answers by the question text; its card always offers free text.
				return { ...x, id: x.question, allowOther: true };
			}),
		});
	}
	// Outside auto and plan mode Claude asks first ("Enter plan mode?"), and
	// like the other interactive tools a bare allow leaves its dialog open.
	if (tool === "EnterPlanMode")
		return cleanPrompt({
			kind: "confirm",
			title: "Enter plan mode?",
			message: "Claude wants to plan first, without changing files.",
		});
	if (tool === "ExitPlanMode")
		return cleanPrompt({
			kind: "plan",
			plan: typeof input.plan === "string" ? input.plan : "",
			planFile: input.planFilePath,
			choices: PLAN_CHOICES,
		});
	return null;
}

const DECLINED = "The user declined to answer from the Pulsar app.";

export function decideClaude(
	prompt: InteractionPrompt,
	input: Record<string, unknown>,
	answer: InteractionAnswer,
): HookDecision {
	if (prompt.kind === "question" && answer.kind === "question") {
		const answers: Record<string, string> = {};
		for (const q of prompt.questions)
			answers[q.id] = (answer.answers[q.id] ?? []).join(", ");
		return { behavior: "allow", updatedInput: { ...input, answers } };
	}
	if (
		prompt.kind === "confirm" &&
		answer.kind === "confirm" &&
		answer.confirmed
	)
		return { behavior: "allow", updatedInput: input };
	if (prompt.kind === "plan" && answer.kind === "plan") {
		const choice = prompt.choices.find((c) => c.id === answer.choice);
		if (choice?.approves) return { behavior: "allow", updatedInput: input };
		return {
			behavior: "deny",
			message: answer.feedback
				? `Keep planning. Feedback from the Pulsar app: ${answer.feedback}`
				: "Keep planning: the user did not approve the plan in the Pulsar app.",
		};
	}
	// Cancel, a declined confirm, or an answer that does not fit the prompt.
	return { behavior: "deny", message: DECLINED };
}
