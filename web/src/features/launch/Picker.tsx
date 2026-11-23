import {
	ArrowLeftIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronLeftIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isMaterial } from "../../mobile/platform.ts";

export interface PickerOption {
	value: string;
	label: string;
	/** A second line or trailing detail (a path, "not found"). */
	sub?: string;
	/** A small tag after the label (a machine name). */
	badge?: string;
	disabled?: boolean;
	/** Why it is disabled (tooltip). */
	why?: string;
	icon?: ReactNode;
}

/**
 * A button that opens a searchable list (desktop: a popover under it;
 * phone: a full-screen page with a back button). `extra` adds rows under
 * the list for the current query ("Use this path").
 */
export function Picker({
	label,
	value,
	options,
	onChange,
	display,
	search,
	empty = "No matches.",
	loading,
	mobile,
	variant = "chip",
	icon,
	extra,
	disabled,
	disabledWhy,
	testId,
}: {
	/** What it picks ("Project"): the button's name and the page title. */
	label: string;
	value: string | null;
	options: PickerOption[];
	onChange: (value: string) => void;
	/** The button's text (default: the chosen option's label, else `label`). */
	display?: string;
	/** Placeholder of the search box; no search box without it. */
	search?: string;
	empty?: string;
	/** The list is loading ("Loading branches…"). */
	loading?: string | null;
	mobile: boolean;
	/** `hero`: inline in the headline; `chip`: a toolbar control. */
	variant?: "hero" | "chip";
	icon?: ReactNode;
	extra?: (
		query: string,
		close: () => void,
		setQuery: (q: string) => void,
	) => ReactNode;
	disabled?: boolean;
	disabledWhy?: string;
	testId?: string;
}) {
	const [open, setOpen] = useState(false);
	const [q, setQ] = useState("");
	const [active, setActive] = useState(0);
	const box = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const listId = useId();
	const chosen = options.find((o) => o.value === value);
	const words = q.trim().toLowerCase();
	const shown = words
		? options.filter((o) =>
				`${o.label} ${o.sub ?? ""} ${o.badge ?? ""}`
					.toLowerCase()
					.includes(words),
			)
		: options;
	const close = () => {
		setOpen(false);
		setQ("");
	};
	useEffect(() => {
		if (!open) return;
		setActive(
			Math.max(
				0,
				shown.findIndex((o) => o.value === value),
			),
		);
		input.current?.focus();
		if (mobile) return;
		const away = (e: MouseEvent) => {
			if (!box.current?.contains(e.target as Node)) close();
		};
		document.addEventListener("mousedown", away);
		return () => document.removeEventListener("mousedown", away);
	}, [open]);
	const pick = (o: PickerOption | undefined) => {
		if (!o || o.disabled) return;
		onChange(o.value);
		close();
	};
	const onKey = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((i) => Math.min(shown.length - 1, i + 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((i) => Math.max(0, i - 1));
		} else if (e.key === "Enter") {
			e.preventDefault();
			pick(shown[active]);
		}
	};
	const list = (
		<>
			{search && (
				<input
					ref={input}
					className="lp-search"
					type="search"
					value={q}
					placeholder={search}
					aria-label={search}
					aria-controls={listId}
					autoComplete="off"
					spellCheck={false}
					onChange={(e) => {
						setQ(e.currentTarget.value);
						setActive(0);
					}}
					onKeyDown={onKey}
				/>
			)}
			<div
				id={listId}
				className="lp-list"
				role="listbox"
				aria-label={label}
				tabIndex={search ? -1 : 0}
				onKeyDown={search ? undefined : onKey}
			>
				{loading ? (
					<p className="lp-note" role="status">
						{loading}
					</p>
				) : shown.length === 0 ? (
					<p className="lp-note">{empty}</p>
				) : (
					shown.map((o, i) => (
						<button
							type="button"
							key={o.value}
							role="option"
							aria-selected={o.value === value}
							aria-disabled={o.disabled || undefined}
							tabIndex={-1}
							title={o.disabled ? o.why : (o.sub ?? undefined)}
							className={`lp-opt${i === active ? " active" : ""}${o.disabled ? " off" : ""}`}
							onMouseEnter={() => setActive(i)}
							onClick={() => pick(o)}
						>
							{o.icon && <span className="lp-opt-icon">{o.icon}</span>}
							<span className="lp-opt-text">
								<span className="lp-opt-label">
									{o.label}
									{o.badge && <span className="lp-badge">{o.badge}</span>}
								</span>
								{o.sub && <span className="lp-opt-sub">{o.sub}</span>}
							</span>
							{o.value === value && <CheckIcon className="lp-check" />}
						</button>
					))
				)}
			</div>
			{extra?.(q.trim(), close, (v) => {
				setQ(v);
				input.current?.focus();
			})}
		</>
	);
	return (
		<div className={`lp lp-v-${variant}`} ref={box}>
			<button
				type="button"
				className={variant === "hero" ? "lp-hero-btn" : "lp-chip"}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={`${label}: ${display ?? chosen?.label ?? "none"}`}
				data-testid={testId}
				disabled={disabled}
				title={disabled ? disabledWhy : undefined}
				onClick={() => (open ? close() : setOpen(true))}
			>
				{icon}
				<span className="lp-btn-text">{display ?? chosen?.label ?? label}</span>
				<ChevronDownIcon className="lp-caret" aria-hidden="true" />
			</button>
			{open &&
				(mobile ? (
					// Over the whole app (Ionic's header and content), like a pushed page.
					createPortal(
						<div className="lp-page" role="dialog" aria-label={label}>
							<header className="lp-page-head">
								<button type="button" className="lp-back" onClick={close}>
									{isMaterial ? (
										<ArrowLeftIcon aria-hidden="true" />
									) : (
										<ChevronLeftIcon aria-hidden="true" />
									)}
									Back
								</button>
								<h2>{label}</h2>
							</header>
							{list}
						</div>,
						document.body,
					)
				) : (
					<div className="lp-pop" role="dialog" aria-label={label}>
						{list}
					</div>
				))}
		</div>
	);
}
