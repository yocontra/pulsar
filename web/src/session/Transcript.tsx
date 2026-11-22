/**
 * The shared conversation renderer (phone and desktop). Pure: it draws the
 * events it is given and fetches nothing but images. Data, paging, live
 * updates and the composer belong to the caller (see ConversationView for
 * the scroll container and jump-to-latest).
 */
import {
	BellIcon,
	BrainIcon,
	ChevronRightIcon,
	CircleStopIcon,
	CornerDownRightIcon,
	FoldVerticalIcon,
	InfoIcon,
} from "lucide-react";
import { Collapsible } from "radix-ui";
import {
	createContext,
	lazy,
	memo,
	type ReactNode,
	Suspense,
	useContext,
	useId,
	useMemo,
	useState,
} from "react";
import { describeCall } from "../../../src/transcripts/describe.ts";
import type { TranscriptEvent } from "../api/types.ts";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { AgentAvatar, harnessName } from "../components/ui/agent-avatar.tsx";
import { LOCAL_PREFIX, useLocalSend } from "../data/pending.ts";
import { splitAttached } from "../lib/attachments.ts";
import { clock, duration, plural } from "../lib/format.ts";
import { linkPrs } from "../lib/links.ts";
import { sentHere } from "../lib/sent.ts";
import { AttachedFiles } from "./AttachedFiles.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { FileRefAgent } from "./file-ref.tsx";
import { InlineCode } from "./highlight.tsx";
import { buildItems, type Item, isGap } from "./items.ts";
import { EventMedia, ImageThumb } from "./media.tsx";
import {
	APP_SENDER,
	type ChatMessage,
	messageText,
	peerFrom,
	toMessages,
	userAuthor,
} from "./messages.ts";
import { NoticeCard } from "./NoticeCard.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { knownMessages, PulsarMessages } from "./tools/pulsar-messages.ts";
import {
	type TurnChanges as TurnChangeSet,
	turnSummaries,
} from "./turn-changes.ts";

/**
 * Loaded only when a card needs it: it reads the app's data layer and
 * router, which this renderer (also used outside the app) must not load.
 */
const SubagentLink = lazy(() =>
	import("./SubagentLink.tsx").then((m) => ({ default: m.SubagentLink })),
);
// The bubble's delivery state reads receipts (the data layer): lazy, so the
// renderer itself imports none of it.
const DeliveryNote = lazy(() =>
	import("./DeliveryNote.tsx").then((m) => ({ default: m.DeliveryNote })),
);
// The end-of-turn change summary and its diffs: loaded with the first turn that edited files.
const TurnChanges = lazy(() =>
	import("./TurnChanges.tsx").then((m) => ({ default: m.TurnChanges })),
);

export type Variant = "phone" | "desktop";

export interface TranscriptProps {
	events: TranscriptEvent[];
	variant: Variant;
	/** The agent whose session this is: names and marks its turns. */
	agent?: {
		name: string;
		harness?: string | null;
		cwd?: string | null;
		/** Set for an agent row: its subagents' pages are linked from their cards. */
		id?: string;
		subagents?: { total: number };
		/** The agent's repo page: `#1234` in its prose links to that PR. */
		repoUrl?: string | null;
		/** `busy`: the last turn is still going (its change summary waits). */
		state?: string;
	} | null;
	/** Ids of events whose text is still growing (streaming). */
	streamingIds?: ReadonlySet<string>;
	/** The agent is working on a reply that hasn't produced text yet. */
	working?: boolean;
	className?: string;
	/**
	 * A message's actions (copy...), each platform its own way: called for
	 * every turn with text; whatever it returns renders in the turn's
	 * `.ds-msg-actions` slot (desktop: a hover/focus button). Return null to
	 * render nothing (phone: a long-press menu finds the turn by its
	 * `data-msg-id`). Without it, turns show no actions.
	 */
	messageActions?: (msg: MessageAction) => ReactNode;
	/** A prompt card shown right after the tool call that raised it. */
	promptAt?: { callId: string; node: ReactNode } | null;
}

/** What a message action gets: the turn, who wrote it, its exact text. */
export interface MessageAction {
	id: string;
	kind: "assistant" | "user" | "peer";
	/** Markdown for assistant turns, the message body otherwise. */
	text: string;
}

