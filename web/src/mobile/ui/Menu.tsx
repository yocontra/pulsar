/**
 * A ••• menu: Konsta's Popover anchored to its button, with a MenuList
 * (glass on iOS, a Material menu on Android). For confirms and long-press
 * sheets use `showActions` (ui/actions.ts).
 */
import { MenuList, MenuListItem, Popover } from "konsta/react";
import type { ReactNode, RefObject } from "react";

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
	return (
		<Popover
			opened={open}
			target={target.current ?? undefined}
			onBackdropClick={onClose}
			className="p-menu"
			role="menu"
			aria-label={label}
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
	);
}
