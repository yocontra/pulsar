import { cx as cn } from "../../lib/cx.ts";

/**
 * Skeleton primitives. Build a skeleton from the real row's layout (same
 * paddings, same line heights) and swap these in for the text and avatar,
 * so nothing moves when the data lands. A line takes the height of one
 * line of text at the current font size (`1lh`) with the bar centered.
 */
export function Skeleton({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			aria-hidden="true"
			className={cn("ds-sk", className)}
			data-slot="skeleton"
			{...props}
		/>
	);
}

/** One line of text, `w` in tenths of the line's width (1-10) or a CSS width class. */
export function SkeletonText({
	w = 7,
	className,
}: {
	w?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
	className?: string;
}) {
	return (
		<span aria-hidden="true" className={cn("ds-sk-line", className)}>
			<span className={cn("ds-sk", `ds-w-${w}`)} />
		</span>
	);
}

/** Avatar / icon placeholder with the avatar's size and radius. */
export function SkeletonAvatar({
	size = "md",
	round,
	className,
}: {
	size?: "xs" | "sm" | "md" | "lg";
	round?: boolean;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"ds-sk ds-avatar",
				`ds-avatar--${size}`,
				round && "is-round",
				className,
			)}
		/>
	);
}

/** Wraps a skeleton region: one live region for VoiceOver, shimmer on children. */
export function SkeletonGroup({
	label = "Loading",
	className,
	children,
}: {
	label?: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div
			className={cn("ds-sk-group", className)}
			role="status"
			aria-busy="true"
			aria-label={label}
		>
			{children}
		</div>
	);
}