type Ctx = {
	variant: Variant;
	streaming: ReadonlySet<string>;
	agent: TranscriptProps["agent"];
	actions?: TranscriptProps["messageActions"];
	promptAt?: TranscriptProps["promptAt"];
	/** The operator's last sent message: its bubble shows the delivery state. */
	lastSentId?: string;
};
const NONE: ReadonlySet<string> = new Set();
const C = createContext<Ctx>({
	variant: "desktop",
	streaming: NONE,
	agent: null,
});

/** The transcript as chat: turns, bubbles, tool cards, reasoning. */
export const Transcript = memo(function Transcript({
	events,
	variant,
	agent,
	streamingIds = NONE,
	working,
	className,
	messageActions,
	promptAt,
}: TranscriptProps) {
	const messages = useMemo(() => toMessages(buildItems(events)), [events]);
	const lastSentId = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i]!;
			// The operator's sends: proven (their own turn) or not (the app's).
			// An optimistic line counts too (keyed by its own id until stamped).
			if (m.kind === "user" && m.ev.pulsar?.sender === "operator")
				return sentKey(m.ev);
			if (m.kind === "peer" && m.ev.pulsar?.sender === "app")
				return sentKey(m.ev);
		}
		return undefined;
	}, [messages]);
	// The last turn is still going: working, or stopped on a prompt for you.
	const busy = agent?.state === "busy" || agent?.state === "needs-you";
	const turns = useMemo(
		() => turnSummaries(messages, agent?.cwd, busy),
		[messages, agent?.cwd, busy],
	);
	// Pulsar messages by id: respond cards name the sender of what they answer.
	const known = useMemo(() => knownMessages(events), [events]);
	const ctx = useMemo(
		() => ({
			variant,
			streaming: streamingIds,
			agent,
			actions: messageActions,
			promptAt,
			lastSentId,
		}),
		[
			variant,
			streamingIds,
			// The fields the cards read (the row itself changes on every update).
			agent?.id,
			!!agent?.subagents,
			agent?.name,
			agent?.harness,
			agent?.cwd,
			agent?.repoUrl,
			messageActions,
			promptAt,
			lastSentId,
		],
	);
	const fileAgent = useMemo(
		() => (agent ? { id: agent.id, cwd: agent.cwd } : null),
		[agent?.id, agent?.cwd],
	);
	return (
		<C.Provider value={ctx}>
			<FileRefAgent.Provider value={fileAgent}>
				<PulsarMessages.Provider value={known}>
					<div
						className={`ds-conv ds-conv--${variant}${variant === "phone" ? " ds-phone" : ""}${className ? ` ${className}` : ""}`}
					>
						{messages.map((m, i) => (
							<MessageView
								key={m.id}
								m={m}
								prev={messages[i - 1]}
								changes={turns.get(m.id)}
							/>
						))}
						{working && <WorkingRow />}
					</div>
				</PulsarMessages.Provider>
			</FileRefAgent.Provider>
		</C.Provider>
	);
});

// ------------------------------------------------------------------ authorship

function Time({ ts }: { ts: number }) {
	if (!ts) return null;
	return (
		<time className="ds-time" dateTime={new Date(ts).toISOString()}>
			{clock(ts)}
		</time>
	);
}

/** Which sent message a bubble is: its Pulsar message id, else an optimistic line's own id. */
const sentKey = (ev: TranscriptEvent): string | undefined =>
	ev.pulsar?.messageId ?? (ev.id.startsWith(LOCAL_PREFIX) ? ev.id : undefined);

/**
 * The one line under a sent bubble, one state machine: an optimistic send
 * (data/pending.ts) says "Sending…", or "Not sent" with Retry and Delete
 * (it never reached the daemon); once the daemon accepted it (the message id is known), the
 * operator's last sent bubble shows its receipts (DeliveryNote: Sent →
 * Delivered → Read → Replied). The echo that replaces the optimistic line
 * keeps the same message id, so the note carries over.
 */
