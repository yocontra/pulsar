/**
 * The desktop session's body: the conversation, and the changes panel
 * beside it when open (lazy: its code loads on first open). The panel is
 * resizable from its left edge (drag, arrow keys, double-click to reset);
 * ⌘\ toggles it. Open state and width persist per device.
 */
import { FileDiffIcon } from "lucide-react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { observer } from "../lib/signals.ts";
import { canOpenChanges, canShowChanges, useChangesPeek } from "./data.ts";
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

export function useChangesPanel(id: string, force: boolean) {
	const peek = useChangesPeek(id).data;
	const available = canOpenChanges(peek);
	const normal = canShowChanges(peek) || force;
	const [manual, setManual] = useState<string | null>(null);
	const open = (normal && changesOpen.value) || (available && manual === id);
	useEffect(() => setManual(null), [id]);
	useEffect(() => {
		if (force) setChangesOpen(true, false);
	}, [force]);
	const setOpen = useCallback(
		(next: boolean) => {
			setManual(!normal && next ? id : null);
			if (normal) setChangesOpen(next);
		},
		[id, normal],
	);
	return { available, open, count: peek?.available ? peek.total : 0, setOpen };
}

function ChangesSplitImpl({
	id,
	open,
	canToggle,
	setOpen,
	file,
	children,
}: {
	id: string;
	open: boolean;
	canToggle: boolean;
	setOpen: (open: boolean) => void;
	/** The file the route names. */
	file?: string | null;
	children: React.ReactNode;
}) {
	useEffect(() => {
		if (!canToggle) return;
		const onKey = (e: KeyboardEvent) => {
			if (!isToggleKey(e)) return;
			e.preventDefault();
			setOpen(!open);
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [canToggle, open, setOpen]);
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
							onClose={() => setOpen(false)}
						/>
					</Suspense>
				</>
			)}
		</div>
	);
}
export const ChangesSplit = observer(ChangesSplitImpl);

/** The session header's toggle, with the number of changed files. */
export function ChangesToggle({
	open,
	count: n,
	setOpen,
}: {
	open: boolean;
	count: number;
	setOpen: (open: boolean) => void;
}) {
	return (
		<button
			type="button"
			className={`d-btn sm cv-toggle${open ? " on" : ""}`}
			aria-pressed={open}
			aria-keyshortcuts="Meta+Backslash Control+Backslash"
			title={`${open ? "Hide" : "Show"} changes (${SHORTCUT_LABEL})`}
			onClick={() => setOpen(!open)}
		>
			<FileDiffIcon aria-hidden="true" />
			<span className="d-btn-label">Changes</span>
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
