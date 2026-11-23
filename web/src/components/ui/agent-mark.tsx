import type { AgentColor } from "../../lib/agent-color.ts";
import { cx } from "../../lib/cx.ts";

/**
 * A subagent's color as a dot next to its name (lib/agent-color.ts):
 * decorative, the name says who it is. Nothing without a color.
 */
export function AgentMark({
	color,
	className,
}: {
	color: AgentColor | null | undefined;
	className?: string;
}) {
	if (!color) return null;
	return (
		<span
			className={cx("ds-agent-mark", className)}
			data-agent-color={color}
			aria-hidden="true"
		/>
	);
}