function BubbleState({ ev, last }: { ev: TranscriptEvent; last: boolean }) {
	const s = useLocalSend(ev.id);
	if (s?.state === "sending")
		return (
			<p className="ds-send-state muted small" data-send-state="sending">
				Sending…
			</p>
		);
	if (s?.state === "failed")
		return (
			<p
				className="ds-send-state ds-delivery is-failed small"
				role="alert"
				data-send-state="failed"
			>
				Not sent{s.error ? `: ${s.error}` : ""}.{" "}
				<button type="button" className="link" onClick={s.retry}>
					Retry
				</button>{" "}
				<button type="button" className="link" onClick={s.discard}>
					Delete
				</button>
			</p>
		);
	const mid = ev.pulsar?.messageId;
	// Only this tab's own sends: an old or foreign message's receipts may be gone.
	if (!last || !mid || !sentHere(mid)) return null;
	return (
		<Suspense fallback={<SentPlaceholder />}>
			<DeliveryNote messageId={mid} />
		</Suspense>
	);
}

function SentPlaceholder() {
	return (
		<p className="ds-delivery" aria-live="polite" data-state="sent">
			Sent
		</p>
	);
}

/** The platform's actions for a turn with text (see `messageActions`). */
function Actions({ msg }: { msg: MessageAction }) {
	const { actions } = useContext(C);
	const node = msg.text && actions ? actions(msg) : null;
	return node ? <div className="ds-msg-actions msg-actions">{node}</div> : null;
}

/**
 * An author line: one line, never wrapped. The name truncates with an
 * ellipsis, the time never does. On the phone the detail ("via Pulsar on
 * studio", "Another agent") hides behind a tap on the line.
 */
function AuthorLine({ end, children }: { end?: boolean; children: ReactNode }) {
	const { variant } = useContext(C);
	const [open, setOpen] = useState(false);
	const phone = variant === "phone";
	return (
		<div
			className={`ds-author${end ? " ds-author--end" : ""}${phone ? " has-detail" : ""}${open ? " is-open" : ""}`}
			onClick={phone ? () => setOpen(!open) : undefined}
		>
			{children}
		</div>
	);
}

function MessageView({
	m,
	prev,
	changes,
}: {
	m: ChatMessage;
	prev?: ChatMessage;
	/** What the turn this message ends changed (its last assistant message only). */
	changes?: TurnChangeSet;
}) {
	const { agent, variant, lastSentId } = useContext(C);
	switch (m.kind) {
		case "user": {
			const who = userAuthor(m.ev.from, m.ev.pulsar);
			// The phone's short form: the operator is "You".
			const name =
				variant === "phone" && m.ev.pulsar?.sender === "operator"
					? "You"
					: who.name;
			return (
				<div
					className="ev msg r-user ds-turn ds-turn--user"
					data-msg-id={m.id}
					data-pulsar-id={who.messageId}
				>
					<AuthorLine end>
						<span className="ds-author-name" title={who.name}>
							{name}
						</span>
						{who.via && (
							<span
								className="ds-author-via"
								title={
									who.messageId ? `Pulsar message ${who.messageId}` : undefined
								}
							>
								{who.via}
							</span>
						)}
						<Time ts={m.ev.ts} />
					</AuthorLine>
					<div
						className={`ds-bubble${m.ev.subtype ? ` is-${m.ev.subtype}` : ""}`}
					>
						<UserBody ev={m.ev} />
						<EventMedia ev={m.ev} />
					</div>
					<BubbleState ev={m.ev} last={sentKey(m.ev) === lastSentId} />
					<Actions msg={{ id: m.id, kind: "user", text: textOf(m.ev) }} />
				</div>
			);
		}
		case "peer": {
			const app = m.ev.pulsar?.sender === "app";
			const name = app ? APP_SENDER : peerFrom(m.ev.from);
			const text = textOf(m.ev);
			if (hasNotice(m.ev))
				return (
					<NoticeCard
						ev={m.ev}
						actions={<Actions msg={{ id: m.id, kind: "peer", text }} />}
					/>
				);
			return (
				<div
					className={`ev peer ds-turn ds-turn--peer${app ? " is-app" : ""}`}
					data-msg-id={m.id}
					data-pulsar-id={m.ev.pulsar?.messageId}
				>
					<AuthorLine>
						{!app && <AgentAvatar harness={name.split("@")[0]} size="xs" />}
						<span className="ds-author-name" title={name}>
							{name}
						</span>
						<span
							className="ds-author-via"
							title={
								m.ev.pulsar?.messageId
									? `Pulsar message ${m.ev.pulsar.messageId}`
									: undefined
							}
						>
							{app
								? m.ev.pulsar?.machine
									? `on ${m.ev.pulsar.machine}`
									: "Pulsar app"
								: "Another agent"}
						</span>
						<Time ts={m.ev.ts} />
					</AuthorLine>
					<div className="ds-peer-body">
						{/* Kept for search and tests: "from codex@apparish". */}
						<span className="sr-only">from {name}</span>
						{text && <TextWithFiles text={text} />}
						<EventMedia ev={m.ev} />
					</div>
					{app && <BubbleState ev={m.ev} last={sentKey(m.ev) === lastSentId} />}
					<Actions msg={{ id: m.id, kind: "peer", text }} />
				</div>
			);
		}
		case "system":
			return <SystemRow ev={m.ev} />;
		case "assistant": {
			const text = messageText(m);
			// A new author line only when the previous message wasn't this agent's.
			const showAuthor = prev?.kind !== "assistant";
			return (
				<div
					className="assistant-msg ds-turn ds-turn--assistant"
					data-msg-id={m.id}
				>
					{showAuthor && (
						<div className="ds-author">
							<AgentAvatar harness={agent?.harness} size="xs" />
							<span className="ds-author-name">
								{agent?.name ?? harnessName(agent?.harness)}
							</span>
							<Time ts={m.ts} />
						</div>
					)}
					<div className="ds-parts">
						{m.parts.map((p, i) => (
							<PartView key={p.key} part={p} next={m.parts[i + 1]} />
						))}
					</div>
					{changes && (
						<Suspense fallback={null}>
							<TurnChanges
								changes={changes}
								layout={variant === "desktop" ? "split" : "unified"}
								agentId={agent?.id}
							/>
						</Suspense>
					)}
					<Actions msg={{ id: m.id, kind: "assistant", text }} />
				</div>
			);
		}
	}
}

