/**
 * An inset grouped list (iOS Settings style; Material's list on Android),
 * with an optional header and footer: Konsta's BlockTitle, List and
 * BlockFooter. Rows are Konsta ListItems.
 */
import { BlockFooter, BlockTitle, List } from "konsta/react";
import type { ReactNode } from "react";

export function GroupedList({
	title,
	footer,
	label,
	className,
	children,
}: {
	title?: ReactNode;
	footer?: ReactNode;
	/** The group's accessible name when it has no visible title. */
	label?: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={label ?? (typeof title === "string" ? title : undefined)}
		>
			{title && <BlockTitle>{title}</BlockTitle>}
			<List strong inset className={className}>
				{children}
			</List>
			{footer && <BlockFooter>{footer}</BlockFooter>}
		</section>
	);
}

export { ListItem } from "konsta/react";
