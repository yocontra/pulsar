/**
 * Find in messages, in a session: a header button (session.header slot) and
 * a find bar over the conversation (top right on desktop, along the top on
 * the phone). The daemon searches the agent's whole indexed transcript
 * (`GET /search/messages?agent=`); Previous / Next step through the matches
 * oldest to newest, loading older pages until the match is on screen.
 */
import {
	ChevronDownIcon,
	ChevronUpIcon,
	SearchIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentRow } from "../../api/types.ts";
import { observer } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";
import { IonButton } from "../../mobile/ionic.ts";
import {
	type MessageHit,
	queryWords,
	searchable,
	searchMessages,
} from "./api.ts";
import { clearHighlight, highlight, reveal } from "./reveal.ts";
import { closeFind, type FindState, find, openFind } from "./state.ts";
import "./search.css";

type Status = "idle" | "loading" | "ready" | "error";

function FindButtonImpl({
	agent,
	mobile,
}: {
	agent: AgentRow;
	mobile: boolean;
}) {
	const ref = useRef<HTMLElement | null>(null);
	const [root, setRoot] = useState<Element | null>(null);
	const state = find.value;
	const open = state?.agentId === agent.id;
	// Leaving the session closes its find bar (reopening the agent starts at its end).
	useEffect(
		() => () => {
			if (find.value?.agentId === agent.id) closeFind();
		},
		[agent.id],
	);
	useEffect(() => {
		if (!open) return;
		// The session this header belongs to (a phone keeps earlier pages in the DOM).
		const shell = ref.current?.closest(".d-session, .ion-page");
		setRoot(shell?.querySelector("section.session") ?? null);
	}, [open, agent.id]);
	const toggle = () => (open ? closeFind() : openFind(agent.id));
	const off = !can("search");
	const disabled = off || !agent.hasTranscript;
	const why = off
		? "Message search is off on this machine (PULSAR_NO_SEARCH)"
		: !agent.hasTranscript
			? "This agent's harness keeps no transcript"
			: undefined;
	const button = mobile ? (
		<span
			ref={(el) => {
				ref.current = el;
			}}
			title={why}
		>
			<IonButton
				aria-label="Find in messages"
				aria-pressed={open}
				disabled={disabled}
				onClick={toggle}
			>
				<SearchIcon />
			</IonButton>
		</span>
	) : (
		<span
			ref={(el) => {
				ref.current = el;
			}}
			title={why ?? "Find in messages"}
		>
			<button
				type="button"
				className={`d-btn sm msr-toggle${open ? " on" : ""}`}
				aria-label="Find in messages"
				aria-pressed={open}
				disabled={disabled}
				onClick={toggle}
			>
				<SearchIcon aria-hidden="true" />
				Find
			</button>
		</span>
	);
	return (
		<>
			{button}
			{open &&
				state &&
				root &&
				createPortal(
					<Bar key={state.seq} state={state} root={root} mobile={mobile} />,
					root,
				)}
		</>
	);
}

export default observer(FindButtonImpl);

