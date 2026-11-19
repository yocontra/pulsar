import { useRef } from "react";

/**
 * Long-press (and right-click) handlers for a row: fires after 450 ms
 * without moving, then eats the click that the lift would send.
 */
export function useLongPress(fire: () => void) {
	const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const at = useRef<{ x: number; y: number } | null>(null);
	const fired = useRef(false);
	const cancel = () => {
		clearTimeout(t.current);
		at.current = null;
	};
	return {
		onTouchStart(e: React.TouchEvent) {
			const p = e.touches[0];
			if (!p) return;
			fired.current = false;
			at.current = { x: p.clientX, y: p.clientY };
			clearTimeout(t.current);
			t.current = setTimeout(() => {
				fired.current = true;
				at.current = null;
				fire();
			}, 450);
		},
		onTouchMove(e: React.TouchEvent) {
			const p = e.touches[0];
			const a = at.current;
			if (!p || !a) return;
			if (Math.abs(p.clientX - a.x) > 10 || Math.abs(p.clientY - a.y) > 10)
				cancel();
		},
		onTouchEnd: cancel,
		onTouchCancel: cancel,
		onContextMenu(e: React.MouseEvent) {
			e.preventDefault();
			cancel();
			fire();
		},
		onClickCapture(e: React.MouseEvent) {
			if (fired.current) {
				fired.current = false;
				e.preventDefault();
				e.stopPropagation();
			}
		},
	};
}
