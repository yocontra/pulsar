/**
 * The desktop session's body: the conversation, and the changes panel
 * beside it when open (lazy: its code loads on first open). The panel is
 * resizable from its left edge (drag, arrow keys, double-click to reset);
 * ⌘\ toggles it. Open state and width persist per device.
 */
import { FileDiffIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef } from "react";
import { observer } from "../lib/signals.ts";
import { useChangesPeek } from "./data.ts";
import {
	changesOpen,
	isToggleKey,
	PANEL_DEFAULT,
	PANEL_MIN,
	PANEL_STEP,
	panelMax,
	panelWidth,
	SHORTCUT_LABEL,
	setChangesOpen,
	setPanelWidth,
	toggleChanges,
} from "./panel-state.ts";
import "./changes.css";

const ChangesPanel = lazy(() => import("./ChangesPanel.tsx"));

function ResizerImpl() {
	const drag = useRef<{ x: number; w: number; frame: number; next: number }>(
		null,
	);
	const w = panelWidth.value;
	const end = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d) return;
		cancelAnimationFrame(d.frame);
		drag.current = null;
		document.documentElement.classList.remove("d-resizing");
		if (e.currentTarget.hasPointerCapture(e.pointerId))
			e.currentTarget.releasePointerCapture(e.pointerId);
		setPanelWidth(d.next);
	};
	return (
		<div
			className="cv-resizer"
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize changes panel"
			aria-valuemin={PANEL_MIN}
			aria-valuemax={panelMax()}
			aria-valuenow={w}
			tabIndex={0}
			title="Drag to resize. Double-click to reset."
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				drag.current = { x: e.clientX, w, frame: 0, next: w };
				document.documentElement.classList.add("d-resizing");
			}}
			onPointerMove={(e) => {
				const d = drag.current;
				if (!d) return;
				// The handle is on the panel's left edge: dragging left widens it.
				d.next = d.w - (e.clientX - d.x);
				cancelAnimationFrame(d.frame);
				d.frame = requestAnimationFrame(() => setPanelWidth(d.next, false));
			}}
			onPointerUp={end}
			onPointerCancel={end}
			onDoubleClick={() => setPanelWidth(PANEL_DEFAULT)}
			onKeyDown={(e) => {
				const next =
					e.key === "ArrowLeft"
						? w + PANEL_STEP
						: e.key === "ArrowRight"
							? w - PANEL_STEP
							: e.key === "Home"
								? panelMax()
								: e.key === "End"
									? PANEL_MIN
									: null;
				if (next === null) return;
				e.preventDefault();
				setPanelWidth(next);
			}}
		/>
	);
}
const Resizer = observer(ResizerImpl);

function ChangesSplitImpl({
	id,
	open: force,
	file,
	children,
}: {
	id: string;
	/** The route asks for the panel (`#/changes/<id>`). */
	open?: boolean;
	/** The file the route names. */
	file?: string | null;
	children: React.ReactNode;
}) {
	useEffect(() => {
		if (force) setChangesOpen(true, false);
	}, [force]);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!isToggleKey(e)) return;
			e.preventDefault();
			toggleChanges();
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, []);
	const open = changesOpen.value;
	return (
		<div
			className={`cv-split${open ? " open" : ""}`}
			style={{ "--cv-w": `${panelWidth.value}px` } as React.CSSProperties}
		>
			<div className="cv-main">{children}</div>
			{open && (
				<>
					<Resizer />
					<Suspense
						fallback={
							<aside
								className="cv-panel"
								aria-label="Changes"
								aria-busy="true"
							/>
						}
					>
						<ChangesPanel
							id={id}
							file={file ?? null}
							onClose={() => setChangesOpen(false)}
						/>
					</Suspense>
				</>
			)}
		</div>
	);
}
export const ChangesSplit = observer(ChangesSplitImpl);

/** The session header's toggle, with the number of changed files. */
function ChangesToggleImpl({ id }: { id: string }) {
	const peek = useChangesPeek(id).data;
	const open = changesOpen.value;
	const n = peek?.available ? peek.total : 0;
	return (
		<button
			type="button"
			className={`d-btn sm cv-toggle${open ? " on" : ""}`}
			aria-pressed={open}
			aria-keyshortcuts="Meta+Backslash Control+Backslash"
			title={`${open ? "Hide" : "Show"} changes (${SHORTCUT_LABEL})`}
			onClick={toggleChanges}
		>
			<FileDiffIcon aria-hidden="true" />
			Changes
			{n > 0 && (
				<>
					<span className="cv-badge" aria-hidden="true">
						{n}
					</span>
					<span className="cv-sr">
						, {n} changed {n === 1 ? "file" : "files"}
					</span>
				</>
			)}
		</button>
	);
}
export const ChangesToggle = observer(ChangesToggleImpl);
