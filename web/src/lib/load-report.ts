/**
 * App load error reports (web/public/boot.js sends them to the daemon,
 * `POST /api/v1/client-errors`): what failed to load, for `pulsar doctor`
 * and the failure screens' "Copy details".
 */

export type LoadErrorKind =
	| "boot"
	| "chunk"
	| "ionic"
	| "module"
	| "sw-register"
	| "sw-install"
	| "sw-activate";

/** The report as boot.js made it (src/diagnostics/client-errors.ts). */
export interface LoadReport {
	kind: LoadErrorKind;
	build: string;
	urls: string[];
	error: { name: string; message: string };
	sw?: { controller: string | null; state: string; failed: string[] };
}

declare global {
	interface Window {
		/** public/boot.js: report a load error (deduped, rate limited); settles when sent. */
		__pulsarReport?: (
			kind: LoadErrorKind,
			err: unknown,
			urls?: string[],
		) => Promise<unknown>;
		/** public/boot.js: the last report sent. */
		__pulsarLastLoadError?: LoadReport;
		/** public/boot.js: "CHUNK-TypeError · UsageView.x.js". */
		__pulsarLoadCode?: (r: LoadReport) => string;
		/** public/boot.js: the last report as text to paste. */
		__pulsarLoadDetails?: () => string;
	}
}

/** Report a load error to the daemon; settles when sent (never rejects). */
export function reportLoad(
	kind: LoadErrorKind,
	err: unknown,
	urls?: string[],
): Promise<unknown> {
	try {
		return window.__pulsarReport?.(kind, err, urls) ?? Promise.resolve();
	} catch {
		return Promise.resolve();
	}
}

/** The last report's short code and its text to paste, or null. */
export function lastLoadReport(): { code: string; details: string } | null {
	try {
		const r = window.__pulsarLastLoadError;
		if (!r) return null;
		return {
			code: window.__pulsarLoadCode?.(r) ?? r.kind,
			details: window.__pulsarLoadDetails?.() ?? JSON.stringify(r),
		};
	} catch {
		return null;
	}
}
