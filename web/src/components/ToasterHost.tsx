import "sonner/dist/styles.css";
import "../styles/toasts.css";
import { useEffect } from "react";
import { Toaster, toast } from "sonner";
import { toasterReady } from "../lib/toast.ts";

/** Sonner's toaster, styled from our tokens (styles/toasts.css). */
export default function ToasterHost({ mobile }: { mobile: boolean }) {
	// Runs after the Toaster's own effect has subscribed, so no toast is lost.
	useEffect(() => toasterReady(toast), []);
	return (
		<Toaster
			className="p-toaster"
			position={mobile ? "bottom-center" : "bottom-right"}
			// Colors come from our tokens, which follow the theme themselves.
			theme="light"
			mobileOffset={{ bottom: 88 }}
			toastOptions={{ className: "p-toast-card" }}
			containerAriaLabel="Notifications"
		/>
	);
}
