/**
 * Settings → "Usage limits": warn when a plan usage limit passes one of the
 * thresholds or is reached. Kept on the node (every device on it shares
 * them). Desktop: rows in the settings card; phone: IonItems.
 */
import { BellRingIcon, GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import type { LimitSettings } from "../../api/types.ts";
import { queryClient } from "../../data/hooks.ts";
import { IonItem } from "../../mobile/ionic.ts";
import { IonLabel, IonNote } from "../../mobile/ionic-lazy.tsx";
import { loadIonicLazy, useIonicLazy } from "../../mobile/lazyIonic.ts";
import {
	DEFAULT_SETTINGS,
	limitsKey,
	parseThresholds,
	useLimits,
} from "./model.ts";
import "./limits.css";

export const HELP =
	"A notification when a limit passes a threshold or is reached, once per limit window. Codex reports percentages; Claude Code, pi and omp only report a reached limit.";
const THRESHOLD_HELP = "Up to 3 percents from 1 to 99, like 80, 95.";

const show = (t: number[]) => t.map((n) => `${n}%`).join(", ");

/** The phone's choices (a computer can set any). */
const PRESETS = [[80, 95], [50, 80, 95], [70, 90], [90]];

function useSettings() {
	const q = useLimits();
	const settings = q.data?.settings ?? DEFAULT_SETTINGS;
	const [error, setError] = useState<string | null>(null);
	const save = async (change: Partial<LimitSettings>) => {
		setError(null);
		try {
			const r = await api.setUsageLimits(change);
			queryClient.setQueryData(limitsKey, r);
			return true;
		} catch {
			setError("Could not save. Try again.");
			return false;
		}
	};
	return { settings, loaded: Boolean(q.data), error, setError, save };
}

export function DesktopSection() {
	const { settings, loaded, error, setError, save } = useSettings();
	const [text, setText] = useState(settings.thresholds.join(", "));
	useEffect(() => setText(settings.thresholds.join(", ")), [settings]);
	const commit = () => {
		const t = parseThresholds(text);
		if (!t) {
			setError(THRESHOLD_HELP);
			return;
		}
		if (t.join() !== settings.thresholds.join()) void save({ thresholds: t });
		else setError(null);
	};
	return (
		<ul className="d-card d-set-card" data-section="usage-limits">
			<li className="d-set-row">
				<span className="d-set-text">
					<span className="d-set-label">Usage limit warnings</span>
					<span
						className={error ? "d-set-help limits-error" : "d-set-help"}
						role={error ? "alert" : undefined}
					>
						{error ?? HELP}
					</span>
				</span>
				<input
					type="checkbox"
					role="switch"
					className="d-switch"
					aria-label="Usage limit warnings"
					aria-checked={settings.enabled}
					checked={settings.enabled}
					disabled={!loaded}
					onChange={(e) => void save({ enabled: e.currentTarget.checked })}
				/>
			</li>
			<li className="d-set-row">
				<span className="d-set-text">
					<span className="d-set-label">Warn at</span>
					<span className="d-set-help">{THRESHOLD_HELP}</span>
				</span>
				<input
					className="limits-input"
					aria-label="Warn at these percents"
					inputMode="numeric"
					value={text}
					disabled={!loaded || !settings.enabled}
					title={
						settings.enabled ? undefined : "Turn on usage limit warnings first"
					}
					onChange={(e) => setText(e.currentTarget.value)}
					onBlur={commit}
					onKeyDown={(e) => {
						if (e.key === "Enter") commit();
					}}
				/>
			</li>
		</ul>
	);
}

export function PhoneSection() {
	const lz = useIonicLazy();
	const { settings, loaded, error, save } = useSettings();
	const edit = async () => {
		const { actionSheetController } = await loadIonicLazy();
		const now = settings.thresholds.join();
		const sheet = await actionSheetController.create({
			header: "Warn at",
			subHeader: "Other percents can be set in Settings on a computer.",
			buttons: [
				...PRESETS.map((t) => ({
					text: t.join() === now ? `${show(t)} ✓` : show(t),
					handler: () => void save({ thresholds: t }),
				})),
				{ text: "Cancel", role: "cancel" },
			],
		});
		await sheet.present();
	};
	return (
		<>
			<IonItem lines="none" data-setting="usage-limits">
				<span className="p-set-icon is-red" slot="start" aria-hidden="true">
					<BellRingIcon />
				</span>
				{lz ? (
					<lz.IonToggle
						checked={settings.enabled}
						disabled={!loaded}
						onIonChange={(e) => void save({ enabled: e.detail.checked })}
						aria-label="Usage limit warnings"
					>
						Usage Limit Warnings
					</lz.IonToggle>
				) : (
					<IonLabel>Usage limit warnings</IonLabel>
				)}
			</IonItem>
			<IonItem
				button
				detail
				disabled={!loaded || !settings.enabled}
				onClick={() => void edit()}
				data-setting="usage-limit-thresholds"
			>
				<span className="p-set-icon is-blue" slot="start" aria-hidden="true">
					<GaugeIcon />
				</span>
				<IonLabel>Warn At</IonLabel>
				<IonNote slot="end">{show(settings.thresholds)}</IonNote>
			</IonItem>
			<IonItem lines="none">
				<IonLabel
					className={error ? "p-limits-error" : "p-limits-help"}
					role={error ? "alert" : undefined}
				>
					{error ?? HELP}
				</IonLabel>
			</IonItem>
		</>
	);
}
