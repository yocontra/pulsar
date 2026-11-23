import {
	lazy,
	Suspense,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { ApiError } from "../api/client.ts";
import type { AgentRow } from "../api/types.ts";
import { PromptInline, promptCallId } from "../approval/PromptInline.tsx";
import { Composer } from "../components/Composer.tsx";
import { useAgent, useLiveEvent, useTranscript } from "../data/index.ts";
import { observer } from "../lib/signals.ts";
import {
	approvalItem,
	findAgent,
	rememberAgent,
	terminalItem,
} from "../lib/store.ts";
import {
	ConversationView,
	JumpToLatest,
	TranscriptSkeleton,
} from "./ConversationView.tsx";
import { Transcript, type TranscriptProps } from "./Transcript.tsx";
import { TranscriptMissingNotice } from "./TranscriptMissing.tsx";

const TerminalCard = lazy(() => import("../approval/TerminalCard.tsx"));

const NONE: ReadonlySet<string> = new Set();

/** At most this many events in the DOM; older ones behind "load earlier". */
const WINDOW = 300;

function SessionViewImpl({
	id,
	mobile,
	inline,
	messageActions,
}: {
	id: string;
	/**
	 * The platform shell draws the header and the approval surface itself
	 * (desktop: components/desktop/SessionDesktop.tsx; phone: mobile/AgentPage.tsx).
	 */
	mobile: boolean;
	/** Shown after the last turn (the desktop's approval notice). */
	inline?: React.ReactNode;
	/** Per-message actions (copy...); see Transcript's `messageActions`. */
	messageActions?: TranscriptProps["messageActions"];
}) {
	// The transcript lives in the query cache (data/hooks.ts useTranscript):
	// a revisit or a hover prefetch shows it at once, refetching behind it,
	// and an optimistic send lands in it.
	const live = findAgent(id);
	const row = useAgent(id).data;
	const agent: AgentRow | null = row ?? live;
	const t = useTranscript(id);
	const events = t.events;
	const err =
		t.error && !t.data
			? t.error instanceof ApiError
				? { code: t.error.code, msg: t.error.message }
				: { msg: "Couldn't load this session" }
			: null;
	const loading = t.isPending;
	const available = t.available && (agent?.hasTranscript ?? true);
	// Why there is no transcript, from the page (never from a cached row
	// alone). A fresh row whose harness keeps none settles it for a daemon
	// too old to say `missing: unsupported`.
	const missing =
		t.missing && row?.hasTranscript === false ? "unsupported" : t.missing;
	const cursor = t.cursor;
	const [start, setStart] = useState(() => Math.max(0, events.length - WINDOW));
	// Text a live event replaced in place is still streaming; it settles
	// once no update has come for a moment.
	const [streaming, setStreaming] = useState<ReadonlySet<string>>(NONE);
	const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const atEnd = useRef(true);
	/** Ids shown at the last render: a live event with one of them grew. */
	const known = useRef<ReadonlySet<string>>(NONE);
	known.current = useMemo(() => new Set(events.map((e) => e.id)), [events]);

	useEffect(() => {
		if (row) rememberAgent(row);
	}, [row]);
	useEffect(() => {
		atEnd.current = true;
		setStart(Math.max(0, events.length - WINDOW));
		setStreaming(NONE);
		// An image 404 means the daemon dropped the id: refetch, at most every 10 s.
		let lastStale = 0;
		const stale = () => {
			if (Date.now() - lastStale < 10_000) return;
			lastStale = Date.now();
			void t.refetch();
		};
		addEventListener("pulsar:transcript-stale", stale);
		return () => {
			removeEventListener("pulsar:transcript-stale", stale);
			clearTimeout(settle.current);
		};
	}, [id]);
	// Following the end: the window moves with new events.
	useEffect(() => {
		if (atEnd.current) setStart(Math.max(0, events.length - WINDOW));
	}, [events.length]);
	// Find in messages (features/search) asks to show one event: move the
	// window to it once the transcript holds it.
	const [show, setShow] = useState<string | null>(null);
	useEffect(() => {
		const on = (e: Event) => {
			const d = (e as CustomEvent<{ agentId: string; eventId: string }>).detail;
			if (d?.agentId === id) setShow(d.eventId);
		};
		addEventListener("pulsar:show-event", on);
		return () => removeEventListener("pulsar:show-event", on);
	}, [id]);
	useEffect(() => {
		if (!show) return;
		const i = events.findIndex((e) => e.id === show);
		if (i < 0) return;
		setShow(null);
		atEnd.current = false;
		setStart(
			Math.max(0, Math.min(i - Math.floor(WINDOW / 2), events.length - WINDOW)),
		);
	}, [show, events]);
	useLiveEvent("transcript", ({ agentId, events: batch }) => {
		if (agentId !== id) return;
		const grew = batch
			.filter(
				(e) =>
					known.current.has(e.id) &&
					(e.kind === "text" || e.kind === "thinking"),
			)
			.map((e) => e.id);
		if (!grew.length) return;
		setStreaming(new Set(grew));
		clearTimeout(settle.current);
		settle.current = setTimeout(() => setStreaming(NONE), 1500);
	});

	// "Load earlier" keeps the operator's place: the message at the top of
	// the screen stays where it was while earlier ones land above it. (Scroll
	// anchoring can't: the button sits at scroll offset 0, where none applies.)
	const keep = useRef<{
		marks: { el: Element; top: number }[];
		sc: HTMLElement;
	} | null>(null);
	const loadEarlier = async (e: React.MouseEvent<HTMLButtonElement>) => {
		atEnd.current = false;
		const sc = e.currentTarget.closest<HTMLElement>(".ds-scroller > div");
		if (sc) {
			// The turns whose top is on screen. The first turn may be replaced
			// (earlier events can join it, which changes its key); others stay.
			const box = sc.getBoundingClientRect();
			const marks = Array.from(sc.querySelectorAll(".ds-conv > *"))
				.map((el) => ({ el, top: el.getBoundingClientRect().top }))
				.filter((m) => m.top >= box.top && m.top < box.bottom)
				.slice(0, 6);
			keep.current = marks.length ? { marks, sc } : null;
		}
		try {
			if (begin > 0) setStart(Math.max(0, begin - 100));
			else if (cursor) setStart(Math.max(0, (await t.loadEarlier()) - 100));
		} finally {
			// Content above settles over a few frames (code, images): hold the
			// place until then.
			setTimeout(() => {
				keep.current = null;
			}, 1000);
		}
	};

	const begin = atEnd.current ? Math.max(0, events.length - WINDOW) : start;
	useLayoutEffect(() => {
		const m = keep.current?.marks.find((m) => m.el.isConnected);
		if (!m) return;
		const moved = m.el.getBoundingClientRect().top - m.top;
		if (Math.abs(moved) >= 1) keep.current!.sc.scrollTop += moved;
	});
	const windowed = useMemo(
		() => events.slice(begin, begin + WINDOW),
		[events, begin],
	);
	const att = approvalItem(id);
	// The prompt card: at the call that raised it, else after the last turn.
	const ap = att?.approval;
	const callId = useMemo(
		() => (ap ? promptCallId(windowed, ap) : null),
		[windowed, ap?.requestId],
	);
	const prompt = att && ap ? <PromptInline item={att} mobile={mobile} /> : null;
	// A prompt only the terminal answers: read-only, after the last turn.
	const term = prompt ? undefined : terminalItem(id);
	const promptAt = useMemo(
		() => (callId && prompt ? { callId, node: prompt } : null),
		[callId, att, ap?.state, ap?.outcome, mobile],
	);
	const unreachable = err?.code === "unreachable";
	const behind = begin + WINDOW < events.length;
	const last = windowed[windowed.length - 1];
	const working = agent?.state === "busy" && last?.role === "user";

	return (
		<section
			className={`session${mobile ? " mobile" : ""}`}
			aria-label={`Session ${agent?.name ?? ""}`}
		>
			<ConversationView
				variant={mobile ? "phone" : "desktop"}
				label={`Conversation with ${agent?.name ?? "agent"}`}
				pill={
					<FollowTracker
						atEnd={atEnd}
						behind={behind}
						onLatest={() => setStart(Math.max(0, events.length - WINDOW))}
					/>
				}
			>
				{(begin > 0 || cursor) && (
					<button
						type="button"
						className="ds-load-earlier load-earlier"
						onClick={loadEarlier}
					>
						Load earlier messages
					</button>
				)}
				{loading && events.length === 0 && (
					<TranscriptSkeleton variant={mobile ? "phone" : "desktop"} />
				)}
				{unreachable && agent && (
					<div className="ds-banner warn banner" role="status">
						<strong>{agent.machine} is unreachable.</strong> The transcript
						isn't available right now. Messages you send will wait and arrive
						when it's back.
					</div>
				)}
				{err && !unreachable && (
					<div className="ds-banner error banner" role="alert">
						{err.msg}{" "}
						<button
							type="button"
							className="link"
							onClick={() => void t.refetch()}
						>
							Retry
						</button>
					</div>
				)}
				{agent && missing && !loading && events.length === 0 && (
					<TranscriptMissingNotice
						key={id}
						missing={missing}
						harness={agent.harness}
						subject="agent"
						variant={mobile ? "phone" : "desktop"}
						onRetry={() => void t.refetch()}
					/>
				)}
				<Transcript
					events={windowed}
					variant={mobile ? "phone" : "desktop"}
					agent={agent}
					streamingIds={streaming}
					working={working}
					messageActions={messageActions}
					promptAt={promptAt}
				/>
				{!promptAt && prompt}
				{term && (
					<Suspense fallback={null}>
						<TerminalCard item={term} mobile={mobile} />
					</Suspense>
				)}
				{inline}
			</ConversationView>
			{agent && (
				<Composer
					key={agent.id}
					target={{ kind: "agent", agent }}
					showTo={!mobile}
					compact={mobile}
					placeholder={mobile ? "Message" : `Message ${agent.name}…`}
					autofocus={!mobile}
					bubbleReceipts={agent.hasTranscript && available}
				/>
			)}
		</section>
	);
}

/**
 * stick-to-bottom follows new events while the reader is at the bottom. When
 * they have scrolled up (or loaded earlier events), keep the render window
 * where it is and offer a way back.
 */
function FollowTracker({
	atEnd,
	behind,
	onLatest,
}: {
	atEnd: { current: boolean };
	behind: boolean;
	onLatest: () => void;
}) {
	const { isAtBottom } = useStickToBottomContext();
	useEffect(() => {
		if (isAtBottom && !behind) atEnd.current = true;
		else if (!isAtBottom) atEnd.current = false;
	}, [isAtBottom, behind]);
	return (
		<JumpToLatest
			force={behind}
			onClick={() => {
				atEnd.current = true;
				if (behind) onLatest();
			}}
		/>
	);
}

export default observer(SessionViewImpl);