// ------------------------------------------------------------------ parts

function tsOf(p: Item | undefined): number | undefined {
	if (!p) return undefined;
	if (p.t === "tool") return (p.call ?? p.result)?.ts;
	if (p.t === "task") return p.call.ts;
	if (p.t === "side") return undefined;
	return p.ev.ts;
}

function PartView({ part, next }: { part: Item; next?: Item }) {
	const { streaming, variant, agent, promptAt } = useContext(C);
	const growing = (ev: TranscriptEvent) => streaming.has(ev.id);
	switch (part.t) {
		case "msg": {
			// The agent's own PRs (#1234) link to its repo; code stays as written.
			const raw = textOf(part.ev);
			const text =
				part.ev.role === "assistant" ? linkPrs(raw, agent?.repoUrl) : raw;
			const live = growing(part.ev);
			return (
				<div
					className={`ev msg r-${part.ev.role} ds-prose${live ? " streaming" : ""}`}
				>
					{text && (
						<MessageResponse
							isAnimating={live}
							caret={live ? "circle" : undefined}
						>
							{text}
						</MessageResponse>
					)}
					<EventMedia ev={part.ev} />
				</div>
			);
		}
		case "thinking": {
			const end = tsOf(next);
			return (
				<ReasoningRow
					text={part.ev.text}
					live={growing(part.ev)}
					harness={agent?.harness}
					hidden={part.ev.subtype === "hidden"}
					ms={end && end > part.ev.ts ? end - part.ev.ts : undefined}
				/>
			);
		}
		case "peer":
		case "system":
			return <SystemRow ev={part.ev} />;
		case "tool": {
			const card = (
				<ToolCard
					item={part}
					harness={agent?.harness}
					agentCwd={agent?.cwd}
					layout={variant === "desktop" ? "split" : "unified"}
					renderImages={(ev) => <EventMedia ev={ev} />}
				/>
			);
			return promptAt && part.call?.tool?.callId === promptAt.callId ? (
				<>
					{card}
					{promptAt.node}
				</>
			) : (
				card
			);
		}
		case "task":
			return (
				<SubagentCard
					title={
						describeCall(part.call.tool?.name ?? "Task", part.call.tool?.input)
							.target?.text || "Subagent"
					}
					steps={part.steps}
					tool={part.call.tool?.name}
					running={!part.result && !part.call.tool?.done}
					result={part.result?.text}
					failed={!!(part.result?.tool?.isError ?? part.call.tool?.isError)}
					link={
						agent?.id && agent.subagents && part.call.tool?.callId ? (
							<Suspense fallback={null}>
								<SubagentLink
									agentId={agent.id}
									callId={part.call.tool.callId}
								/>
							</Suspense>
						) : undefined
					}
				>
					{part.children.map((c, i) => (
						<PartView key={c.key} part={c} next={part.children[i + 1]} />
					))}
				</SubagentCard>
			);
		case "side":
			return (
				<SubagentCard title="Subagent" steps={part.steps}>
					{part.children.map((c, i) => (
						<PartView key={c.key} part={c} next={part.children[i + 1]} />
					))}
				</SubagentCard>
			);
	}
}

