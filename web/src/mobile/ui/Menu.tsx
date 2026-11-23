/**
 * A ••• menu: Konsta's Popover anchored to its button, with a MenuList
 * (glass on iOS, a Material menu on Android). For confirms and long-press
 * sheets use `showActions` (ui/actions.ts).
 */
import { MenuList, MenuListItem, Popover } from "konsta/react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

// Pulsar's tokens: an opaque-enough glass on iOS (labels stay AA over the
// transcript), Material's menu surface; body-text labels on both.
const POPOVER = {
	bgIos: "bg-[var(--ds-material)] backdrop-blur-xl backdrop-saturate-150",
	bgMaterial: "bg-[var(--ds-surface-2)]",
};
const ITEM = {
	menuListItemTextIos: "text-[var(--ds-text)]",
	menuListItemTextMaterial: "text-[var(--ds-text)]",
	menuListItemBgIos: "active:bg-[var(--ds-surface-active)]",
	menuListItemBgMaterial: "bg-transparent active:bg-[var(--ds-surface-active)]",
	menuListItemActiveTextIos: "text-[var(--ds-text)]",
	menuListItemActiveTextMaterial: "text-[var(--ds-text)]",
	menuListItemActiveBgIos: "bg-[var(--ds-surface-active)]",
	menuListItemActiveBgMaterial: "bg-[var(--ds-surface-active)]",
};

export interface MenuItem {
	label: string;
	icon?: ReactNode;
	onSelect: () => void;
	/** Shown as selected (a choice in the menu). */
	active?: boolean;
	destructive?: boolean;
	disabled?: boolean;
}

export function Menu({
	open,
	onClose,
	target,
	items,
	label,
}: {
	open: boolean;
	onClose: () => void;
	/** The button the menu hangs from. */
	target: RefObject<HTMLElement | null>;
	items: MenuItem[];
	label: string;
}) {
	// Portaled into ion-app: inside a toolbar it would be clipped, and its
	// backdrop would cover the toolbar only.
	return createPortal(
		<div className="p-menu-layer">
			<Popover
				opened={open}
				target={target.current ?? undefined}
				onBackdropClick={onClose}
				className="p-menu"
				colors={POPOVER}
				// Closed, it stays mounted (scaled to nothing) for its animation:
				// not a menu then (screen readers, the app update's idle check).
				role={open ? "menu" : undefined}
				aria-label={label}
				aria-hidden={open ? undefined : true}
				inert={!open}
				data-testid="menu"
			>
				<MenuList>
					{items.map((it) => (
						<MenuListItem
							key={it.label}
							title={it.label}
							media={it.icon}
							active={it.active}
							role="menuitem"
							// MenuListItem passes colors to its ListItem (not in its types).
							{...({ colors: ITEM } as object)}
							aria-disabled={it.disabled || undefined}
							className={it.destructive ? "p-menu-danger" : undefined}
							onClick={() => {
								if (it.disabled) return;
								onClose();
								it.onSelect();
							}}
						/>
					))}
				</MenuList>
			</Popover>
		</div>,
		document.querySelector("ion-app") ?? document.body,
	);
}
