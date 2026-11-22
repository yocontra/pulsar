import { Dialog } from "radix-ui";
import { createContext, type ReactNode, useContext } from "react";
import { inFlight } from "../../lib/inflight.ts";
import { CloseX } from "../CloseX.tsx";

/** How many layers this one opens over (a confirm inside the builder: 1). */
const Depth = createContext(0);

/**
 * A desktop modal layer on Radix Dialog: focus trap, Esc, outside click,
 * focus return, and a titled `role=dialog` (or `alertdialog`). Every
 * desktop dialog (palette, settings, help, QR, builder, approval, confirms)
 * uses it so they share one look and one motion, and one close affordance:
 * the X in the top-right corner, Esc and a click on the backdrop. None of
 * them close while an action is in flight (`dismissable` false, or
 * `inFlight` above zero).
 */
export function Layer({
	title,
	hideTitle = false,
	description,
	onClose,
	children,
	className = "",
	placement = "center",
	role,
	dismissable = true,
	initialFocus,
	onEscape,
}: {
	/** The accessible name; shown as the heading unless `hideTitle`. */
	title: string;
	hideTitle?: boolean;
	description?: string;
	onClose: () => void;
	children: ReactNode;
	className?: string;
	/** "top": a palette-style layer near the top of the window. */
	placement?: "center" | "top";
	role?: "dialog" | "alertdialog";
	/** false: the X, Esc and outside clicks don't close (a send in flight). */
	dismissable?: boolean;
	/** Return false to keep Radix from focusing the first control. */
	initialFocus?: (e: Event) => void;
	/** Escape: return true when it closed something inside (a panel), not the layer. */
	onEscape?: () => boolean;
}) {
	const canClose = () => dismissable && inFlight.peek() === 0;
	// A layer opened from inside another stacks above it, scrim included
	// (every layer shares z-index 50/51 otherwise: the inner scrim would
	// fall behind the outer layer).
	const depth = useContext(Depth);
	const z = depth
		? { overlay: { zIndex: 50 + depth * 2 }, pop: { zIndex: 51 + depth * 2 } }
		: null;
	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open && canClose()) onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="d-overlay" style={z?.overlay} />
				<Dialog.Content
					className={`d-layer d-pop d-pop-${placement} ${className}`}
					style={z?.pop}
					// Radix sets role="dialog"; pass a role only to override it.
					{...(role ? { role } : {})}
					onOpenAutoFocus={
						initialFocus ??
						((e) => {
							// Focus the layer itself, not its first button: no stray
							// focus ring, and Tab still enters the controls.
							e.preventDefault();
							(e.currentTarget as HTMLElement | null)?.focus();
						})
					}
					onEscapeKeyDown={(e) => {
						if (onEscape?.() || !canClose()) e.preventDefault();
					}}
					onPointerDownOutside={(e) => {
						if (!canClose()) e.preventDefault();
					}}
				>
					<Dialog.Title className={hideTitle ? "sr-only" : "d-pop-title"}>
						{title}
					</Dialog.Title>
					{description ? (
						<Dialog.Description className="d-pop-desc">
							{description}
						</Dialog.Description>
					) : (
						<Dialog.Description className="sr-only">{title}</Dialog.Description>
					)}
					<Depth.Provider value={depth + 1}>{children}</Depth.Provider>
					{/* Last, so the dialog's own first control keeps first focus. */}
					<Dialog.Close asChild>
						<CloseX disabled={!dismissable} />
					</Dialog.Close>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
