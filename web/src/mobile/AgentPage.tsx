/**
 * An agent: its conversation, the composer in a floating dock, and a bar
 * with the agent's name and live status (AgentBar). The bar's actions:
 * git, Find, Changes and More; at 360 px or less, Changes and More, with
 * git and Find in More. A prompt waiting on it shows inline in the
 * conversation; the banner brings it into view.
 */
import { EllipsisIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRow, Approval } from "../api/types.ts";
import { focusPrompt, promptOnScreen } from "../approval/focus.ts";
import { ChangesButton } from "../changes/ChangesButton.tsx";
import { gitOffered, showGit } from "../features/git/open.ts";
import { openFind } from "../features/search/state.ts";
import { shortModel } from "../lib/format.ts";
import { Slot } from "../lib/registry.tsx";
import { route } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import { approvalItem, can, findAgent, showToast } from "../lib/store.ts";
import { showFinished, subagentsLabel } from "../lib/subagents.ts";
import SessionView from "../session/SessionView.tsx";
import type { MessageAction } from "../session/Transcript.tsx";
import { AgentBar, useUnderGlass } from "./AgentBar.tsx";
import { agentButtons } from "./actions.ts";
import { now } from "./clock.ts";
import { IonButton, IonContent, IonToolbar } from "./ionic.ts";
import { isMaterial } from "./platform.ts";
import { AgentStatus, harnessName } from "./rows.tsx";
import { SubagentsSection } from "./SubagentsSection.tsx";
import { showActions } from "./ui/actions.ts";
import { Menu, type MenuItem } from "./ui/Menu.tsx";

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
		await showActions({
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
		el.classList.remove("p-pressed");
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

/** At 360 px or less the bar keeps Changes and More; git and Find move into More. */
const NARROW = "(max-width: 360px)";

function useNarrow() {
	const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
	useEffect(() => {
		const mq = matchMedia(NARROW);
		const on = () => setNarrow(mq.matches);
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, []);
	return narrow;
}

/** The ••• button and its menu (a Konsta popover anchored to it). */
const MoreMenu = observer(function MoreMenu({ a }: { a: AgentRow | null }) {
	const [open, setOpen] = useState(false);
	const btn = useRef<HTMLIonButtonElement | null>(null);
	const narrow = useNarrow();
	const items: MenuItem[] = [];
	if (a && narrow) {
		if (gitOffered.value.has(a.id))
			items.push({
				label: "Git",
				onSelect: () => showGit(a.id),
			});
		items.push({
			label: "Find in Messages",
			disabled: !can("search") || !a.hasTranscript,
			onSelect: () => openFind(a.id),
		});
	}
	if (a)
		for (const b of agentButtons(a))
			items.push({
				label: b.text,
				destructive: b.role === "destructive",
				disabled: b.disabled,
				onSelect: () => b.handler?.(),
			});
	return (
		<>
			<IonButton
				ref={btn}
				aria-label="More"
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={!a}
				onClick={() => setOpen(true)}
			>
				<EllipsisIcon aria-hidden="true" />
			</IonButton>
			{a && (
				<Menu
					open={open}
					onClose={() => setOpen(false)}
					target={btn}
					items={items}
					label={`${a.name} actions`}
				/>
			)}
		</>
	);
});

function AgentPageImpl({ id }: { id: string }) {
	const { handlers: messageMenu, messageActions } = useMessageMenu();
	const content = useRef<HTMLIonContentElement | null>(null);
	useUnderGlass(content);
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
	const banner = pending && att?.approval && promptOnScreen.value !== id && (
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
	);
	return (
		<>
			<AgentBar
				route={{ view: "agent", id }}
				name={a?.name ?? "Agent"}
				sub={
					a && (
						<>
							<AgentStatus a={a} reason short />
							<span className="p-nav-sub-more">
								{a.model
									? ` · ${shortModel(a.model)}`
									: ` · ${harnessName(a.harness)}`}
							</span>
						</>
					)
				}
				end={
					<>
						{a && <Slot name="session.header" agent={a} mobile />}
						<ChangesButton id={id} />
						<MoreMenu a={a} />
					</>
				}
				below={
					<>
						{subagentsLabel(a?.subagents, showFinished.value) && (
							<SubagentsSection agentId={id} />
						)}
						{banner}
					</>
				}
			/>
			<IonContent
				ref={content}
				scrollY={false}
				fullscreen={!isMaterial}
				className="p-plain p-agent"
			>
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
