/**
 * The expanded view of a Pulsar tool call (loaded on first open): who it
 * went to, what it said, what came back, with agents linked to their
 * sessions. The raw arguments and result stay under "Show details".
 */
import { ChevronRightIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import {
	answeredId,
	errorMessage,
	identityChange,
	type PulsarAgent,
	type PulsarMessage,
	type PulsarTool,
	parseAgents,
	parseIdentity,
	parseMessages,
	parseSend,
	parseWait,
	priorityLabel,
	pulsarTool,
	type Receipt,
	recipients,
	respondState,
	resultBody,
	sentText,
} from "../../../../src/transcripts/pulsar.ts";
import { MessageResponse } from "../../components/ai-elements/message.tsx";
import { AgentAvatar } from "../../components/ui/agent-avatar.tsx";
import { hrefFor } from "../../lib/hash.ts";
import { Args, type BodyProps, Result, StateNote } from "./bodies.tsx";
import { useKnownMessage } from "./pulsar-messages.ts";

const rec = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};

/** An agent as a chip that opens its session: by id when known, else found by name on click. */
export function AgentLink({ agent }: { agent: PulsarAgent }) {
	const [gone, setGone] = useState(false);
	const inner = (
		<>
			{agent.harness && <AgentAvatar harness={agent.harness} size="xs" />}
			<span className="ds-pulsar-chip-name">{agent.name}</span>
		</>
	);
	if (agent.id) {
		const id = agent.id;
		return (
			<a
				className="ds-pulsar-chip is-link"
				href={hrefFor({ view: "agent", id })}
				data-agent-id={id}
				title={`Open ${agent.name}`}
				onClick={(e) => {
					// A new tab keeps the plain link; in place, the router pushes the
					// screen (the phone's stack needs its history state).
					if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
					e.preventDefault();
					void import("./pulsar-open.ts").then((m) =>
						m.openAgent({ id, name: agent.name }),
					);
				}}
			>
				{inner}
			</a>
		);
	}
	return (
		<button
			type="button"
			className="ds-pulsar-chip is-link"
			data-agent-name={agent.name}
			disabled={gone}
			title={gone ? `${agent.name} is not running now` : `Open ${agent.name}`}
			onClick={async () => {
				const { openAgent } = await import("./pulsar-open.ts");
				if (!(await openAgent({ name: agent.name }))) setGone(true);
			}}
		>
			{inner}
		</button>
	);
}

/** A message id: jumps to the message when this transcript shows it. */
function MessageId({ id }: { id: string }) {
	const target = () =>
		document.querySelector<HTMLElement>(`[data-pulsar-id="${CSS.escape(id)}"]`);
	return (
		<button
			type="button"
			className="ds-pulsar-id mono"
			title="Show this message in the conversation"
			onClick={() =>
				target()?.scrollIntoView({ block: "center", behavior: "smooth" })
			}
		>
			{id}
		</button>
	);
}

/** A message from an agent, as a nested bubble. */
function Bubble({
	from,
	body,
	meta,
}: {
	from: PulsarAgent;
	body: string;
	meta?: string;
}) {
	return (
		<div className="ds-pulsar-msg">
			<div className="ds-pulsar-msg-head">
				<AgentLink agent={from} />
				{meta && <span className="ds-pulsar-msg-meta">{meta}</span>}
			</div>
			{body.trim() && (
				<div className="ds-pulsar-msg-body">
					<MessageResponse>{body}</MessageResponse>
				</div>
			)}
		</div>
	);
}

function Receipts({ receipts }: { receipts: Receipt[] }) {
	if (!receipts.length) return null;
	return (
		<ul className="ds-pulsar-receipts" aria-label="Delivery">
			{receipts.map((r, i) => (
				<li key={i}>
					<AgentLink agent={{ name: r.name }} />
					<span className={`ds-pulsar-state s-${r.state}`}>{r.state}</span>
					{r.detail && <span className="ds-pulsar-msg-meta">{r.detail}</span>}
				</li>
			))}
		</ul>
	);
}

/** Sent text: a message body, an answer, a reason. */
function Sent({ text }: { text: string }) {
	if (!text.trim()) return null;
	return (
		<div className="ds-sent ds-pulsar-sent">
			<MessageResponse>{text}</MessageResponse>
		</div>
	);
}

