import { useRef } from "react";
import {
	clampSide,
	resetSideWidth,
	SIDE_MIN,
	SIDE_STEP,
	setSideWidth,
	sideMax,
	sideWidth,
} from "../../lib/sidebar.ts";
import { observer } from "../../lib/signals.ts";

/** The width a key moves the handle to, or null for any other key. */
function keyWidth(key: string, w: number): number | null {
	switch (key) {
		case "ArrowLeft":
			return w - SIDE_STEP;
		case "ArrowRight":
			return w + SIDE_STEP;
		case "Home":
			return SIDE_MIN;
		case "End":
			return sideMax();
		default:
			return null;
	}
}

/**
 * The sidebar's resize handle on its right edge: drag it, use the arrow keys
 * (±16 px) or Home / End (narrowest / widest), double-click to reset. The
 * width persists per device (lib/sidebar.ts).
 */
function SideResizerImpl() {
	const drag = useRef<{ x: number; w: number; frame: number; next: number }>(
		null,
	);
	const w = sideWidth.value;
	const end = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d) return;
		cancelAnimationFrame(d.frame);
		drag.current = null;
		document.documentElement.classList.remove("d-resizing");
		if (e.currentTarget.hasPointerCapture(e.pointerId))
			e.currentTarget.releasePointerCapture(e.pointerId);
		setSideWidth(d.next);
	};
	return (
		<div
			className="d-side-resizer"
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize sidebar"
			aria-valuemin={SIDE_MIN}
			aria-valuemax={sideMax()}
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
				d.next = clampSide(d.w + e.clientX - d.x);
				cancelAnimationFrame(d.frame);
				d.frame = requestAnimationFrame(() => setSideWidth(d.next, false));
			}}
			onPointerUp={end}
			onPointerCancel={end}
			onDoubleClick={resetSideWidth}
			onKeyDown={(e) => {
				const next = keyWidth(e.key, w);
				if (next === null) return;
				e.preventDefault();
				setSideWidth(next);
			}}
		/>
	);
}

export const SideResizer = observer(SideResizerImpl);
