/**
 * A sheet over the page: Ionic's IonModal presents it (detents, swipe to
 * dismiss, the iOS card stack), Konsta lays out what is inside. On Android
 * it is a Material bottom sheet with a drag handle. Portaled into ion-app,
 * so it stacks over the page that opened it.
 *
 * Mount it while it may be open: it presents on `open`, and calls
 * `onClosed` once it has animated out (swipe, backdrop, Esc, Done, or
 * `open` turning false). `head={false}` drops the header for a body with
 * its own; `card` presents an iOS card sheet; `canDismiss` holds a swipe
 * while an action runs. `toolbar` pins a row (a search field) under the
 * header; `scrollBody` lets the body scroll at every detent, as an iOS
 * sheet does (the sheet drags from the header, or from the body only at
 * its top); `grabber` shows the drag handle on iOS too.
 */

import { ArrowLeftIcon } from "lucide-react";
import { type ReactNode, type Ref, useEffect } from "react";
import { createPortal } from "react-dom";
import { CloseX } from "../../components/CloseX.tsx";
import { IonContent } from "../ionic.ts";
import { useIonicLazy } from "../lazyIonic.ts";
import { isMaterial } from "../platform.ts";

type CanDismiss =
	| boolean
	| ((data?: unknown, role?: string) => Promise<boolean>);

export function SheetShell({
	open,
	onClose,
	onClosed,
	title,
	label,
	detents = [0, 0.6, 1],
	initial = 0.6,
	head = true,
	card = false,
	canDismiss,
	start,
	onBack,
	end,
	footer,
	toolbar,
	scrollBody = false,
	grabber = false,
	className,
	modalRef,
	testId,
	children,
}: {
	open: boolean;
	/** Asks to close (the X); the sheet animates out, then `onClosed`. */
	onClose: () => void;
	/** After it animated out, however it closed (X, swipe, backdrop, Esc,
	 *  or `open` turning false). */
	onClosed?: () => void;
	title: ReactNode;
	/** The dialog's accessible name (default: the title), when the heading
	 *  changes from view to view in one sheet. */
	label?: string;
	/** Heights as a fraction of the screen (0 lets a swipe dismiss it). */
	detents?: number[];
	initial?: number;
	/** false: no header; the body brings its own (with its close button). */
	head?: boolean;
	/** An iOS card sheet over the page (the page recedes behind it), in
	 *  place of detents. */
	card?: boolean;
	/** IonModal's canDismiss: hold a swipe or backdrop tap while busy. */
	canDismiss?: CanDismiss;
	/** A leading header control. */
	start?: ReactNode;
	/** A Back step inside the sheet: "Back" on iOS, an arrow on Android
	 *  (in place of `start`). */
	onBack?: () => void;
	/** A trailing header control in place of the close button. */
	end?: ReactNode;
	/** Pinned under the scrolling body (a confirm bar). */
	footer?: ReactNode;
	/** Pinned between the header and the scrolling body (a search field). */
	toolbar?: ReactNode;
	/** The body scrolls at every detent (Ionic's expandToScroll off): a
	 *  drag on the body moves the sheet only when the body is at its top. */
	scrollBody?: boolean;
	/** The drag handle on iOS too (Android always shows it). */
	grabber?: boolean;
	/** More classes on the modal. */
	className?: string;
	/** The modal element (to move it to another detent). */
	modalRef?: Ref<HTMLIonModalElement>;
	testId?: string;
	children: ReactNode;
}) {
	const lz = useIonicLazy();
	// Esc closes (a hardware keyboard on a tablet-sized phone layout).
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [open, onClose]);
	if (!lz) return null;
	const present = card
		? {
				presentingElement:
					document.querySelector<HTMLElement>("ion-nav") ?? undefined,
			}
		: {
				breakpoints: detents,
				initialBreakpoint: initial,
				handle: isMaterial || grabber,
				...(scrollBody ? { expandToScroll: false } : {}),
			};
	const back = onBack && (
		<button
			type="button"
			className={isMaterial ? "p-sheet-back is-arrow" : "p-sheet-back"}
			aria-label="Back"
			onClick={onBack}
		>
			{isMaterial ? <ArrowLeftIcon aria-hidden="true" /> : "Back"}
		</button>
	);
	return createPortal(
		<lz.IonModal
			ref={modalRef}
			className={className ? `p-sheet ${className}` : "p-sheet"}
			isOpen={open}
			aria-label={label ?? (typeof title === "string" ? title : undefined)}
			{...present}
			// Ionic's default is `true`: an explicit undefined would block every
			// dismiss, so pass it only when given.
			{...(canDismiss === undefined ? {} : { canDismiss })}
			onIonModalDidDismiss={() => {
				onClose();
				onClosed?.();
			}}
			data-testid={testId}
		>
			{/* The header stays put; the body scrolls (a detent shows its top). */}
			<IonContent className="p-sheet-content" scrollY={false}>
				<div className="p-sheet-frame">
					{head && (
						<header className="p-sheet-head">
							<span className="p-sheet-start">{back ?? start}</span>
							<h2>{title}</h2>
							<span className="p-sheet-end">
								{end ?? <CloseX onClick={onClose} />}
							</span>
						</header>
					)}
					{toolbar && <div className="p-sheet-toolbar">{toolbar}</div>}
					{/* ion-content-scroll-host: Ionic's sheet gesture reads this
					    scroller's position (drag from the body only at its top). */}
					<div
						className={
							scrollBody
								? "m-sheet-scroll p-sheet-body ion-content-scroll-host"
								: "m-sheet-scroll p-sheet-body"
						}
					>
						{children}
					</div>
					{footer}
				</div>
			</IonContent>
		</lz.IonModal>,
		document.querySelector("ion-app") ?? document.body,
	);
}
