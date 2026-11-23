import { useEffect, useState } from "react";
import { recoverChunk } from "../lib/lazy.tsx";
import { reportLoad } from "../lib/load-report.ts";
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

/**
 * The lazy Ionic module is in. It holds IonNav's page transitions (see
 * ionic-lazy.tsx): until then a page change doesn't animate, so a failed
 * transition download can't leave IonNav half-way.
 */
export const ionicLazyLoaded = () => mod !== null;

/** The lazy Ionic module, or null before it has loaded. */
export const ionicLazy = () => mod;

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
			(err: unknown) => {
				void reportLoad("ionic", err);
				if (live) void recoverChunk(err);
			},
		);
		return () => {
			live = false;
		};
	}, []);
	return m;
}
