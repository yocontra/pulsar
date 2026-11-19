import { ArrowDownIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { SkeletonText } from "../components/ui/skeleton.tsx";
import type { Variant } from "./Transcript.tsx";

/**
 * The scroll container for a conversation: follows new content while the
 * reader is at the bottom, and shows a "Jump to latest" pill when they
 * scroll up. Children go in the content column (`.transcript`); `footer`
 * sits under it inside the scroller (an inline approval, say).
 */
export function ConversationView({
	variant,
	children,
	className,
	label = "Conversation",
	pill,
}: {
	variant: Variant;
	children: ReactNode;
	className?: string;
	label?: string;
	/** Replace the default pill (e.g. one that also moves the render window). */
	pill?: ReactNode;
}) {
	return (
		<StickToBottom
			className={`ds-scroller ds-scroller--${variant} transcript-conv${className ? ` ${className}` : ""}`}
			initial="instant"
			resize="instant"
			role="log"
			aria-label={label}
		>
			<StickToBottom.Content className="transcript ds-column">
				{children}
			</StickToBottom.Content>
			{pill ?? <JumpToLatest />}
			<StopFollowing />
		</StickToBottom>
	);
}

/**
 * Stops following the end when something inside asks (a `pulsar:stop-follow`
 * event, e.g. find in messages landing on an older message), as a scroll up
 * by the operator would; Jump to latest follows again.
 */
function StopFollowing() {
	const { stopScroll, scrollRef } = useStickToBottomContext();
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const stop = () => stopScroll();
		el.addEventListener("pulsar:stop-follow", stop);
		return () => el.removeEventListener("pulsar:stop-follow", stop);
	}, [scrollRef, stopScroll]);
	return null;
}

/** The floating "Jump to latest" pill; shows only when scrolled up. */
export function JumpToLatest({
	onClick,
	force,
	label = "Jump to latest",
}: {
	/** Called before scrolling (e.g. to move a render window to the end). */
	onClick?: () => void;
	/** Show even at the bottom (there are newer events outside the window). */
	force?: boolean;
	label?: string;
}) {
	const { isAtBottom, scrollToBottom } = useStickToBottomContext();
	if (isAtBottom && !force) return null;
	return (
		<button
			type="button"
			className="ds-jump new-pill"
			onClick={() => {
				onClick?.();
				requestAnimationFrame(() => void scrollToBottom());
			}}
		>
			<ArrowDownIcon aria-hidden="true" />
			{label}
		</button>
	);
}

/**
 * The transcript while its first page loads: the same column, author
 * lines, prose lines, a bubble and a tool card, at the bottom where the
 * newest turn lands. Built from the real classes, so it lines up exactly.
 */
export function TranscriptSkeleton({ variant }: { variant: Variant }) {
	return (
		<div
			className={`ds-conv ds-conv--${variant}${variant === "phone" ? " ds-phone" : ""} transcript-skel ds-sk-group`}
			role="status"
			aria-busy="true"
			aria-label="Loading conversation"
		>
			<div className="ds-turn ds-turn--assistant" aria-hidden="true">
				<div className="ds-author">
					<span className="ds-sk ds-avatar ds-avatar--xs" />
					<SkeletonText w={2} className="ds-author-sk" />
				</div>
				<div className="ds-prose">
					<SkeletonText w={10} />
					<SkeletonText w={9} />
					<SkeletonText w={5} />
				</div>
				<div className="ds-tool ds-sk-tool">
					<div className="ds-tool-head">
						<span className="ds-sk ds-tool-icon" />
						<SkeletonText w={4} />
					</div>
				</div>
			</div>
			<div className="ds-turn ds-turn--user" aria-hidden="true">
				<div className="ds-bubble ds-sk-bubble">
					<SkeletonText w={10} />
				</div>
			</div>
			<div className="ds-turn ds-turn--assistant" aria-hidden="true">
				<div className="ds-prose">
					<SkeletonText w={8} />
					<SkeletonText w={10} />
					<SkeletonText w={3} />
				</div>
			</div>
		</div>
	);
}
