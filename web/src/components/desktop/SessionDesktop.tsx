import { CopyIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { focusPrompt } from "../../approval/focus.ts";
import { ChangesSplit, ChangesToggle } from "../../changes/ChangesSplit.tsx";
import { useAgent, useApprovalItem } from "../../data/index.ts";
import { CopyButton, type MessageAction } from "../../ds/conversation.ts";
import { observer } from "../../lib/signals.ts";
import { findAgent } from "../../lib/store.ts";
import SessionView from "../../session/SessionView.tsx";
import { DesktopSessionHeader } from "./SessionHeader.tsx";

/**
 * The desktop agent screen: its own chrome (header with live status and
 * Stop) around the shared conversation (with any prompt card inline) and
 * composer (session/SessionView.tsx, which the phone wraps in its own
 * chrome). Route `#/a/<id>`, or `#/approval/<id>` with the prompt card focused.
 */
function SessionDesktopImpl({
	id,
	approval,
	changes,
}: {
	id: string;
	approval?: boolean;
	/** `#/changes/<id>`: the changes panel open (on this file). */
	changes?: { file: string | null };
}) {
	const agent = useAgent(id).data ?? findAgent(id);
	// `#/approval/<id>` (Needs You, a push, a badge): the conversation, with
	// its inline prompt card in view and focused.
	const att = useApprovalItem(id);
	const pending = att?.approval?.state === "pending";
	useEffect(() => {
		if (approval && pending) focusPrompt(id);
	}, [approval, id, pending]);
	// Each turn's text, for the right-click menu (filled as turns render).
	const texts = useRef(new Map<string, string>());
	// Stable: the transcript memoizes on it.
	const messageActions = useCallback((m: MessageAction) => {
		texts.current.set(m.id, m.text);
		return m.kind === "assistant" ? (
			<CopyButton text={m.text} label="Copy message" />
		) : null;
	}, []);
	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		text: string;
	} | null>(null);
	const onContextMenu = (e: React.MouseEvent) => {
		// Leave the browser's menu for selected text and links.
		if (
			window.getSelection()?.toString() ||
			(e.target as HTMLElement).closest("a")
		)
			return;
		const turn = (e.target as HTMLElement).closest<HTMLElement>(
			"[data-msg-id]",
		);
		const text = turn && texts.current.get(turn.dataset.msgId ?? "");
		if (!text) return;
		e.preventDefault();
		setMenu({ x: e.clientX, y: e.clientY, text });
	};
	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		const key = (e: KeyboardEvent) => e.key === "Escape" && close();
		addEventListener("click", close);
		addEventListener("blur", close);
		addEventListener("keydown", key);
		return () => {
			removeEventListener("click", close);
			removeEventListener("blur", close);
			removeEventListener("keydown", key);
		};
	}, [menu]);
	return (
		<div className="d-session" onContextMenu={onContextMenu}>
			<DesktopSessionHeader agent={agent} extra={<ChangesToggle id={id} />} />
			<ChangesSplit id={id} open={!!changes} file={changes?.file ?? null}>
				<SessionView
					id={id}
					mobile={false}
					bare
					messageActions={messageActions}
				/>
			</ChangesSplit>
			{menu && (
				<div
					className="context-menu d-menu"
					role="menu"
					style={{ left: menu.x, top: menu.y }}
				>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							void navigator.clipboard?.writeText(menu.text).catch(() => {});
							setMenu(null);
						}}
					>
						<CopyIcon aria-hidden="true" />
						Copy message
					</button>
				</div>
			)}
		</div>
	);
}

export default observer(SessionDesktopImpl);

/** The subagent page lives in this chunk too (DesktopLayout loads it from here). */
export { SubagentView } from "../../session/SubagentView.tsx";
/** The operator's prompts (no conversation): see PromptDialog.tsx. */
export { PromptDialog } from "./PromptDialog.tsx";
