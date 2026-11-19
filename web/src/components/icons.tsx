import type { JSX } from "react";

type P = { size?: number; class?: string; label?: string };

function svg(path: JSX.Element, { size = 16, class: c, label }: P) {
	return (
		<svg
			className={`icon ${c ?? ""}`}
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden={label ? undefined : "true"}
			aria-label={label}
			role={label ? "img" : undefined}
		>
			{path}
		</svg>
	);
}
export const Broadcast = (p: P) =>
	svg(
		<>
			<path d="M3 8h1M6 5.5a3.5 3.5 0 0 1 0 5M8.5 3a7 7 0 0 1 0 10" />
			<circle cx="3" cy="8" r="1" fill="currentColor" />
		</>,
		p,
	);
export const Send = (p: P) => svg(<path d="M2 8l12-5-5 12-2-5-5-2z" />, p);
export const Back = (p: P) => svg(<path d="M10 3L5 8l5 5" />, p);
export const Close = (p: P) => svg(<path d="M4 4l8 8M12 4l-8 8" />, p);
export const Search = (p: P) =>
	svg(
		<>
			<circle cx="7" cy="7" r="4.5" />
			<path d="M10.5 10.5L14 14" />
		</>,
		p,
	);
export const Stop = (p: P) =>
	svg(<rect x="4" y="4" width="8" height="8" rx="1" />, p);
export const Phone = (p: P) =>
	svg(
		<>
			<rect x="4.5" y="1.5" width="7" height="13" rx="1.5" />
			<path d="M7 12.5h2" />
		</>,
		p,
	);
export const Pin = (p: P) =>
	svg(<path d="M6 2h4l-1 4 3 3H4l3-3-1-4zM8 9v5" />, p);
export const Inbox = (p: P) =>
	svg(<path d="M2 9l2-6h8l2 6v4H2V9zm0 0h4l1 2h2l1-2h4" />, p);
export const Expand = (p: P & { open?: boolean }) =>
	svg(<path d={p.open ? "M4 8h8" : "M4 8h8M8 4v8"} />, p);
export const Shield = (p: P) =>
	svg(<path d="M8 1.5l5 2v4c0 3.5-2.2 5.8-5 7-2.8-1.2-5-3.5-5-7v-4l5-2z" />, p);
function sf(path: JSX.Element, { size = 22, class: c, label }: P) {
	return (
		<svg
			className={`icon sf ${c ?? ""}`}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden={label ? undefined : "true"}
			aria-label={label}
			role={label ? "img" : undefined}
		>
			{path}
		</svg>
	);
}
export const SfSearch = (p: P) =>
	sf(
		<>
			<circle cx="10.5" cy="10.5" r="7" />
			<path d="M21 21l-5.5-5.5" />
		</>,
		p,
	);
export const SfClear = (p: P) =>
	sf(
		<>
			<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" />
			<path d="M15 9l-6 6M9 9l6 6" stroke="var(--m-clear-x, #fff)" />
		</>,
		p,
	);
