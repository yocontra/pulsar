import { observer } from "../lib/signals.ts";
import { failure, hello, streamState, toast } from "../lib/store.ts";
import {
	FailureScreen,
	FirstRun,
	Help,
	Palette,
	QrModal,
	SettingsModal,
	showHelp,
	showPalette,
	showQr,
	showSettings,
} from "./chrome.tsx";
import Desktop from "./DesktopLayout.tsx";
import { ShellSkeleton } from "./desktop/ShellSkeleton.tsx";

/** The desktop app: its layout plus loading, failure, first run and modals. */
function DesktopAppImpl() {
	const f = failure.value;
	const h = hello.value;
	if (f) return <FailureScreen kind={f.kind} detail={f.detail} />;
	// A skeleton of the shell (same boxes as the loaded layout) until hello.
	if (!h) return <ShellSkeleton />;
	if (h.firstRun || h.agents === 0)
		return (
			<>
				<FirstRun onQr={() => (showQr.value = true)} />
				{showQr.value && <QrModal onClose={() => (showQr.value = false)} />}
			</>
		);
	return (
		<>
			<Desktop />
			{streamState.value === "retrying" ? (
				<div className="toast" role="status">
					Reconnecting…
				</div>
			) : (
				toast.value && (
					<div className={`toast t-${toast.value.tone}`} role="status">
						{toast.value.text}
					</div>
				)
			)}
			{showQr.value && <QrModal onClose={() => (showQr.value = false)} />}
			{showHelp.value && <Help onClose={() => (showHelp.value = false)} />}
			{showSettings.value && (
				<SettingsModal onClose={() => (showSettings.value = false)} />
			)}
			{showPalette.value && (
				<Palette onClose={() => (showPalette.value = false)} />
			)}
		</>
	);
}

export default observer(DesktopAppImpl);
