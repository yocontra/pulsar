/**
 * Pulsar on a phone: Ionic React in iOS mode. Loaded instead of the desktop
 * layout below 1024 px (components/App.tsx).
 */
import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "../styles/ionic-theme.css";
import "./theme.css";
import { useEffect } from "react";
import { Toasts } from "../components/Toasts.tsx";
import { lazy } from "../lib/lazy.tsx";
import { effect, observer } from "../lib/signals.ts";
import { failure, hello, toast } from "../lib/store.ts";
import { IonApp, setupIonicReact } from "./ionic.ts";
import { loadIonicLazy, prefetchIonicLazy } from "./lazyIonic.ts";
import { preloadPages } from "./pages.tsx";
import { PhoneNav } from "./stack.tsx";

setupIonicReact({
	mode: "ios",
	swipeBackEnabled: true,
	hardwareBackButton: false,
});
document.documentElement.dataset.platform = "phone";

// Ionic's global styles don't belong on the desktop layout: a window that
// grows past the phone breakpoint reloads into it.
const desktop = matchMedia("(min-width: 1024px)");
desktop.addEventListener("change", () => {
	if (desktop.matches) location.reload();
});

const Overlays = lazy<object>(
	() => import("./Overlays.tsx"),
	() => <></>,
	{ layer: true },
);
const Screens = lazy<{ kind: "failure" | "first-run" }>(
	() => import("./StatusScreens.tsx"),
);

/** Store toasts as Ionic toasts. */
function useToasts() {
	useEffect(
		() =>
			effect(() => {
				const t = toast.value;
				if (!t) return;
				void loadIonicLazy().then(async ({ toastController }) => {
					await toastController.dismiss().catch(() => {});
					const el = await toastController.create({
						message: t.text,
						duration: 3000,
						position: "bottom",
						cssClass: `p-toast is-${t.tone}`,
					});
					await el.present();
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
	if (f)
		return (
			<IonApp>
				<Screens kind="failure" />
			</IonApp>
		);
	if (h && (h.firstRun || h.agents === 0))
		return (
			<IonApp>
				<Screens kind="first-run" />
			</IonApp>
		);
	return (
		<IonApp>
			<PhoneNav />
			<Overlays />
			<Toasts mobile />
		</IonApp>
	);
}

export default observer(PhoneAppImpl);
