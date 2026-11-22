import type { ComponentType, JSX } from "react";
import { useEffect, useState } from "react";
import { CloseX } from "../components/CloseX.tsx";

/**
 * Code-split a component (React.lazy without a Suspense boundary). A chunk
 * that fails to load shows a Retry (a full reload: browsers may cache a
 * failed dynamic import); the boot guard (public/boot.js) also sees the
 * failure and reloads once on its own.
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
		useEffect(() => {
			if (C) return;
			let live = true;
			preload().then(
				() => live && set((n) => n + 1),
				(err: unknown) => live && setError(err ?? "failed"),
			);
			return () => {
				live = false;
			};
		}, []);
		if (C) return <C {...props} />;
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
	if (closed) return <span hidden />;
	const message = error instanceof Error ? error.message : String(error ?? "");
	// The phone speaks iOS: title-case buttons.
	const phone = matchMedia("(max-width: 1023px)").matches;
	return (
		<div className={layer ? "st st-fail is-layer" : "st st-fail"} role="alert">
			<span className="st-mark is-error" aria-hidden="true">
				<img src="/icon.svg" alt="" width={44} height={44} />
			</span>
			<p className="st-title">This screen didn't load</p>
			<p className="st-text">Check your connection, then retry.</p>
			<button
				type="button"
				className="st-btn"
				onClick={() => location.reload()}
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
			{message && (
				<details className="st-more">
					<summary>{phone ? "Error Details" : "Error details"}</summary>
					<p className="st-code">{message}</p>
				</details>
			)}
		</div>
	);
}
