/**
 * A sheet over the page: Ionic's IonModal presents it (detents, swipe to
 * dismiss, the iOS card stack), Konsta lays out what is inside. On Android
 * it is a Material bottom sheet with a drag handle. Portaled into ion-app,
 * so it stacks over the page that opened it.
 *
 * Mount it while it may be open: it presents on `open`, and calls
 * `onClosed` once it has animated out (swipe, backdrop, Esc or Done).
 */

import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import { CloseX } from "../../components/CloseX.tsx";
import { IonContent } from "../ionic.ts";
import { useIonicLazy } from "../lazyIonic.ts";
import { isMaterial } from "../platform.ts";

export function SheetShell({
	open,
	onClose,
	onClosed,
	title,
	detents = [0, 0.6, 1],
	initial = 0.6,
	end,
	testId,
	children,
}: {
	open: boolean;
	/** Asks to close (the X); the sheet animates out, then `onClosed`. */
	onClose: () => void;
	onClosed?: () => void;
	title: string;
	/** Heights as a fraction of the screen (0 lets a swipe dismiss it). */
	detents?: number[];
	initial?: number;
	/** A trailing header control in place of the close button. */
	end?: ReactNode;
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
	return createPortal(
		<lz.IonModal
			className="p-sheet"
			isOpen={open}
			aria-label={title}
			breakpoints={detents}
			initialBreakpoint={initial}
			handle={isMaterial}
			onIonModalDidDismiss={() => {
				onClose();
				onClosed?.();
			}}
			data-testid={testId}
		>
			<IonContent className="p-sheet-content">
				<header className="m-sheet-head">
					<span />
					<h2>{title}</h2>
					{end ?? <CloseX onClick={onClose} />}
				</header>
				<div className="p-sheet-body">{children}</div>
			</IonContent>
		</lz.IonModal>,
		document.querySelector("ion-app") ?? document.body,
	);
}
