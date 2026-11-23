import { XIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { inFlight } from "../lib/inflight.ts";
import { observer } from "../lib/signals.ts";

/**
 * The one close affordance every dialog, sheet and viewer uses: an X in the
 * top-right corner (`.close-x`), 32 px with a 44 px hit area, a focus ring,
 * and the accessible name "Close". It is disabled while an action is in
 * flight (a passkey ceremony, a send). `tone="media"` is the light-on-dark
 * X of the image and PDF viewers. Pass it through Radix `Dialog.Close
 * asChild` or give it an onClick.
 */
function CloseXImpl({
	tone,
	className = "",
	disabled,
	...rest
}: ComponentProps<"button"> & { tone?: "media" }) {
	return (
		<button
			type="button"
			aria-label="Close"
			title="Close"
			{...rest}
			disabled={disabled || inFlight.value > 0}
			className={`close-x${tone ? ` is-${tone}` : ""} ${className}`.trim()}
		>
			<XIcon aria-hidden="true" strokeWidth={2.4} />
		</button>
	);
}

export const CloseX = observer(CloseXImpl);
