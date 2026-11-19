import type { Approval, InteractionPrompt } from "../api/types.ts";
import { harnessUi } from "../harnesses/index.ts";
import { ConfirmForm, InputForm, SelectForm } from "./DialogForms.tsx";
import { PlanReview } from "./PlanReview.tsx";
import { QuestionForm } from "./QuestionForm.tsx";
import type { InteractionRenderer, RendererMap } from "./types.ts";

/** The renderer for each kind when the harness has no bespoke one. */
export const DEFAULT_RENDERERS: Required<RendererMap> = {
	question: QuestionForm,
	plan: PlanReview,
	confirm: ConfirmForm,
	select: SelectForm,
	input: InputForm,
};

/** The harness's renderer for this prompt, else the default for its kind. */
export function rendererFor(
	harness: string | null | undefined,
	prompt: InteractionPrompt,
): InteractionRenderer {
	const own = harnessUi(harness).interactions?.[prompt.kind];
	return (own ?? DEFAULT_RENDERERS[prompt.kind]) as InteractionRenderer;
}

const KIND_TITLE: Record<InteractionPrompt["kind"], string> = {
	question: "Question",
	plan: "Plan review",
	confirm: "Confirm",
	select: "Choose",
	input: "Input needed",
};

/** The card title: the harness's ("Claude asks"), else the kind's. */
export function interactionTitle(
	harness: string | null | undefined,
	approval: Approval,
): string {
	const own = harnessUi(harness).title?.(approval);
	if (own) return own;
	return approval.prompt ? KIND_TITLE[approval.prompt.kind] : "Approval";
}
