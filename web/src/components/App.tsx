import { lazy } from "../lib/lazy.tsx";
import { observer, signal } from "../lib/signals.ts";
import { loadEagerIonCss } from "../mobile/ionCss.ts";
import { proveAsk } from "../prove/state.ts";

// Each device downloads only its app: the desktop layout, or the phone's
// Ionic shell (which handles its own loading, failure and first-run states).
/** The static shell's loading screen (index.astro) while the app chunk loads. */
function BootShell() {
	return (
		<div className="boot-shell st st-boot" aria-busy="true">
			<span className="st-mark is-busy" aria-hidden="true">
				<img src="/icon.svg" alt="" width={64} height={64} />
			</span>
			<p className="st-text boot-text">Loading Pulsar…</p>
		</div>
	);
}
const Desktop = lazy(() => import("./DesktopApp.tsx"), BootShell);
// The phone's Ionic styles for its mode load alongside its chunk.
const Mobile = lazy<object>(
	() =>
		Promise.all([import("../mobile/PhoneApp.tsx"), loadEagerIonCss()]).then(
			([m]) => m,
		),
	BootShell,
);

const mq = matchMedia("(min-width: 1024px)");
const isDesktop = signal(mq.matches);
mq.addEventListener("change", () => {
	isDesktop.value = mq.matches;
});

/** Prove Human (Face ID / Touch ID), over either app; loads when it opens. */
const ProveSheet = lazy<{ mobile: boolean }>(
	() => import("../prove/ProveSheet.tsx"),
	undefined,
	{ layer: true },
);

function AppImpl() {
	return (
		<>
			{isDesktop.value ? <Desktop /> : <Mobile />}
			{proveAsk.value && <ProveSheet mobile={!isDesktop.value} />}
		</>
	);
}

export const App = observer(AppImpl);
