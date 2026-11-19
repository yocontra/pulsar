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
	return toasterWanted.value ? <ToasterHost mobile={mobile} /> : null;
}

export const Toasts = observer(ToastsImpl);
