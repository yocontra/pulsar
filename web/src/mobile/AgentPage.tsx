/**
 * An agent: its conversation, a docked composer, and a bar with the agent's
 * name and live status. A prompt waiting on it shows inline in the
 * conversation; the banner brings it into view.
 */
import { EllipsisIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { Approval } from "../api/types.ts";
import { focusPrompt, promptOnScreen } from "../approval/focus.ts";
import { ChangesButton } from "../changes/ChangesButton.tsx";
import { shortModel } from "../lib/format.ts";
import { Slot } from "../lib/registry.tsx";
import { route } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import { approvalItem, findAgent, showToast } from "../lib/store.ts";
import { showFinished, subagentsLabel } from "../lib/subagents.ts";
import SessionView from "../session/SessionView.tsx";
import type { MessageAction } from "../session/Transcript.tsx";
import { agentMenu } from "./actions.ts";
import { BackButton } from "./BackButton.tsx";
import { now } from "./clock.ts";
import {
	IonButton,
	IonButtons,
	IonContent,
	IonHeader,
	IonTitle,
	IonToolbar,
} from "./ionic.ts";
import { loadIonicLazy } from "./lazyIonic.ts";
import { AgentStatus, harnessName } from "./rows.tsx";
import { SubagentsSection } from "./SubagentsSection.tsx";

/**
 * Long-press a message for its actions, as in Messages (no copy row under
 * every turn). Transcript reports each turn's text through
 * `messageActions`; the menu finds the pressed turn by its `data-msg-id`.
 */
function useMessageMenu() {
	const texts = useRef(new Map<string, string>());
	const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const at = useRef<{ x: number; y: number } | null>(null);
	const messageActions = useCallback((m: MessageAction) => {
		texts.current.set(m.id, m.text);
		return null;
	}, []);
	const open = async (target: EventTarget | null) => {
		const el =
			target instanceof Element
				? target.closest<HTMLElement>("[data-msg-id]")
				: null;
		const text = el ? texts.current.get(el.dataset.msgId ?? "") : undefined;
		if (!el || !text) return;
		el.classList.add("p-pressed");
		const { actionSheetController } = await loadIonicLazy();
		const sheet = await actionSheetController.create({
			buttons: [
				{
					text: "Copy",
					handler: () =>
						void navigator.clipboard.writeText(text).then(
							() => showToast("Copied"),
							() => showToast("Couldn't copy", "warn"),
						),
				},
				{ text: "Cancel", role: "cancel" },
			],
		});
		void sheet.onDidDismiss().then(() => el.classList.remove("p-pressed"));
		await sheet.present();
	};
	const cancel = () => {
		clearTimeout(t.current);
		at.current = null;
	};
	const handlers = {
		onTouchStart(e: React.TouchEvent) {
			const p = e.touches[0];
			if (!p || e.touches.length > 1) return;
			const target = e.target;
			at.current = { x: p.clientX, y: p.clientY };
			clearTimeout(t.current);
			t.current = setTimeout(() => void open(target), 500);
		},
		onTouchMove(e: React.TouchEvent) {
			const p = e.touches[0];
			const a = at.current;
			if (
				p &&
				a &&
				(Math.abs(p.clientX - a.x) > 8 || Math.abs(p.clientY - a.y) > 8)
			)
				cancel();
		},
		onTouchEnd: cancel,
		onTouchCancel: cancel,
		onContextMenu(e: React.MouseEvent) {
			const target = e.target;
			if (target instanceof Element && target.closest("[data-msg-id]")) {
				e.preventDefault();
				cancel();
				void open(target);
			}
		},
	};
	return { handlers, messageActions };
}

function AgentPageImpl({ id }: { id: string }) {
	const { handlers: messageMenu, messageActions } = useMessageMenu();
	const a = findAgent(id);
	const att = approvalItem(id);
	// An expired prompt no longer waits on the app: its card says so, and
	// the banner goes (the shared clock ticks every 15 s).
	const pending =
		att?.approval?.state === "pending" && att.approval.expiresAt > now.value;
	// A deep link (`#/approval/<id>`, a push): the card in view and focused.
	const deep = route.value.view === "approval" && route.value.id === id;
	useEffect(() => {
		if (deep && pending) focusPrompt(id);
	}, [deep, pending, id]);
	return (
		<>
			<IonHeader className="p-agent-header">
				<IonToolbar>
					<IonButtons slot="start">
						<BackButton route={{ view: "agent", id }} compact />
					</IonButtons>
					<IonTitle>
						<span className="p-nav-title">
							<h1>{a?.name ?? "Agent"}</h1>
							{a && (
								<span className="p-nav-sub">
									<AgentStatus a={a} reason short />
									<span className="p-nav-sub-more">
										{a.model
											? ` · ${shortModel(a.model)}`
											: ` · ${harnessName(a.harness)}`}
									</span>
								</span>
							)}
						</span>
					</IonTitle>
					<IonButtons slot="end">
						{a && <Slot name="session.header" agent={a} mobile />}
						<ChangesButton id={id} />
						<IonButton
							aria-label="More"
							disabled={!a}
							onClick={() => a && void agentMenu(a)}
						>
							<EllipsisIcon />
						</IonButton>
					</IonButtons>
				</IonToolbar>
				{subagentsLabel(a?.subagents, showFinished.value) && (
					<SubagentsSection agentId={id} />
				)}
				{pending && att?.approval && promptOnScreen.value !== id && (
					<IonToolbar className="p-approval-bar">
						<button
							type="button"
							className="p-approval-banner"
							onClick={() => focusPrompt(id)}
						>
							<span className="p-icon is-needs" aria-hidden="true">
								<ShieldCheckIcon />
							</span>
							<span className="p-ab-text">
								<strong>
									{att.approval.prompt ? "Answer needed" : "Approval needed"}
								</strong>
								<span>{bannerDetail(att.approval)}</span>
							</span>
							<span className="p-ab-cta">Review</span>
						</button>
					</IonToolbar>
				)}
			</IonHeader>
			<IonContent scrollY={false} className="p-plain p-agent">
				<div className="p-agent-body" {...messageMenu}>
					<SessionView id={id} mobile bare messageActions={messageActions} />
				</div>
			</IonContent>
		</>
	);
}

/**
 * The banner's second line: the tool an approval runs, or what a question
 * or dialog asks (never its tool name, `AskUserQuestion` or `ui.confirm`).
 */
function bannerDetail(ap: Approval): string {
	const p = ap.prompt;
	if (!p) return ap.tool;
	if (p.kind === "question")
		return p.title ?? p.questions[0]?.question ?? "Question";
	if (p.kind === "plan") return "Plan review";
	return p.title;
}

export default observer(AgentPageImpl);

/** The subagent page lives in this chunk too (pages.tsx loads it from here). */
export { default as SubagentPage } from "./SubagentPage.tsx";