function Bar({
	state,
	root,
	mobile,
}: {
	state: FindState;
	root: Element;
	mobile: boolean;
}) {
	const [q, setQ] = useState(state.q);
	const [hits, setHits] = useState<MessageHit[]>([]);
	const [status, setStatus] = useState<Status>("idle");
	const [idx, setIdx] = useState(-1);
	const [retry, setRetry] = useState(0);
	const bar = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	/** The hit to land on, once (the one chosen in search results). */
	const target = useRef(state.eventId);
	const words = useMemo(() => queryWords(q), [q]);
	const ok = searchable(q);
	// The phone's nav bar overlays the conversation: sit just below it.
	const [top, setTop] = useState<number | null>(null);
	useEffect(() => {
		if (!mobile) return;
		const head = root.closest(".ion-page")?.querySelector("ion-header");
		if (!head) return;
		const place = () =>
			setTop(
				Math.max(
					8,
					head.getBoundingClientRect().bottom -
						root.getBoundingClientRect().top +
						8,
				),
			);
		place();
		const ro = new ResizeObserver(place);
		ro.observe(head);
		return () => ro.disconnect();
	}, [mobile, root]);

	useEffect(() => {
		input.current?.focus();
		return clearHighlight;
	}, []);

	useEffect(() => {
		if (!ok) {
			setHits([]);
			setIdx(-1);
			setStatus("idle");
			clearHighlight();
			return;
		}
		const ctrl = new AbortController();
		setStatus("loading");
		const t = setTimeout(
			() => {
				searchMessages(q, { agent: state.agentId, signal: ctrl.signal })
					.then((r) => {
						if (ctrl.signal.aborted) return;
						const at = target.current
							? r.hits.findIndex((h) => h.eventId === target.current)
							: -1;
						target.current = null;
						setHits(r.hits);
						setIdx(at >= 0 ? at : r.hits.length - 1);
						setStatus("ready");
					})
					.catch(() => {
						if (ctrl.signal.aborted) return;
						setHits([]);
						setIdx(-1);
						setStatus("error");
					});
			},
			target.current ? 0 : 200,
		);
		return () => {
			clearTimeout(t);
			ctrl.abort();
		};
	}, [q, ok, state.agentId, retry]);

	// Show the current match, then mark the words on screen.
	const hit = idx >= 0 ? hits[idx] : undefined;
	useEffect(() => {
		if (!hit) {
			// No matches (or an error): nothing stays marked.
			clearHighlight();
			return;
		}
		const ctrl = new AbortController();
		reveal(root, state.agentId, hit.eventId, ctrl.signal)
			// Older pages failed to load: as if the match isn't on screen.
			.catch(() => null)
			.then((el) => {
				if (!ctrl.signal.aborted) highlight(root, el, words, bar.current);
			});
		return () => ctrl.abort();
	}, [hit?.eventId, root, state.agentId, words]);

	const n = hits.length;
	const step = (d: 1 | -1) => {
		if (n > 0) setIdx((i) => (i + d + n) % n);
	};
	const busy = status === "loading";
	const label = !q.trim()
		? ""
		: !ok
			? "3+ letters"
			: busy
				? "Searching…"
				: status === "error"
					? "Couldn't search"
					: n === 0
						? "No matches"
						: `${idx + 1} of ${n}`;
	const spoken =
		status === "error"
			? "Couldn't search messages"
			: status === "ready"
				? n === 0
					? "No matches"
					: `Match ${idx + 1} of ${n}`
				: "";
	const navOff = n === 0 || busy;
	return (
		<div
			ref={bar}
			className={`msr-find${mobile ? " is-phone" : ""}`}
			style={top === null ? undefined : { top }}
			role="search"
			aria-label="Find in messages"
			aria-busy={busy}
		>
			<SearchIcon className="msr-find-ico" aria-hidden="true" />
			<input
				ref={input}
				type="search"
				value={q}
				placeholder="Find in messages"
				aria-label="Find in messages"
				maxLength={200}
				spellCheck={false}
				autoComplete="off"
				enterKeyHint="search"
				onChange={(e) => setQ(e.target.value)}
				onKeyDown={(e) => {
					if (e.nativeEvent.isComposing) return;
					if (e.key === "Enter") {
						e.preventDefault();
						step(e.shiftKey ? -1 : 1);
					} else if (e.key === "Escape") {
						e.preventDefault();
						closeFind();
					}
				}}
			/>
			<span className="msr-sr" aria-live="polite">
				{spoken}
			</span>
			<span
				className={`msr-count${n === 0 && status === "ready" ? " is-none" : ""}`}
				aria-hidden="true"
			>
				{label}
			</span>
			{status === "error" && (
				<button
					type="button"
					className="msr-btn msr-retry"
					onClick={() => setRetry((r) => r + 1)}
				>
					Retry
				</button>
			)}
			<button
				type="button"
				className="msr-btn"
				aria-label="Previous match"
				title={navOff ? "No matches to go to" : "Previous match (Shift+Enter)"}
				disabled={navOff}
				onClick={() => step(-1)}
			>
				<ChevronUpIcon aria-hidden="true" />
			</button>
			<button
				type="button"
				className="msr-btn"
				aria-label="Next match"
				title={navOff ? "No matches to go to" : "Next match (Enter)"}
				disabled={navOff}
				onClick={() => step(1)}
			>
				<ChevronDownIcon aria-hidden="true" />
			</button>
			<button
				type="button"
				className="msr-btn"
				aria-label="Close find"
				title="Close (Esc)"
				onClick={closeFind}
			>
				<XIcon aria-hidden="true" />
			</button>
		</div>
	);
}