/** "Thought for 12 s", collapsed; "Thinking" with a shimmer while live. */
export function ReasoningRow({
	text,
	live,
	ms,
	hidden,
	harness,
	defaultOpen = false,
}: {
	text: string;
	live?: boolean;
	ms?: number;
	/** The model keeps its reasoning private: a quiet row with nothing to open. */
	hidden?: boolean;
	/** Whose thinking: Claude Code saves it only with showThinkingSummaries. */
	harness?: string | null;
	defaultOpen?: boolean;
}) {
	const [why, setWhy] = useState(false);
	const noteId = useId();
	let label = "Thought";
	if (live) label = "Thinking";
	else if (ms && ms >= 1000) label = `Thought for ${duration(ms)}`;
	if (hidden || !text.trim()) {
		// Nothing to open: no chevron, no hover. An info button says why.
		const note =
			harness === "claude"
				? "Claude Code didn't save this thinking. Turn on showThinkingSummaries in Claude Code's settings to see it in Pulsar."
				: "The model keeps its reasoning private, so there is nothing to show.";
		return (
			<div className="ev thinking ds-reason is-hidden">
				<div className="ds-reason-head">
					<BrainIcon aria-hidden="true" className="ds-reason-icon" />
					<span className={live ? "ds-shimmer" : undefined}>{label}</span>
					{!live && (
						<button
							type="button"
							className="ds-reason-info"
							aria-label="Why is there no thinking to show?"
							aria-expanded={why}
							aria-controls={noteId}
							title={note}
							onClick={() => setWhy(!why)}
						>
							<InfoIcon aria-hidden="true" />
						</button>
					)}
				</div>
				{why && (
					<p className="ds-reason-note" id={noteId} role="note">
						{note}
					</p>
				)}
			</div>
		);
	}
	return (
		<Collapsible.Root
			className="ev thinking ds-reason"
			defaultOpen={defaultOpen}
		>
			<Collapsible.Trigger className="ds-reason-head">
				<BrainIcon aria-hidden="true" className="ds-reason-icon" />
				<span className={live ? "ds-shimmer" : undefined}>{label}</span>
				<ChevronRightIcon aria-hidden="true" className="ds-reason-chev" />
			</Collapsible.Trigger>
			<Collapsible.Content className="ds-reason-body">
				<MessageResponse>{text}</MessageResponse>
			</Collapsible.Content>
		</Collapsible.Root>
	);
}

/** A subagent's run, folded: its steps render as a nested thread. */
export function SubagentCard({
	title,
	steps,
	running,
	result,
	failed,
	tool,
	link,
	children,
}: {
	title: string;
	/** Opens the subagent's own page, when Pulsar found it. */
	link?: ReactNode;
	/** The harness's tool name (`Task`, `Agent`), for `data-tool`. */
	tool?: string;
	steps: number;
	running?: boolean;
	result?: string;
	failed?: boolean;
	children: ReactNode;
}) {
	const background = !!result && /^Async agent launched/i.test(result);
	return (
		<Collapsible.Root
			className={`ev tool task ds-tool ds-task k-task${failed ? " is-error" : ""}`}
			data-tool={tool}
		>
			<Collapsible.Trigger className="ds-tool-head">
				<span className="ds-tool-icon" aria-hidden="true">
					<CornerDownRightIcon />
				</span>
				<span className="ds-tool-verb">Subagent</span>
				<span className="ds-tool-main">
					<span className="ds-tool-target">{title}</span>
				</span>
				<span className="ds-tool-meta">
					{(steps > 0 || background || failed) && (
						<span className={`ds-tool-sum${failed ? " is-error" : ""}`}>
							{steps > 0 && <span>{plural(steps, "step")}</span>}
							{background && <span>In background</span>}
							{failed && <span>Failed</span>}
						</span>
					)}
				</span>
				<span className="ds-tool-state" aria-hidden="true">
					{running ? <span className="ds-spin" /> : null}
				</span>
				{running && <span className="sr-only">, running</span>}
				<ChevronRightIcon className="ds-tool-chev" aria-hidden="true" />
			</Collapsible.Trigger>
			<Collapsible.Content className="ds-task-body">
				{link}
				<div className="ds-task-thread">{children}</div>
				{result && !background && (
					<div className="ds-task-result">
						<span className="ds-task-result-label">Result</span>
						<MessageResponse>{result}</MessageResponse>
					</div>
				)}
			</Collapsible.Content>
		</Collapsible.Root>
	);
}

