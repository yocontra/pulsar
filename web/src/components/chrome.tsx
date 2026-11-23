import type { FailureKind } from "../api/client.ts";
import { lazy } from "../lib/lazy.tsx";
import { signal } from "../lib/signals.ts";

/** Layers draw nothing while their chunk loads (no stray spinner on top). */
const none = () => <span hidden />;
const LAYER = { layer: true };

export const SessionView = lazy(() => import("../session/SessionView.tsx"));
export const Builder = lazy(
	() => import("../builder/Builder.tsx"),
	none,
	LAYER,
);
export const ApprovalCard = lazy(() => import("../approval/ApprovalCard.tsx"));
export const Palette = lazy(() => import("./Palette.tsx"), none, LAYER);
// The scoped composer pulls in PromptInput; keep it off the first route.
export const ScopeView = lazy<{ id: string; mobile: boolean }>(() =>
	import("./ScopeView.tsx").then((m) => ({ default: m.ScopeView })),
);
export const IdsView = lazy<{ ids: string[]; mobile: boolean }>(() =>
	import("./ScopeView.tsx").then((m) => ({ default: m.IdsView })),
);
// Screens that aren't the tree: failure, first run, needs-you list, help, QR.
export const screens = () => import("./Screens.tsx");
export const FailureScreen = lazy<{ kind: FailureKind; detail?: string }>(() =>
	screens().then((m) => ({ default: m.FailureScreen })),
);
export const FirstRun = lazy<{ onQr: () => void }>(() =>
	screens().then((m) => ({ default: m.FirstRun })),
);
export const NeedsList = lazy<{ mobile: boolean }>(() =>
	screens().then((m) => ({ default: m.NeedsList })),
);
export const Help = lazy<{ onClose: () => void }>(
	() => screens().then((m) => ({ default: m.Help })),
	none,
	LAYER,
);
export const QrModal = lazy<{ onClose: () => void }>(
	() => import("../qr/QrModal.tsx"),
	none,
	LAYER,
);

/** Settings: passkeys and notifications (lazy: WebAuthn/push code stays off the first route). */
export const SettingsModal = lazy<{ onClose: () => void }>(
	() => import("../settings/Settings.tsx"),
	none,
	LAYER,
);

export const showQr = signal(false);
export const showSettings = signal(false);
export const showHelp = signal(false);
export const showPalette = signal(false);
