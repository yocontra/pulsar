/**
 * "Prove Human" in the app's navigation: the desktop sidebar item (the
 * phone's Settings row is ProvePhoneRow.tsx). It shows whether this device
 * is proven; a tap opens the sheet.
 */
import { ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { observer } from "../lib/signals.ts";
import { hello } from "../lib/store.ts";
import { proveHuman, proven } from "./state.ts";

/** "Proven as Ada · until 6:40 PM", or "Not proven". */
export function proveStatus(): { ok: boolean; text: string } {
	const h = hello.value;
	const session = h?.session;
	const name = h?.you?.name ?? h?.you?.login ?? "you";
	if (!proven.value && !session) return { ok: false, text: "Not proven" };
	const until = session
		? ` · until ${new Date(session.expiresAt).toLocaleTimeString([], {
				hour: "numeric",
				minute: "2-digit",
			})}`
		: "";
	return { ok: true, text: `Proven as ${name} · this device${until}` };
}

function DesktopItemImpl() {
	const s = proveStatus();
	return (
		<button
			type="button"
			className={`d-btn ghost sm prove-nav${s.ok ? " ok" : ""}`}
			title={s.text}
			aria-label={`Prove Human: ${s.text}`}
			onClick={() => void proveHuman("manual")}
		>
			{/* The state is the shield (and the label): no "Proven" text. */}
			{s.ok ? (
				<ShieldCheckIcon aria-hidden="true" />
			) : (
				<ShieldAlertIcon aria-hidden="true" />
			)}
			Prove Human
		</button>
	);
}
export const ProveNavItem = observer(DesktopItemImpl);