function SendView(p: BodyProps & { tool: PulsarTool }) {
	const a = rec(p.input);
	const to = recipients(typeof a.to === "string" ? a.to : "");
	const awaits = p.tool === "ask" || a.await_reply === true;
	const pr = priorityLabel(
		typeof a.priority === "string" ? a.priority : awaits ? "urgent" : undefined,
	);
	const out = p.done && !p.isError ? parseSend(p.output) : null;
	return (
		<>
			<div className="ds-pulsar-to">
				<span className="ds-pulsar-k">To</span>
				{to.map((r, i) =>
					r.agent ? (
						<AgentLink key={i} agent={{ name: r.agent }} />
					) : (
						<span
							key={i}
							className="ds-pulsar-chip is-group"
							title={r.selector}
						>
							<UsersIcon aria-hidden="true" />
							<span className="ds-pulsar-chip-name">{r.label}</span>
						</span>
					),
				)}
				{pr && <span className="ds-pulsar-label">{pr}</span>}
				{awaits && !p.done && (
					<span className="ds-pulsar-msg-meta">waiting for reply</span>
				)}
			</div>
			<Sent text={sentText(p.tool, p.input)} />
			{out?.reply && (
				<Bubble
					from={{ name: out.reply.from }}
					body={out.reply.body}
					meta="replied"
				/>
			)}
			{out?.timedOut && (
				<p className="ds-tool-note">
					No reply in time. A later reply reaches the agent as a normal message.
				</p>
			)}
			{out?.declined && (
				<p className="ds-tool-note">
					{out.declined === "declined"
						? "The recipient declined it."
						: "Pulsar gave up delivering it."}
				</p>
			)}
			{out && <Receipts receipts={out.receipts} />}
		</>
	);
}

function RespondView(p: BodyProps & { tool: PulsarTool }) {
	const id = answeredId(p.input);
	const known = useKnownMessage(id || undefined);
	const s = respondState(p.tool, p.input);
	const out = p.done && !p.isError ? parseSend(p.output) : null;
	const note = p.done && !p.isError ? resultBody(p.output).split("\n")[0] : "";
	return (
		<>
			{id && (
				<blockquote className="ds-pulsar-quote">
					{known ? (
						<>
							<span className="ds-pulsar-quote-head">
								{known.operator ? (
									<span className="ds-pulsar-chip">
										<span className="ds-pulsar-chip-name">{known.from}</span>
									</span>
								) : (
									<AgentLink
										agent={{
											name: known.from,
											...(known.harness ? { harness: known.harness } : {}),
										}}
									/>
								)}
								<MessageId id={id} />
							</span>
							<span className="ds-pulsar-quote-text">
								{known.text.trim().split("\n")[0]}
							</span>
						</>
					) : (
						<span className="ds-pulsar-quote-head">
							<span className="ds-pulsar-msg-meta">In answer to</span>
							<MessageId id={id} />
						</span>
					)}
				</blockquote>
			)}
			<Sent text={sentText(p.tool, p.input)} />
			{s === "reply" && out ? (
				<Receipts receipts={out.receipts} />
			) : note ? (
				<p className="ds-tool-note">{note}</p>
			) : null}
		</>
	);
}

function MessageList({ messages }: { messages: PulsarMessage[] }) {
	return (
		<div className="ds-pulsar-msgs">
			{messages.map((m) => (
				<Bubble
					key={m.id}
					from={m.from}
					body={m.body}
					meta={[
						m.ago,
						m.priority,
						m.wantsReply ? "wants a reply" : "",
						m.replyTo ? `reply to ${m.replyTo}` : "",
					]
						.filter(Boolean)
						.join(" · ")}
				/>
			))}
		</div>
	);
}

function WaitView(p: BodyProps) {
	if (!p.done) return <p className="ds-tool-note">Waiting…</p>;
	const w = parseWait(p.output);
	if (w.message) return <MessageList messages={[w.message]} />;
	if (w.receipts?.length) return <Receipts receipts={w.receipts} />;
	return (
		<p className="ds-tool-note">
			{w.timedOut
				? "Nothing happened in time."
				: w.idle
					? `${w.idle} finished its turn.`
					: w.event}
		</p>
	);
}

