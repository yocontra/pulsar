import { createPortal } from "react-dom";
import { lazy } from "../lib/lazy.tsx";
import { observer } from "../lib/signals.ts";
import { toasterWanted } from "../lib/toast.ts";

// Sonner and its stylesheet load with the first toast, not on first paint.
const ToasterHost = lazy<{ mobile: boolean }>(
	() => import("./ToasterHost.tsx"),
	() => <></>,
	{ layer: true },
);

/** The one toaster (src/lib/toast.ts), mounted by both layouts. */
function ToastsImpl({ mobile }: { mobile: boolean }) {
	if (!toasterWanted.value) return null;
	// Sonner's live region wraps its fixed lists in a normal-flow section.
	return createPortal(
		<div className="p-toast-overlay">
			<ToasterHost mobile={mobile} />
		</div>,
		document.body,
	);
}

export const Toasts = observer(ToastsImpl);
