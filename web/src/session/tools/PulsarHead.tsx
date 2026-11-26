/**
 * The one-line head of a Pulsar tool call's card: "Sent to [reviewer]
 * Urgent · delivered to 1", "Replied to [builder]", "Waited for a
 * message · timed out after 5 min". Plain chips only: the head is the
 * card's toggle button, so links live in the expanded body (PulsarBody).
 */
import {
	CircleUserRoundIcon,
	ClockIcon,
	InboxIcon,
	ReplyIcon,
	SendIcon,
	UsersIcon,
} from "lucide-react";
import { lazy, type ReactNode, useMemo } from "react";
import {
	describePulsar,
	type LineChip,
	type PulsarTool,
	pulsarTool,
} from "../../../../src/transcripts/pulsar.ts";
import { AgentAvatar } from "../../components/ui/agent-avatar.tsx";
import type { ToolCard, ToolHeadProps } from "../../harnesses/types.ts";
import { useKnownMessage } from "./pulsar-messages.ts";

/** A chip for an agent (avatar + name) or a group or tag (plain words). */
export function Chip({ chip }: { chip: LineChip }) {
	return (
		<span
			className={`ds-pulsar-chip${chip.group ? " is-group" : chip.agent ? "" : " is-tag"}`}
		>
			{chip.agent && chip.harness ? (
				<AgentAvatar harness={chip.harness} size="xs" />
			) : chip.group ? (
				<UsersIcon aria-hidden="true" />
			) : null}
			<span className="ds-pulsar-chip-name">{chip.label}</span>
		</span>
	);
}

export function PulsarHead({
	name,
	input,
	output,
	isError,
	done,
	ms,
	stateFacts,
}: ToolHeadProps) {
	const tool = pulsarTool(name)!;
	const line = useMemo(
		() => describePulsar(tool, input, { done, output, isError, ms }),
		[tool, input, done, output, isError, ms],
	);
	const answered = useKnownMessage(line.answers);
	const chips: LineChip[] = answered
		? [
				answered.operator
					? { label: answered.from }
					: {
							label: answered.from,
							agent: answered.from,
							...(answered.harness ? { harness: answered.harness } : {}),
						},
			]
		: line.chips;
	const verb =
		line.answers && line.verb.startsWith("Repl")
			? `${line.verb} to`
			: line.verb;
	// Tags read as a list; one agent or group reads as the object.
	const shown = chips.slice(0, line.text ? 3 : 2);
	const more = chips.length - shown.length;
	return (
		<>
			<span className="ds-tool-verb">{verb}</span>
			<span className="ds-tool-main ds-pulsar-main">
				{tool !== "wait" && line.text && (
					<span className="ds-tool-target ds-pulsar-text">{line.text}</span>
				)}
				{shown.map((c, i) => (
					<Chip key={i} chip={c} />
				))}
				{tool === "wait" && line.text && (
					<span className="ds-tool-target ds-pulsar-text">{line.text}</span>
				)}
				{more > 0 && <span className="ds-pulsar-more">+{more}</span>}
				{!shown.length &&
					!line.text &&
					line.answers &&
					verb.endsWith(" to") && (
						<span className="ds-tool-target">a message</span>
					)}
			</span>
			<span className="ds-tool-meta tool-summary">
				{line.label && !line.error && !stateFacts && (
					<span className="ds-pulsar-label">{line.label}</span>
				)}
				{stateFacts?.length ? (
					<span className="ds-tool-sum">
						{stateFacts.map((f) => (
							<span key={f}>{f}</span>
						))}
					</span>
				) : line.error ? (
					// The reason shows once, in full, in the body.
					<span className="ds-tool-sum is-error" title={line.error}>
						<span>Failed</span>
					</span>
				) : line.facts.length ? (
					<span className="ds-tool-sum">
						{line.facts.map((f) => (
							<span key={f}>{f}</span>
						))}
					</span>
				) : null}
			</span>
		</>
	);
}

const Body = lazy(() => import("./PulsarBody.tsx"));

const ICONS: Record<PulsarTool, ReactNode> = {
	send: <SendIcon />,
	ask: <SendIcon />,
	respond: <ReplyIcon />,
	reply: <ReplyIcon />,
	ack: <ReplyIcon />,
	done: <ReplyIcon />,
	nack: <ReplyIcon />,
	wait: <ClockIcon />,
	list_agents: <UsersIcon />,
	who: <UsersIcon />,
	inbox: <InboxIcon />,
	history: <InboxIcon />,
	set_identity: <CircleUserRoundIcon />,
	whoami: <CircleUserRoundIcon />,
};

const cards = new Map<PulsarTool, ToolCard>();

/** The bespoke card for a Pulsar MCP call in any harness; undefined for other tools. */
export function pulsarCard(name: string): ToolCard | undefined {
	const tool = pulsarTool(name);
	if (!tool) return undefined;
	let card = cards.get(tool);
	if (!card) {
		card = {
			kind: tool === "wait" ? "wait" : "message",
			icon: ICONS[tool],
			className: "is-pulsar",
			Head: PulsarHead,
			Body,
		};
		cards.set(tool, card);
	}
	return card;
}