/** How many agents a lookup shows before "+N more". */
const FIRST = 8;

function AgentsView(p: BodyProps) {
	const [all, setAll] = useState(false);
	const q = rec(p.input).question;
	if (!p.done) return null;
	const r = parseAgents(p.output);
	if (r.empty) return <p className="ds-tool-note">{r.empty}</p>;
	const shown = all ? r.agents : r.agents.slice(0, FIRST);
	const hidden = r.total - shown.length;
	return (
		<>
			{typeof q === "string" && q.trim() && (
				<p className="ds-tool-desc">“{q.trim()}”</p>
			)}
			<ul className="ds-pulsar-agents">
				{shown.map((a, i) => (
					<li key={a.id ?? i}>
						<AgentLink agent={a} />
						{a.status && <span className="ds-pulsar-msg-meta">{a.status}</span>}
						{a.activity && (
							<span className="ds-pulsar-doing">{a.activity}</span>
						)}
					</li>
				))}
			</ul>
			{hidden > 0 &&
				(!all && r.agents.length > shown.length ? (
					<button
						type="button"
						className="ds-pulsar-more is-button"
						onClick={() => setAll(true)}
					>
						+{hidden} more
					</button>
				) : (
					<p className="ds-tool-note">
						+{hidden} more not in the result shown to the agent.
					</p>
				))}
		</>
	);
}

function InboxView(p: BodyProps) {
	if (!p.done) return null;
	const msgs = parseMessages(resultBody(p.output));
	if (!msgs.length)
		return (
			<p className="ds-tool-note">{resultBody(p.output).split("\n")[0]}</p>
		);
	return <MessageList messages={msgs} />;
}

function IdentityView(p: BodyProps & { tool: PulsarTool }) {
	const c = identityChange(p.input);
	const me = p.done && !p.isError ? parseIdentity(p.output) : null;
	const tags = me?.tags.length ? me.tags : c.tagsAdd;
	return (
		<>
			{(me?.activity ?? c.activity) && (
				<p className="ds-tool-desc">{me?.activity ?? c.activity}</p>
			)}
			{tags.length > 0 && (
				<ul className="ds-chips" aria-label="Tags">
					{tags.map((t) => (
						<li
							key={t}
							className={c.tagsAdd.includes(t) ? "is-new" : undefined}
						>
							{t}
						</li>
					))}
				</ul>
			)}
			{c.tagsRemove.length > 0 && (
				<p className="ds-tool-note">Removed: {c.tagsRemove.join(", ")}</p>
			)}
			{me?.name && (
				<p className="ds-tool-note">
					{me.name}
					{me.unread ? ` · ${me.unread} unread` : ""}
				</p>
			)}
		</>
	);
}

function View(p: BodyProps & { tool: PulsarTool }) {
	switch (p.tool) {
		case "send":
		case "ask":
			return <SendView {...p} />;
		case "respond":
		case "reply":
		case "ack":
		case "done":
		case "nack":
			return <RespondView {...p} />;
		case "wait":
			return <WaitView {...p} />;
		case "list_agents":
		case "who":
			return <AgentsView {...p} />;
		case "inbox":
		case "history":
			return <InboxView {...p} />;
		case "set_identity":
		case "whoami":
			return <IdentityView {...p} />;
	}
}

export default function PulsarBody(p: BodyProps) {
	const tool = pulsarTool(p.name);
	const [open, setOpen] = useState(false);
	if (!tool) return null;
	const failed = p.isError && p.done;
	return (
		<div className="ds-pulsar">
			{p.detail?.denied || p.detail?.interrupted ? (
				<StateNote {...p} />
			) : (
				<>
					<View {...p} tool={tool} />
					{failed && p.output.trim() && (
						<p className="ds-pulsar-error" role="alert">
							{errorMessage(p.output)}
						</p>
					)}
				</>
			)}
			<button
				type="button"
				className="ds-pulsar-details"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				<ChevronRightIcon aria-hidden="true" />
				{open ? "Hide details" : "Show details"}
			</button>
			{open && (
				<div className="ds-pulsar-raw">
					<Args input={p.input} />
					<Result {...p} isError={false} />
				</div>
			)}
		</div>
	);
}
