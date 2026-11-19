import type { ComponentType } from "react";
import type {
	AgentRow,
	Approval,
	InteractionAnswer,
	InteractionKind,
	InteractionPrompt,
} from "../api/types.ts";

/**
 * What every interaction renderer gets. The card around it (src:
 * InteractionCard.tsx) owns the passkey step, the countdown, the outcome
 * and errors; the renderer owns the prompt's body and its answer buttons.
 */
export interface InteractionRendererProps<
	P extends InteractionPrompt = InteractionPrompt,
> {
	approval: Approval;
	prompt: P;
	agent: AgentRow;
	/** Phone (Ionic sheet) or desktop (dialog / inline card). */
	mobile: boolean;
	/** True while signing or sending, or when this device can't sign. */
	disabled: boolean;
	/** Signs the answer with the passkey and sends it (first answer wins). */
	submit: (answer: InteractionAnswer) => void;
}

export type InteractionRenderer<
	P extends InteractionPrompt = InteractionPrompt,
> = ComponentType<InteractionRendererProps<P>>;

/** The prompt of one kind. */
export type PromptOf<K extends InteractionPrompt["kind"]> = Extract<
	InteractionPrompt,
	{ kind: K }
>;

export type RendererMap = {
	[K in Exclude<InteractionKind, "permission">]?: InteractionRenderer<
		Extract<InteractionPrompt, { kind: K }>
	>;
};

export type { HarnessUi } from "../harnesses/types.ts";