/** "Working" with three soft dots, under the last turn. */
export function WorkingRow({ label = "Working" }: { label?: string }) {
	return (
		<div className="working ds-working" role="status">
			<span className="ds-dots" aria-hidden="true">
				<i />
				<i />
				<i />
			</span>
			<span>{label}…</span>
		</div>
	);
}

// ------------------------------------------------------------------ images

const hasNotice = (
	ev: TranscriptEvent,
): ev is TranscriptEvent & { notice: NonNullable<TranscriptEvent["notice"]> } =>
	!!ev.notice;

/** Event text without the daemon's `[image]` placeholder when images are attached. */
function textOf(ev: TranscriptEvent): string {
	return ev.images?.length || ev.documents?.length
		? ev.text.replace(/\[(image|document)\]/g, "").trim()
		: ev.text;
}

/** An image in the conversation (kept for callers of the old name). */
export function TranscriptImage({
	image,
}: {
	image: NonNullable<TranscriptEvent["images"]>[number];
}) {
	return <ImageThumb image={image} />;
}

/** A user turn's body: a slash command, a `!` shell command, or Markdown. */
/** A message's text, and the files it names (`Attached:` lines) as chips. */
function TextWithFiles({ text }: { text: string }) {
	const { text: body, files } = splitAttached(text);
	return (
		<>
			{body && <MessageResponse>{body}</MessageResponse>}
			{files.length > 0 && <AttachedFiles files={files} />}
		</>
	);
}

function UserBody({ ev }: { ev: TranscriptEvent }) {
	const text = textOf(ev);
	if (!text) return null;
	if (ev.subtype === "command") {
		const [cmd, ...rest] = text.split(" ");
		return (
			<p className="ds-slash">
				<code className="ds-slash-cmd">{cmd}</code>
				{rest.length > 0 && (
					<span className="ds-slash-args"> {rest.join(" ")}</span>
				)}
			</p>
		);
	}
	if (ev.subtype === "shell")
		return (
			<p className="ds-user-shell">
				<span className="ds-term-prompt" aria-hidden="true">
					$
				</span>
				<InlineCode code={text} lang="bash" className="ds-user-shell-cmd" />
			</p>
		);
	return <TextWithFiles text={text} />;
}

/**
 * A system event: a skipped-events gap, an interruption, a compaction (as
 * dividers), a finished background task (a notice), command output (a quiet
 * terminal), or plain text.
 */
export function SystemRow({ ev }: { ev: TranscriptEvent }) {
	if (hasNotice(ev)) return <NoticeCard ev={ev} />;
	if (isGap(ev))
		return (
			<div className="ev gap ds-divider" role="separator">
				<span>Some events were skipped</span>
			</div>
		);
	switch (ev.subtype) {
		case "interrupted":
			return (
				<div className="ev system ds-divider is-interrupted" role="separator">
					<span>
						<CircleStopIcon aria-hidden="true" />
						Interrupted
					</span>
				</div>
			);
		case "compacted":
			return (
				<div className="ev system ds-divider is-compacted" role="separator">
					<span>
						<FoldVerticalIcon aria-hidden="true" />
						{ev.text === "Conversation compacted" || !ev.text.trim()
							? "Earlier messages were summarized"
							: ev.text}
					</span>
				</div>
			);
		case "task":
			return (
				<div className="ev system ds-system ds-notice" role="status">
					<BellIcon aria-hidden="true" />
					<span>{ev.text}</span>
				</div>
			);
		case "command":
		case "shell":
			return (
				<div className="ev system ds-system-out">
					<CodeBlock
						code={ev.text}
						tone="terminal"
						title={ev.subtype === "shell" ? "Shell output" : "Command output"}
						maxLines={10}
					/>
				</div>
			);
		default:
			return <div className="ev system ds-system">{ev.text}</div>;
	}
}
