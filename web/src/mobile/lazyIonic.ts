import { useEffect, useState } from "react";
import { recoverChunk } from "../lib/lazy.tsx";
import { prefetch } from "../lib/prefetch.ts";
import { withLazyIonCss } from "./ionCss.ts";

export type LazyIonic = typeof import("./ionic-lazy.tsx");

let mod: LazyIonic | null = null;
let loading: Promise<LazyIonic> | null = null;

/** Load the after-first-paint Ionic components (sheets, swipe actions...). */
export function loadIonicLazy(): Promise<LazyIonic> {
	loading ??= withLazyIonCss(() => import("./ionic-lazy.tsx"))().then(
		(m) => {
			mod = m;
			return m;
		},
		(err: unknown) => {
			// Not cached: the next caller tries the download again.
			loading = null;
			throw err;
		},
	);
	return loading;
}

/** Warm the lazy Ionic module in the background; a failure waits for real use. */
export function prefetchIonicLazy() {
	prefetch([loadIonicLazy]);
}

/** The lazy Ionic module once loaded (null until then). */
export function useIonicLazy(): LazyIonic | null {
	const [m, setM] = useState(mod);
	useEffect(() => {
		if (m) return;
		let live = true;
		loadIonicLazy().then(
			(x) => live && setM(x),
			// Sheets and menus would never open: reload into the served build.
			(err: unknown) => live && recoverChunk(err),
		);
		return () => {
			live = false;
		};
	}, []);
	return m;
}
