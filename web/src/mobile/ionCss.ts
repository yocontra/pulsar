/**
 * Ionic component styles for this device's mode only (astro.config.mjs,
 * ionicModeStyles). A component reads its styles once, when its first
 * instance connects, so they must be in by then:
 * - the eager registry loads with the phone's chunk (components/App.tsx);
 * - the lazy one (the components in ionic-lazy.tsx) loads with every chunk
 *   that can render them: `withLazyIonCss` wraps those chunks' loaders
 *   (pages, overlays, status screens, loadIonicLazy).
 * A component that connects before its styles arrived logs an error, which
 * fails the e2e run (e2e/fixtures.ts).
 */
import { mode } from "./platform.ts";

type Registry = { default: Record<string, string> };
type IonCssGlobal = {
	__pulsarIonCss?: Record<string, string>;
	__pulsarIonMiss?: (key: string) => string;
};

const g = globalThis as IonCssGlobal;
g.__pulsarIonMiss = (key) => {
	console.error(`Ionic styles for ${key} were read before they loaded`);
	return "";
};

const add = (m: Registry) => {
	g.__pulsarIonCss = Object.assign(g.__pulsarIonCss ?? {}, m.default);
};

let eager: Promise<void> | null = null;
let lazy: Promise<void> | null = null;

export function loadEagerIonCss(): Promise<void> {
	eager ??= (
		mode === "md"
			? import("virtual:ionic-css/md-eager")
			: import("virtual:ionic-css/ios-eager")
	).then(add, (err: unknown) => {
		eager = null;
		throw err;
	});
	return eager;
}

export function loadLazyIonCss(): Promise<void> {
	lazy ??= (
		mode === "md"
			? import("virtual:ionic-css/md-lazy")
			: import("virtual:ionic-css/ios-lazy")
	).then(add, (err: unknown) => {
		lazy = null;
		throw err;
	});
	return lazy;
}

/** A chunk loader that also brings in the lazy Ionic components' styles. */
export const withLazyIonCss =
	<T>(load: () => Promise<T>) =>
	(): Promise<T> =>
		Promise.all([load(), loadLazyIonCss()]).then(([m]) => m);
