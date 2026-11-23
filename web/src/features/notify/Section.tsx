/**
 * Settings → "Agent activity": when an agent you started, messaged or opened
 * finishes its turn or stops with an error. One select and one switch, on
 * desktop (rows in the settings card); the phone's rows are PhoneSection.tsx.
 */
import { useEffect, useState } from "react";
import { ProveCancelled } from "../../api/client.ts";
import { observer } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";
import { enablePush, pushState } from "../../settings/push.ts";
import {
	inApp,
	MODES,
	type Mode,
	previews,
	refresh,
	shownMode,
	subscribed,
	update,
	wantsNotifications,
} from "./prefs.ts";
import "./notify.css";

export const HELP =
	"For agents you started, messaged or opened in the last 6 hours. A notification names the agent and says what it did.";
export const DENIED =
	"Allow notifications in your browser or system settings to get these. Sound only still works.";
export const PREVIEWS_HELP =
	"Agent names, commands and messages in notifications. Off: notifications say only what kind of thing happened.";
export const IN_APP_HELP =
	"A short note in the corner when an agent finishes while Pulsar is open on another screen.";

/** Settings state shared by both layouts. */
export function useAgentActivity() {
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		refresh().catch(() => {});
	}, []);
	const choose = async (m: Mode) => {
		setError(null);
		setBusy(true);
		try {
			if (wantsNotifications(m) && !subscribed.value) {
				// Notifications need this browser subscribed (Prove Human opens here).
				const state = can("push") ? await pushState() : "unsupported";
				const now = state === "off" ? await enablePush() : state;
				if (now !== "on") {
					setError(
						now === "needs-install"
							? "On iPhone and iPad, add Pulsar to the Home Screen and open it from there to get notifications. Sound only still works."
							: now === "unsupported"
								? "This browser can't show notifications. Sound only still works."
								: DENIED,
					);
					return;
				}
				await refresh();
			}
			await update({ mode: m });
		} catch (e) {
			setError(
				e instanceof ProveCancelled
					? "Not proven, so notifications didn't change."
					: "Could not save. Try again.",
			);
		} finally {
			setBusy(false);
		}
	};
	const toggleInApp = async (v: boolean) => {
		setError(null);
		try {
			await update({ inApp: v });
		} catch {
			setError("Could not save. Try again.");
		}
	};
	const togglePreviews = async (v: boolean) => {
		setError(null);
		try {
			await update({ previews: v });
		} catch {
			setError("Could not save. Try again.");
		}
	};
	return { error, busy, choose, toggleInApp, togglePreviews };
}

function DesktopImpl() {
	const { error, busy, choose, toggleInApp, togglePreviews } =
		useAgentActivity();
	return (
		<ul className="d-card d-set-card" data-section="agent-activity">
			<li className="d-set-row">
				<span className="d-set-text">
					<span className="d-set-label">When an agent finishes or fails</span>
					<span
						className={error ? "d-set-help d-notify-error" : "d-set-help"}
						role={error ? "alert" : undefined}
					>
						{error ?? HELP}
					</span>
				</span>
				<select
					className="d-notify-select"
					aria-label="When an agent finishes or fails"
					value={shownMode()}
					disabled={busy}
					onChange={(e) => void choose(e.currentTarget.value as Mode)}
				>
					{MODES.map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</li>
			<li className="d-set-row">
				<span className="d-set-text">
					<span className="d-set-label">In-app notifications</span>
					<span className="d-set-help">{IN_APP_HELP}</span>
				</span>
				<input
					type="checkbox"
					role="switch"
					className="d-switch"
					aria-label="In-app notifications"
					aria-checked={inApp.value}
					checked={inApp.value}
					onChange={(e) => void toggleInApp(e.currentTarget.checked)}
				/>
			</li>
			{subscribed.value && (
				<li className="d-set-row">
					<span className="d-set-text">
						<span className="d-set-label">
							Show previews on the lock screen
						</span>
						<span className="d-set-help">{PREVIEWS_HELP}</span>
					</span>
					<input
						type="checkbox"
						role="switch"
						className="d-switch"
						aria-label="Show previews on the lock screen"
						aria-checked={previews.value}
						checked={previews.value}
						onChange={(e) => void togglePreviews(e.currentTarget.checked)}
					/>
				</li>
			)}
		</ul>
	);
}

export const DesktopSection = observer(DesktopImpl);
