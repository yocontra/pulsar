import {
	CircleCheckIcon,
	CircleDashedIcon,
	CircleIcon,
	CircleSlashIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { TranscriptTodo as Todo } from "../../../src/transcripts/types.ts";

const TODO_ICON: Record<Todo["status"], ReactNode> = {
	done: <CircleCheckIcon aria-label="Done" />,
	active: <CircleDashedIcon aria-label="In progress" />,
	todo: <CircleIcon aria-label="To do" />,
	cancelled: <CircleSlashIcon aria-label="Cancelled" />,
};

export function Checklist({
	items,
	omitted,
}: {
	items: Todo[];
	omitted?: number;
}) {
	return (
		<ul className="ds-todos">
			{items.map((t, i) => (
				<li
					key={i}
					className={`t-${t.status}`}
					title={t.priority && `${t.priority} priority`}
				>
					{TODO_ICON[t.status]}
					<span>{t.text}</span>
				</li>
			))}
			{omitted ? <li>{omitted} more steps omitted</li> : null}
		</ul>
	);
}
