import type { ComponentProps } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";
import { useSafeStreamdown } from "@/session/streamdown";

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
	({ className, ...props }: MessageResponseProps) => {
		// pulsar: hardened link/image policy; Shiki, Mermaid and KaTeX load on demand.
		const safe = useSafeStreamdown(props.children);
		return (
			<Streamdown
				className={cn(
					"size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
					className,
				)}
				{...safe}
				{...props}
			/>
		);
	},
	(prevProps, nextProps) =>
		prevProps.children === nextProps.children &&
		nextProps.isAnimating === prevProps.isAnimating,
);

MessageResponse.displayName = "MessageResponse";
