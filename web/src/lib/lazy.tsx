import type { ComponentType, JSX } from "react";
import { useEffect, useState } from "react";
import { CloseX } from "../components/CloseX.tsx";
import { lastLoadReport, reportLoad } from "./load-report.ts";
import { offlineCopy, reachable, reloadApp } from "./reach.ts";

declare global {
	interface Window {
		/**
		 * public/boot.js: for a chunk error, true when reloading (once a
		 * minute), "offline" when the daemon is unreachable (it reloads once
		 * the daemon answers).
		 */
		__pulsarRecover?: (reason: unknown) => Promise<Recovery>;
	}
}

type Recovery = boolean | "offline";

/**
 * A chunk that did not download (an older build's file gone after a
 * deploy, a network blip): reload into the build the server runs now, once
 * a minute (public/boot.js). "offline" when the daemon is unreachable (off
 * Tailscale): no reload until it answers; false when nothing is coming.
 */
export async function recoverChunk(err: unknown): Promise<Recovery> {
	try {
		return (await window.__pulsarRecover?.(err)) ?? false;
	} catch {
		return false;
	}
}

/** Shown in place of a chunk that failed because the daemon is unreachable. */
const OFFLINE = new Error();

/**
 * Code-split a component (React.lazy without a Suspense boundary). A chunk
 * that fails to load reloads the app once by itself (recoverChunk); only
 * when that was already spent does the screen show a Retry (a full reload:
 * browsers may cache a failed dynamic import).
 */
export function lazy<P extends object>(
	load: () => Promise<{ default: ComponentType<P> }>,
	/** Shown while the chunk loads (default: a busy placeholder). */
	fallback?: () => JSX.Element,
	/**
	 * A layer (dialog, sheet, menu): a failure shows over the app and can be
	 * closed (the layer's onClose), not in the page's flow.
	 */
	opts?: { layer?: boolean },
): ComponentType<P> & { preload: () => Promise<unknown> } {
	let C: ComponentType<P> | null = null;
	let p: Promise<unknown> | null = null;
	const preload = () => {
		p ??= load().then(
			(m) => {
				C = m.default;
			},
			(err: unknown) => {
				p = null;
				throw err;
			},
		);
		return p;
	};
	function Lazy(props: P): JSX.Element {
		const [error, setError] = useState<unknown>(null);
		const [, set] = useState(0);
		// A preload can finish between this render and the effect. If this
		// render showed the fallback, subscribe even to a settled promise.
		const Loaded = C;
		useEffect(() => {
			if (Loaded) return;
			let live = true;
			preload().then(
				() => live && set((n) => n + 1),
				async (err: unknown) => {
					// Tell the daemon first: a reload waits for the report (or
					// queues it while the daemon is unreachable).
					void reportLoad("chunk", err);
					// A reload is coming: keep the loading state until it does.
					const r = await recoverChunk(err);
					if (live && r !== true)
						setError(r === "offline" ? OFFLINE : (err ?? "failed"));
				},
			);
			return () => {
				live = false;
			};
		}, [Loaded]);
		if (Loaded) return <Loaded {...props} />;
		if (error)
			return (
				<LoadFailed
					error={error}
					layer={opts?.layer}
					onClose={(props as { onClose?: () => void }).onClose}
				/>
			);
		return fallback ? (
			fallback()
		) : (
			<div className="st-wait" role="status" aria-busy="true">
				<span className="st-spin" />
				<span className="st-sr">Loading</span>
			</div>
		);
	}
	Lazy.preload = preload;
	return Lazy;
}

/**
 * A chunk that didn't download: the brand mark, one line, Retry (a full
 * reload), and the error behind a disclosure. Styled by the index
 * stylesheet only (app.css, ios.css): it must render when an app chunk failed.
 */
function LoadFailed({
	error,
	layer,
	onClose,
}: {
	error: unknown;
	layer?: boolean;
	onClose?: () => void;
}) {
	const [closed, setClosed] = useState(false);
	const [report, setReport] = useState(lastLoadReport);
	const [copied, setCopied] = useState(false);
	// The daemon unreachable (off Tailscale): say so, not "didn't load".
	// The app's offline screen shows too when its chunk is at hand
	// (lib/store.ts); public/boot.js reloads once the daemon answers.
	const off = error === OFFLINE;
	useEffect(() => {
		if (off) return;
		let live = true;
		// The same report as the failure's (deduped): its code once sent.
		void reportLoad("chunk", error).then(
			() => live && setReport(lastLoadReport()),
		);
		return () => {
			live = false;
		};
	}, [error, off]);
	if (closed) return <span hidden />;
	const message = error instanceof Error ? error.message : String(error ?? "");
	// The phone speaks iOS: title-case buttons.
	const phone = matchMedia("(max-width: 1023px)").matches;
	const c = off
		? offlineCopy(phone)
		: {
				title: "This screen didn't load",
				body: "Check your connection, then retry.",
			};
	return (
		<div className={layer ? "st st-fail is-layer" : "st st-fail"} role="alert">
			<span className="st-mark is-error" aria-hidden="true">
				<img src="/icon.svg" alt="" width={44} height={44} />
			</span>
			<p className="st-title">{c.title}</p>
			<p className="st-text">{c.body}</p>
			<button
				type="button"
				className="st-btn"
				onClick={async () => {
					if (!off || (await reachable())) reloadApp();
				}}
			>
				{phone ? "Try Again" : "Retry"}
			</button>
			{layer && (
				// The standard X in the corner, like every dialog and sheet.
				<CloseX
					className="st-close"
					onClick={() => (onClose ? onClose() : setClosed(true))}
				/>
			)}
			{report && !off && (
				<>
					<p className="st-note st-load-code">{report.code}</p>
					<button
						type="button"
						className="st-btn is-secondary"
						onClick={() =>
							navigator.clipboard?.writeText(report.details).then(
								() => setCopied(true),
								() => {},
							)
						}
					>
						{copied ? "Copied" : phone ? "Copy Details" : "Copy details"}
					</button>
				</>
			)}
			{message && (
				<details className="st-more">
					<summary>{phone ? "Error Details" : "Error details"}</summary>
					<p className="st-code">{message}</p>
				</details>
			)}
		</div>
	);
}
