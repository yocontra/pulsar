/**
 * Settings-style rows for a GroupedList (Konsta ListItems): a tappable row,
 * a switch row, a plain value row and a note row, with the iOS Settings
 * icon tile (a plain tinted icon on Android, ui.css).
 *
 * - LinkRow is a real <button> (Konsta's link item, `linkComponent`), so
 *   it has the button role, focus and `disabled`; `data-setting` and the
 *   label go on that button.
 * - ToggleRow is Konsta's label item with a Toggle: the row's text names
 *   the checkbox, and a tap anywhere on the row flips it.
 */
import { ListItem, Toggle } from "konsta/react";
import type { ReactNode } from "react";

export type Tone = "red" | "green" | "blue" | "gray" | "orange";

/** The leading icon tile. */
export function RowIcon({
	tone,
	children,
}: {
	tone: Tone;
	children: ReactNode;
}) {
	return (
		<span className={`p-set-icon is-${tone}`} aria-hidden="true">
			{children}
		</span>
	);
}

export function LinkRow({
	icon,
	title,
	after,
	onClick,
	disabled,
	setting,
	label,
	role,
	checked,
	chevron = true,
}: {
	icon?: ReactNode;
	title: ReactNode;
	after?: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	/** `data-setting` on the button (tests, deep links). */
	setting?: string;
	/** The accessible name when the visible text isn't enough. */
	label?: string;
	/** `radio` for a choice in a radiogroup. */
	role?: "radio";
	checked?: boolean;
	chevron?: boolean;
}) {
	return (
		<ListItem
			link
			linkComponent="button"
			chevron={chevron}
			contentClassName="p-li-button"
			media={icon}
			title={title}
			after={after}
			linkProps={{
				type: "button",
				onClick,
				disabled,
				"data-setting": setting,
				"aria-label": label,
				role,
				"aria-checked":
					role === "radio" ? (checked ? "true" : "false") : undefined,
			}}
		/>
	);
}

/**
 * A switch's off state stays visible on every surface: the track (iOS) or
 * outline and thumb (Material) get --ds-switch-off, 3:1 against the cell
 * (Konsta's defaults are a faint tint, nearly gone in dark).
 */
const TOGGLE = {
	bgIos: "bg-[var(--ds-switch-off)]",
	borderMaterial: "border-[var(--ds-switch-off)]",
	thumbBgMaterial: "bg-[var(--ds-switch-off)]",
};

export function ToggleRow({
	icon,
	title,
	checked,
	disabled,
	onChange,
	setting,
}: {
	icon?: ReactNode;
	title: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (on: boolean) => void;
	setting?: string;
}) {
	return (
		<ListItem
			label
			media={icon}
			title={title}
			data-setting={setting}
			className={disabled ? "p-li-disabled" : undefined}
			after={
				<Toggle
					component="div"
					colors={TOGGLE}
					checked={checked}
					disabled={disabled}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
						onChange(e.currentTarget.checked)
					}
				/>
			}
		/>
	);
}

/** A row that shows a value (no tap). */
export function ValueRow({
	icon,
	title,
	sub,
	after,
}: {
	icon?: ReactNode;
	title: ReactNode;
	sub?: ReactNode;
	after?: ReactNode;
}) {
	return (
		<ListItem
			media={icon}
			strongTitle={false}
			title={title}
			text={sub}
			after={after}
		/>
	);
}

/** A row of help or error text inside a group. */
export function NoteRow({
	children,
	alert,
}: {
	children: ReactNode;
	alert?: boolean;
}) {
	return (
		<ListItem
			title={
				<span
					className={alert ? "p-li-note is-alert" : "p-li-note"}
					role={alert ? "alert" : undefined}
				>
					{children}
				</span>
			}
		/>
	);
}
