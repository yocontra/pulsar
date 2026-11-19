import type { ReactNode } from "react";

/**
 * A link out of the app (a repo, branch or PR page): a new tab, no opener,
 * no referrer. Its click stays here, so a parent row never also opens.
 * Without an `href` it is its children as plain text.
 */
export function ExtLink({
	href,
	className,
	title,
	children,
}: {
	href: string | null;
	className?: string;
	title?: string;
	children: ReactNode;
}) {
	if (!href) return <>{children}</>;
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className={className ? `ext-link ${className}` : "ext-link"}
			title={title}
			onClick={(e) => e.stopPropagation()}
		>
			{children}
		</a>
	);
}
