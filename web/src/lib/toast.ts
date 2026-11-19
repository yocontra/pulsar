/**
 * Toasts with an optional action (Undo, Open agent, Retry), for desktop and
 * phone alike: `toast("Committed 3 files", { tone: "success", action })`.
 *
 * Not the store's `toast` signal (src/lib/store.ts), which keeps the older
 * one-line status toasts. This one renders through Sonner, loaded on the
 * first call (components/Toasts.tsx mounts the toaster; the library and its
 * stylesheet stay out of the first load). CSP-safe: no injected <style>
 * (astro.config.mjs), styled from our tokens (styles/toasts.css).
 */
import type { ReactNode } from "react";
import type { toast as SonnerToast } from "sonner";
import { signal } from "./signals.ts";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastAction {
	/** Short, sentence case: "Undo", "Open agent", "Retry". */
	label: string;
	onClick: () => void;
}

export interface ToastOptions {
	/** A second line under the message. */
	description?: string;
	tone?: ToastTone;
	/** One button on the toast; clicking it also closes the toast. */
	action?: ToastAction;
	/** ms; Infinity keeps it until dismissed. Default 4000. */
	duration?: number;
	/** Reuse an id to update a toast in place (progress, then a result). */
	id?: string;
	/** A leading icon in place of the tone's own (size-4). */
	icon?: ReactNode;
}

export type ToastId = string | number;

type Sonner = typeof SonnerToast;

/** True once something asked for a toast: the toaster mounts (components/Toasts.tsx). */
export const toasterWanted = signal(false);

let resolveSonner!: (s: Sonner) => void;
const sonner = new Promise<Sonner>((r) => {
	resolveSonner = r;
});

/** Called by the toaster once it is mounted. */
export function toasterReady(s: Sonner) {
	resolveSonner(s);
}

/** Shows a toast; resolves to its id (for `dismissToast` or an update). */
export async function toast(
	message: string,
	opts: ToastOptions = {},
): Promise<ToastId> {
	toasterWanted.value = true;
	const t = await sonner;
	const o = {
		...(opts.description ? { description: opts.description } : {}),
		...(opts.duration !== undefined ? { duration: opts.duration } : {}),
		...(opts.id !== undefined ? { id: opts.id } : {}),
		...(opts.icon !== undefined ? { icon: opts.icon } : {}),
		...(opts.action
			? {
					action: {
						label: opts.action.label,
						onClick: () => opts.action?.onClick(),
					},
				}
			: {}),
	};
	switch (opts.tone) {
		case "success":
			return t.success(message, o);
		case "warning":
			return t.warning(message, o);
		case "error":
			return t.error(message, o);
		case "info":
			return t.info(message, o);
		default:
			return t(message, o);
	}
}

/** A toast with an Undo button: `undoToast("Archived", () => restore())`. */
export function undoToast(
	message: string,
	onUndo: () => void,
	opts: Omit<ToastOptions, "action"> = {},
): Promise<ToastId> {
	return toast(message, {
		...opts,
		action: { label: "Undo", onClick: onUndo },
	});
}

/** Closes one toast, or all of them. */
export async function dismissToast(id?: ToastId) {
	if (!toasterWanted.value) return;
	(await sonner).dismiss(id);
}
