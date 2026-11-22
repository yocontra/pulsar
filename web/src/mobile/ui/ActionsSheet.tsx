/**
 * The open action sheet (ui/actions.ts) as Konsta Actions: the iOS sheet of
 * grouped buttons with Cancel apart, or Material's bottom sheet. Above
 * Ionic's own sheets, so a sheet's menu shows over it.
 */
import {
	Actions,
	ActionsButton,
	ActionsGroup,
	ActionsLabel,
} from "konsta/react";
import { useEffect, useState } from "react";
import type { ActionsRequest } from "./actions.ts";

const DANGER = {
	textIos: "text-[var(--ds-danger)]",
	textMaterial: "text-[var(--ds-danger)]",
};

/** Konsta's slide-out time (Actions: 300 ms on iOS, 400 on Material). */
const OUT_MS = 400;

export default function ActionsSheet({ req }: { req: ActionsRequest }) {
	const [opened, setOpened] = useState(false);
	// Mount closed, then open: Konsta animates the change.
	useEffect(() => {
		const raf = requestAnimationFrame(() => setOpened(true));
		return () => cancelAnimationFrame(raf);
	}, []);
	const close = (then?: () => void) => {
		setOpened(false);
		then?.();
		setTimeout(req.done, OUT_MS);
	};
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	});
	const main = req.buttons.filter((b) => b.role !== "cancel");
	const cancel = req.buttons.find((b) => b.role === "cancel");
	return (
		<div className="p-actions-layer">
			<Actions
				opened={opened}
				onBackdropClick={() => close(cancel?.handler)}
				role="dialog"
				aria-modal="true"
				aria-label={req.header ?? "Actions"}
				data-testid="actions"
			>
				<ActionsGroup>
					{req.header && <ActionsLabel>{req.header}</ActionsLabel>}
					{req.subHeader && (
						<ActionsLabel className="p-actions-sub">
							{req.subHeader}
						</ActionsLabel>
					)}
					{main.map((b) => (
						<ActionsButton
							key={b.text}
							disabled={b.disabled}
							colors={b.role === "destructive" ? DANGER : undefined}
							onClick={() => close(b.handler)}
						>
							{b.text}
						</ActionsButton>
					))}
				</ActionsGroup>
				{cancel && (
					<ActionsGroup>
						<ActionsButton bold onClick={() => close(cancel.handler)}>
							{cancel.text}
						</ActionsButton>
					</ActionsGroup>
				)}
			</Actions>
		</div>
	);
}
