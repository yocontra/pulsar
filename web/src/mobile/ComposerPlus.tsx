/**
 * The phone composer's + button and its menu: what the composer's parts
 * add (commands and skills, Photo Library, Choose Files), then how the
 * message is delivered (priority) and whether a reply is expected. A
 * lazy chunk of the phone app only (Konsta's Menu).
 */
import {
	CornerDownRightIcon,
	MessageSquareReplyIcon,
	MoonIcon,
	PlusIcon,
	ZapIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import type { Priority } from "../api/types.ts";
import type { ComposerAction } from "../lib/composer-menu.tsx";
import { Menu, type MenuItem } from "./ui/Menu.tsx";

const PRIORITY_ICON = {
	urgent: ZapIcon,
	normal: CornerDownRightIcon,
	fyi: MoonIcon,
} as const;

export default function ComposerPlus({
	actions,
	priorities,
	hidePriorities,
	priority,
	onPriority,
	expectReply,
	onExpectReply,
}: {
	actions: ComposerAction[];
	priorities: { value: Priority; label: string }[];
	hidePriorities: boolean;
	priority: Priority;
	onPriority: (p: Priority) => void;
	expectReply: boolean;
	onExpectReply: (v: boolean) => void;
}) {
	const [open, setOpen] = useState(false);
	const btn = useRef<HTMLButtonElement>(null);
	const icon = "size-5";
	const items: MenuItem[] = [
		...actions.map((a) => ({
			label: a.label,
			icon: a.icon,
			disabled: a.disabled,
			onSelect: a.run,
		})),
		...(hidePriorities ? [] : priorities).map((p) => {
			const I = PRIORITY_ICON[p.value];
			return {
				label: p.label,
				icon: <I className={icon} aria-hidden="true" />,
				active: priority === p.value,
				onSelect: () => onPriority(p.value),
			};
		}),
		{
			label: "Expect a Reply",
			icon: <MessageSquareReplyIcon className={icon} aria-hidden="true" />,
			active: expectReply,
			onSelect: () => onExpectReply(!expectReply),
		},
	];
	// Not the defaults: say so on the button, so a send isn't a surprise.
	const marked = priority !== "normal" || expectReply;
	const current = priorities.find((p) => p.value === priority);
	const label = `Message options${marked ? `: ${current?.label ?? ""}${expectReply ? ", expect reply" : ""}` : ""}`;
	return (
		<div className="m-prio">
			<button
				ref={btn}
				type="button"
				className={`m-prio-btn m-plus${priority === "normal" ? "" : ` p-${priority}`}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={label}
				title={label}
				onClick={() => setOpen(true)}
			>
				<PlusIcon className="size-5" strokeWidth={2.4} />
				{marked && <span className="m-prio-dot" aria-hidden="true" />}
			</button>
			<Menu
				open={open}
				onClose={() => setOpen(false)}
				target={btn}
				items={items}
				label="Message options"
			/>
		</div>
	);
}
