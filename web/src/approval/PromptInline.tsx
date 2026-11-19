/**
 * A prompt in the conversation: the permission, question, plan or dialog
 * card with its actions, at the tool call that raised it (or pinned after
 * the last turn while that call isn't loaded). Once answered here, in the
 * terminal or elsewhere, it collapses to one outcome line. Asked to focus
 * (approval/focus.ts), it scrolls into view and focuses its first control.
 */
import { lazy, Suspense, useEffect, useRef } from "react";
import type { AttentionItem } from "../api/types.ts";
import { observer } from "../lib/signals.ts";
import { promptFocus } from "./focus.ts";
import { OutcomeLine } from "./OutcomeLine.tsx";

const ApprovalCard = lazy(() => import("./ApprovalCard.tsx"));

function PromptInlineImpl({
	item,
	mobile,
}: {
	item: AttentionItem;
	mobile: boolean;
}) {
	const ap = item.approval!;
	const ref = useRef<HTMLDivElement>(null);
	const focus = promptFocus.value;
	const want = focus?.agentId === item.agent.id ? focus.n : 0;
	useEffect(() => {
		if (!want) return;
		let tries = 0;
		// The card's chunk may still be loading: wait for its first control.
		const go = () => {
			const el = ref.current;
			const first = el?.querySelector<HTMLElement>(
				"button:not(:disabled), input:not(:disabled), textarea:not(:disabled)",
			);
			if (el && (first || tries > 20)) {
				el.scrollIntoView({ block: "center" });
				// No enabled control (this device can't answer): the card itself.
				(first ?? el).focus({ preventScroll: true });
				return;
			}
			tries++;
			timer = setTimeout(go, 50);
		};
		let timer = setTimeout(go, 0);
		return () => clearTimeout(timer);
	}, [want]);

	if (ap.state !== "pending" && ap.outcome)
		return <OutcomeLine outcome={ap.outcome} />;
	return (
		<div
			ref={ref}
			id="approval"
			tabIndex={-1}
			className={`prompt-inline${mobile ? " prompt-inline--phone" : ""}`}
		>
			<Suspense fallback={<div className="d-approval-loading" />}>
				<ApprovalCard item={item} mobile={mobile} inline />
			</Suspense>
		</div>
	);
}

export const PromptInline = observer(PromptInlineImpl);

/** Same JSON, whatever the key order. */
function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (v && typeof v === "object")
		return `{${Object.keys(v)
			.sort()
			.map(
				(k) =>
					`${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
			)
			.join(",")}}`;
	return JSON.stringify(v) ?? "null";
}

/**
 * The transcript's call that raised this prompt: the latest call of the
 * same tool with exactly this input. Null when it isn't loaded (pin the
 * card after the last turn) or the prompt has no tool input (an extension
 * dialog).
 */
export function promptCallId(
	events: readonly {
		kind: string;
		tool?: { name: string; callId: string; input?: unknown };
	}[],
	ap: { tool: string; input: Record<string, unknown> },
): string | null {
	if (!Object.keys(ap.input).length) return null;
	const want = canonical(ap.input);
	for (let i = events.length - 1; i >= 0; i--) {
		const t = events[i]!.tool;
		if (
			events[i]!.kind === "tool_call" &&
			t?.name === ap.tool &&
			canonical(t.input ?? {}) === want
		)
			return t.callId;
	}
	return null;
}
