/**
 * Pulsar on a phone: Ionic React for structure (navigation, pages, sheets)
 * and Konsta UI inside, in iOS mode, or Material on Android
 * (mobile/platform.ts). Loaded instead of the desktop layout below 1024 px
 * (components/App.tsx).
 */
import "./ionic.css";
import "../styles/ionic-theme.css";
import "./theme.css";
import "./ui/konsta.css";
import "./ui/ui.css";
import { defineCustomElement as defineRippleEffect } from "@ionic/core/components/ion-ripple-effect.js";
import { KonstaProvider } from "konsta/react";
import { useEffect } from "react";
import { Toasts } from "../components/Toasts.tsx";
import { lazy } from "../lib/lazy.tsx";
import { seatHome } from "../lib/router.ts";
import { effect, observer } from "../lib/signals.ts";
import { failure, hello, toast } from "../lib/store.ts";
import { toast as showToast } from "../lib/toast.ts";
import { withLazyIonCss } from "./ionCss.ts";
import { IonApp, setupIonicReact } from "./ionic.ts";
import { prefetchIonicLazy } from "./lazyIonic.ts";
import { preloadPages } from "./pages.tsx";
import { mode } from "./platform.ts";
import { PhoneNav } from "./stack.tsx";
import { ActionsHost } from "./ui/ActionsHost.tsx";
import { TabBar } from "./ui/TabBar.tsx";

setupIonicReact({
	mode,
	swipeBackEnabled: true,
	hardwareBackButton: false,
});
// Ionic's tap effect calls addRipple on any ion-ripple-effect it finds
// (IonItem and IonButton render one in Material mode), but nothing on the
// first screen defines the element until the lazy Ionic module does: a tap
// before then threw. Its class is in the first route's chunk already.
defineRippleEffect();
document.documentElement.dataset.platform = "phone";
// Opened on a page: Home gets a real history entry under it (Android back).
seatHome();
document.documentElement.classList.add(mode === "md" ? "k-material" : "k-ios");

// Ionic's global styles don't belong on the desktop layout: a window that
// grows past the phone breakpoint reloads into it.
const desktop = matchMedia("(min-width: 1024px)");
desktop.addEventListener("change", () => {
	if (desktop.matches) location.reload();
});

const Overlays = lazy<object>(
	withLazyIonCss(() => import("./Overlays.tsx")),
	() => <></>,
	{ layer: true },
);
const Screens = lazy<{ kind: "failure" | "first-run" }>(
	withLazyIonCss(() => import("./StatusScreens.tsx")),
);

/** The store's one-line status toasts, on the one toaster (sonner). */
function useToasts() {
	useEffect(
		() =>
			effect(() => {
				const t = toast.value;
				if (!t) return;
				void showToast(t.text, {
					...(t.tone === "warn" ? { tone: "warning" as const } : {}),
					duration: 3000,
					id: "status",
				});
			}),
		[],
	);
}

function PhoneAppImpl() {
	useToasts();
	useEffect(() => {
		const t = setTimeout(() => {
			prefetchIonicLazy();
			preloadPages();
		}, 200);
		return () => clearTimeout(t);
	}, []);
	const f = failure.value;
	const h = hello.value;
	const body = f ? (
		<Screens kind="failure" />
	) : h && (h.firstRun || h.agents === 0) ? (
		<Screens kind="first-run" />
	) : (
		<>
			<PhoneNav />
			<TabBar />
			<Overlays />
			<ActionsHost />
			<Toasts mobile />
		</>
	);
	// Konsta follows the Ionic mode; its `dark:` classes are always on and
	// apply through Pulsar's dark variant (styles/globals.css, data-theme).
	return (
		<KonstaProvider theme={mode === "md" ? "material" : "ios"} dark>
			<IonApp>{body}</IonApp>
		</KonstaProvider>
	);
}

export default observer(PhoneAppImpl);
