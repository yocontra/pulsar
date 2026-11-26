/**
 * Broadcast: say who, see who, write, send; then watch it land.
 *
 * The audience reads as a sentence ("Send to Claude Code agents in apparish
 * on studio or desk"), each part a token you can edit or remove, with the
 * exact selector one click away. Below it the audience map: one card per
 * machine with its agents as harness avatars, each carrying a wake glyph
 * (wakes now, to the inbox, held), and the counts in words. The composer
 * sits at the bottom with the 3-way priority. After sending, the same map
 * becomes the results board: avatars light up as receipts arrive.
 *
 * Server semantics are unchanged: the selector, the dry run's resolve token
 * at send, the confirmation for big sends (one click), Prove Human through
 * the send path. Lazy-loaded (route chunk).
 */
import { PlusIcon, SearchIcon, SendIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, ProveCancelled } from "../api/client.ts";
import type {
	AgentRow,
	AgentsPage,
	Facet,
	FacetKey,
	Priority,
	ReceiptRow,
	ReceiptsPage,
	SendRequest,
	SendResult,
} from "../api/types.ts";
import { CloseX } from "../components/CloseX.tsx";
import {
	ConfirmDialog,
	confirmTier,
	PRIORITY_HINT,
	PriorityPicker,
	Receipts,
	reconfirmText,
	sendConfirmed,
	tierFor,
} from "../components/Composer.tsx";
import { Layer } from "../components/desktop/Layer.tsx";
import { AgentAvatar, harnessName } from "../ds/index.ts";
import {
	num,
	plural,
	RECEIPT_WORDS,
	shortModel,
	wakeFor,
} from "../lib/format.ts";
import { useInFlight } from "../lib/inflight.ts";
import { back } from "../lib/router.ts";
import {
	addTerm,
	has,
	isAll,
	parse,
	type Query,
	serialize,
	toggle,
} from "../lib/selector.ts";
import { observer } from "../lib/signals.ts";
import {
	builderQuery,
	builderResults,
	onReceipts,
	queryCount,
	watchReceipts,
} from "../lib/store.ts";
import { proveAsk } from "../prove/state.ts";
import { describe, type Token } from "./describe.ts";
import "./broadcast.css";

const FACETS = [
	"machine",
	"project",
	"harness",
	"model",
	"status",
	"role",
] as const;
const PAGE = 50;
/** Machine cards on the map; the rest fold into one "more" card. */
const CARDS = 8;
/** Avatars per machine card; the rest read "+N". */
const FACES = 12;

function useDebounced<T>(value: T, ms: number) {
	const [v, setV] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setV(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return v;
}

const FACET_NAMES: Record<(typeof FACETS)[number], string> = {
	machine: "Machine",
	project: "Project",
	harness: "Harness",
	model: "Model",
	status: "Status",
	role: "Role",
};

const STATUS_NAMES: Record<string, string> = {
	busy: "Working",
	idle: "Idle",
	gone: "Offline",
	unknown: "Unknown",
};

function facetLabel(facet: string, value: string) {
	if (facet === "model") return shortModel(value);
	if (facet === "status") return STATUS_NAMES[value] ?? value;
	if (facet === "harness") return harnessName(value);
	return value;
}

/** Wake glyphs: always a shape and a word (tokens.css rule). */
const WAKE = {
	wakes: { word: "Wake now", cls: "g-wake" },
	"inbox-only": { word: "To inbox", cls: "g-inbox" },
	held: { word: "Held", cls: "g-held" },
	refuses: { word: "Refuse", cls: "g-refused" },
	queued: { word: "Queued", cls: "g-queued" },
} as const;
type WakeKey = keyof typeof WAKE;

/** Receipt glyphs on the results board. */
const STATE_CLS: Record<string, string> = {
	queued: "g-queued",
	sent: "g-inbox",
	delivered: "g-wake",
	read: "g-read",
	replied: "g-replied",
	held: "g-held",
	refused: "g-refused",
	failed: "g-failed",
};

function BuilderImpl({
	selector: initial,
	mobile,
}: {
	selector: string;
	mobile: boolean;
}) {
	const [query, setQuery] = useState<Query>(() => parse(initial).query);
	const [advanced, setAdvanced] = useState<string | null>(null);
	const [selOpen, setSelOpen] = useState(false);
	const [who, setWho] = useState<string | null>(null);
	const [addText, setAddText] = useState("");
	const [facets, setFacets] = useState<Record<string, Facet>>({});
	const [facetSearch, setFacetSearch] = useState<Record<string, string>>({});
	const [picker, setPicker] = useState<string | null>(null);
	const [preview, setPreview] = useState<AgentsPage | null>(null);
	const [items, setItems] = useState<AgentRow[]>([]);
	const [body, setBody] = useState("");
	const [priority, setPriority] = useState<Priority>("fyi");
	const [expectReply, setExpectReply] = useState(true);
	const [dry, setDry] = useState<SendResult | null>(null);
	const [drift, setDrift] = useState(false);
	const [phase, setPhase] = useState<
		"idle" | "checking" | "confirm" | "sending"
	>("idle");
	// A send in flight can't be closed; Prove Human, when the send asks for
	// it, sits on top and has its own X.
	useInFlight(phase === "sending" && !proveAsk.value);
	const [error, setError] = useState<string | null>(null);
	/** The send that failed (same client id), for Retry: the daemon sends it once. */
	const [failed, setFailed] = useState<SendRequest | null>(null);
	const [sent, setSent] = useState<{
		id: string;
		total: number;
		req: SendRequest;
	} | null>(null);

	const selector = serialize(query);
	const debounced = useDebounced(selector, 150);
	const advParse = advanced !== null ? parse(advanced) : null;

	// Live count and preview window over the stream.
	useEffect(() => {
		builderQuery.value = debounced;
		builderResults.value = {
			selector: debounced,
			sort: "attention",
			offset: 0,
			limit: PAGE,
		};
		return () => {
			builderQuery.value = null;
			builderResults.value = null;
		};
	}, [debounced]);

	// The audience's first page: counts, wake totals, avatar samples.
	useEffect(() => {
		const ctrl = new AbortController();
		setDry(null);
		api
			.agents(
				{ selector: debounced, limit: PAGE, sort: "attention" },
				ctrl.signal,
			)
			.then((p) => {
				setPreview(p);
				setItems(p.items);
			})
			.catch(() => {});
		return () => ctrl.abort();
	}, [debounced]);

	// A count change from the stream refreshes it.
	const live = queryCount.value;
	useEffect(() => {
		if (
			live &&
			live.selector === debounced &&
			preview &&
			live.total !== preview.total
		)
			api
				.agents({ selector: debounced, limit: PAGE, sort: "attention" })
				.then((p) => {
					setPreview(p);
					setItems(p.items);
				});
	}, [live]);

	// Facet counts: each facet counts under the other facets' filters.
	const fs = useDebounced(facetSearch, 150);
	useEffect(() => {
		const ctrl = new AbortController();
		for (const f of FACETS) {
			api
				.facets(
					{
						selector: serialize(query, f),
						facet: f,
						q: fs[f],
						top: fs[f] ? 30 : f === "machine" ? 24 : 8,
					},
					ctrl.signal,
				)
				.then((r) => setFacets((prev) => ({ ...prev, [f]: r })))
				.catch(() => {});
		}
		return () => ctrl.abort();
	}, [debounced, fs]);

	const everyone = isAll(query);
	const total = preview?.total;
	const request = (): SendRequest => ({
		to: selector,
		body: body.trim(),
		priority,
		expectReply,
	});

	const dryRun = async () => {
		setPhase("checking");
		setError(null);
		try {
			const r = await api.send({ ...request(), dryRun: true });
			setDry(r);
			setDrift(false);
			setPhase("idle");
			return r;
		} catch (err) {
			setError(
				err instanceof ApiError ? err.message : "Couldn't check the recipients",
			);
			setPhase("idle");
			return null;
		}
	};

	/**
	 * Pending, never optimistic: who gets it is the daemon's answer. A failure
	 * says why, with Retry (same client id: never sent twice).
	 */
	const send = async (token?: string, again?: SendRequest) => {
		setPhase("sending");
		setError(null);
		setFailed(null);
		const data = await import("../data/index.ts");
		const req: SendRequest = again ?? {
			...request(),
			resolveToken: token,
			clientId: data.newClientId(),
		};
		try {
			const r = await data.sendMessage({ req });
			if (r.drift) {
				setDry(r);
				setDrift(true);
				setPhase("confirm");
				return;
			}
			setSent({ id: r.messageId!, total: r.total, req });
			setPhase("idle");
		} catch (err) {
			setPhase("idle");
			if (err instanceof ProveCancelled) return;
			setError(err instanceof ApiError ? err.message : "Send failed");
			setFailed(req);
		}
	};

	/** The dry run happens here, folded into Send: its token goes with the send. */
	const startSend = async () => {
		if (!body.trim()) {
			setError("Write a message first.");
			document.getElementById("bc-body")?.focus();
			return;
		}
		const r = await dryRun();
		if (!r) return;
		if (r.total === 0) {
			setError("No agents match.");
			return;
		}
		const tier = tierFor(r.total, r.machines, everyone);
		if (tier === "direct") await send(r.resolveToken);
		else setPhase("confirm");
	};

	const openPicker = (f: string) => {
		history.pushState(
			// `sub`: closing the sheet pops this entry with it.
			{ ...(history.state ?? {}), picker: f, sub: true },
			"",
			location.hash,
		);
		setPicker(f);
	};
	useEffect(() => {
		const onPop = () => setPicker(null);
		addEventListener("popstate", onPop);
		return () => removeEventListener("popstate", onPop);
	}, []);

	const remove = (t: Token) =>
		setQuery(
			t.kind === "chip"
				? { ...query, chips: query.chips.filter((c) => c.key !== t.key) }
				: t.kind === "text"
					? { ...query, text: query.text.filter((_, j) => j !== t.index) }
					: { ...query, raw: query.raw.filter((_, j) => j !== t.index) },
		);

	const resend = (ids: string[]) =>
		sent &&
		sendConfirmed({
			...sent.req,
			to: undefined,
			ids,
			resolveToken: undefined,
		}).then(
			(r) =>
				r.messageId &&
				setSent({ id: r.messageId, total: r.total, req: { ...sent.req, ids } }),
		);

	const wake = useWakeCounts(preview?.totals, priority);

	// Avatars we already know, for the results board (harness by id).
	const known = useMemo(
		() => new Map(items.map((a) => [a.id, a] as const)),
		[items],
	);

	// ------------------------------------------------------------ results
	if (sent) {
		const board = (
			<div className={`bc bc-results${mobile ? " bc--phone" : ""}`}>
				<header className="bc-head">
					<p className="bc-kicker">Broadcast results</p>
					<h2 className="bc-sentence">Sent to {plural(sent.total, "agent")}</h2>
					{sent.req.to && sent.req.to !== "*" && (
						<p className="bc-sel">
							<code>{sent.req.to}</code>
						</p>
					)}
				</header>
				<ResultsBoard
					messageId={sent.id}
					total={sent.total}
					known={known}
					mobile={mobile}
				/>
				<section className="bc-replies" aria-label="Replies">
					<Receipts
						messageId={sent.id}
						total={sent.total}
						expectReply={sent.req.expectReply ?? false}
						full
						onResend={(ids) => void resend(ids)}
					/>
				</section>
				<footer className="bc-foot">
					<span className="spacer" />
					<button
						type="button"
						className={mobile ? "m-btn gray" : "d-btn"}
						onClick={() => {
							setSent(null);
							setBody("");
						}}
					>
						New broadcast
					</button>
				</footer>
			</div>
		);
		return mobile ? (
			<BuilderShell mobile title="Broadcast results">
				{board}
			</BuilderShell>
		) : (
			<Layer
				title="Broadcast results"
				hideTitle
				onClose={back}
				className="bc-layer"
			>
				{board}
			</Layer>
		);
	}

	// ------------------------------------------------------------ compose
	const tier = dry ? confirmTier(dry, drift, everyone) : null;
	const { subject, tokens } = describe(query, facetLabel);

	const sentenceEl = (
		<h2 className="bc-sentence" id="bc-sentence">
			<span className="bc-send">Send to</span>{" "}
			{subject ? (
				<TokenView
					t={subject}
					onEdit={() => setWho("harness")}
					onRemove={() => remove(subject)}
				/>
			) : (
				<span className="bc-tok is-fixed">
					<span className="bc-tok-v">
						{tokens.length ? "all agents" : "everyone"}
					</span>
				</span>
			)}
			{tokens.map((t) => (
				<TokenView
					key={`${t.kind}:${t.key}:${t.index ?? ""}`}
					t={t}
					onEdit={() =>
						t.kind === "chip" && (FACETS as readonly string[]).includes(t.key)
							? setWho(t.key)
							: setSelOpen(true)
					}
					onRemove={() => remove(t)}
				/>
			))}{" "}
			<button
				type="button"
				className="bc-add"
				aria-expanded={who !== null}
				aria-controls="bc-who"
				onClick={() => setWho(who === null ? "" : null)}
			>
				<PlusIcon aria-hidden="true" />
				{everyone ? "Narrow it down" : "Add"}
			</button>
		</h2>
	);

	const selectorEl = !mobile && (
		<div className="bc-sel">
			<code title="The exact selector">{selector}</code>
			<button
				type="button"
				className="bc-link"
				aria-expanded={selOpen}
				onClick={() => setSelOpen(!selOpen)}
			>
				{selOpen ? "Done" : "Edit selector"}
			</button>
			{selOpen && (
				<label className="bc-sel-edit">
					<input
						className="d-input"
						value={advanced ?? selector}
						aria-label="Selector"
						spellCheck={false}
						// biome-ignore lint/a11y/noAutofocus: opened to type in it
						autoFocus
						onFocus={() => setAdvanced(selector)}
						onChange={(e) => {
							const v = (e.target as HTMLInputElement).value;
							setAdvanced(v);
							const p = parse(v);
							if (!p.error) setQuery(p.query);
						}}
						onBlur={() => setAdvanced(null)}
					/>
					<span
						className={`validity${advParse?.error ? " bad" : ""}`}
						data-testid="validity"
					>
						{advParse?.error
							? advParse.error
							: total === undefined
								? ""
								: `Valid, ${num(total)}`}
					</span>
				</label>
			)}
		</div>
	);

	const whoEl = who !== null && (
		<WhoPanel
			focus={who}
			mobile={mobile}
			query={query}
			facets={facets}
			facetSearch={facetSearch}
			addText={addText}
			everyone={everyone}
			onAddText={setAddText}
			onAdd={(term) => setQuery(addTerm(query, term))}
			onSearch={(f, q) => setFacetSearch({ ...facetSearch, [f]: q })}
			onToggle={(f, v) => setQuery(toggle(query, f, v))}
			onPicker={openPicker}
			onClose={() => setWho(null)}
		/>
	);

	const audienceEl = (
		<section className="bc-audience" aria-label="Audience">
			<div className="bc-aud-head">
				<strong
					className="bc-count"
					aria-live="polite"
					data-testid="match-count"
				>
					{total === undefined
						? "Counting…"
						: `${plural(total, "agent")} on ${plural(preview?.machines ?? 0, "machine")}`}
				</strong>
				{wake && total ? <WakeLegend counts={wake} /> : null}
			</div>
			<AudienceMap
				selector={debounced}
				total={total}
				machineFacet={facets.machine}
				chosen={query.chips.find((c) => c.key === "machine")?.values ?? null}
				items={items}
				priority={priority}
				mobile={mobile}
			/>
		</section>
	);

	const composeEl = (
		<footer className="bc-compose">
			<textarea
				id="bc-body"
				rows={mobile ? 2 : 3}
				value={body}
				aria-label="Broadcast message"
				placeholder={
					everyone
						? "Message everyone…"
						: total === undefined
							? "Message…"
							: `Message ${plural(total, "agent")}…`
				}
				onChange={(e) => {
					setBody((e.target as HTMLTextAreaElement).value);
					if (error) setError(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						void startSend();
					}
				}}
			/>
			<div className="bc-bar">
				<div className="bc-priority">
					<PriorityPicker
						value={priority}
						onChange={(p) => {
							setPriority(p);
							setDry(null);
						}}
					/>
					<span className="bc-hint">{PRIORITY_HINT[priority]}</span>
				</div>
				<label className="bc-check">
					<input
						type="checkbox"
						className={mobile ? undefined : "d-check"}
						checked={expectReply}
						onChange={(e) =>
							setExpectReply((e.target as HTMLInputElement).checked)
						}
					/>
					Expect replies
				</label>
				<button
					type="button"
					className={
						mobile ? "m-btn wide bc-send-btn" : "d-btn primary bc-send-btn"
					}
					disabled={phase !== "idle" || !total}
					onClick={startSend}
				>
					<SendIcon aria-hidden="true" />
					{phase === "checking"
						? "Checking…"
						: phase === "sending"
							? "Sending…"
							: `Send to ${total === undefined ? "…" : num(total)}`}
					{!mobile && (
						<span className="bc-kbd" aria-hidden="true">
							⌘↩
						</span>
					)}
				</button>
			</div>
			{error && (
				<p className="error bc-error" role="alert">
					{error}
					{failed && (
						<>
							{" "}
							<button
								type="button"
								className="link"
								onClick={() => void send(undefined, failed)}
							>
								Retry
							</button>
						</>
					)}
				</p>
			)}
			{phase === "confirm" && dry && tier === "inline" && (
				<div
					className="confirm-inline bc-confirm"
					role="alertdialog"
					aria-label="Confirm send"
				>
					{drift && <p className="warn">{reconfirmText(dry)}</p>}
					<span>
						Send to {plural(dry.total, "agent")} on {dry.breakdown[0]?.machine}?
					</span>
					<span className="spacer" />
					<button
						type="button"
						className={mobile ? "m-btn gray small" : "d-btn sm"}
						onClick={() => setPhase("idle")}
					>
						Cancel
					</button>
					<button
						type="button"
						className={mobile ? "m-btn small" : "d-btn sm primary"}
						onClick={() => send(dry.resolveToken)}
					>
						Confirm send to {num(dry.total)}
					</button>
				</div>
			)}
			{phase === "confirm" && dry && tier === "dialog" && (
				<ConfirmDialog
					result={dry}
					drift={drift}
					everyone={everyone}
					onCancel={() => setPhase("idle")}
					onConfirm={() => send(dry.resolveToken)}
				/>
			)}
		</footer>
	);

	if (!mobile)
		return (
			<Layer
				title="Broadcast"
				hideTitle
				onClose={back}
				dismissable={phase !== "sending"}
				className="bc-layer"
				onEscape={() => {
					if (who === null && !selOpen) return false;
					setWho(null);
					setSelOpen(false);
					return true;
				}}
				initialFocus={(e) => {
					e.preventDefault();
					document.getElementById("bc-body")?.focus();
				}}
			>
				<div className="bc">
					<header className="bc-head">
						<p className="bc-kicker">Broadcast</p>
						{sentenceEl}
						{selectorEl}
						{whoEl}
					</header>
					{audienceEl}
					{composeEl}
				</div>
			</Layer>
		);
	return (
		<BuilderShell mobile title="Broadcast">
			<div className="bc bc--phone">
				<header className="bc-head">
					{sentenceEl}
					{whoEl}
				</header>
				{audienceEl}
				{composeEl}
			</div>
			{picker && (
				<FacetPicker
					facet={picker}
					selector={serialize(query, picker)}
					query={query}
					onToggle={(v) => setQuery(toggle(query, picker, v))}
					onClose={() => history.back()}
				/>
			)}
		</BuilderShell>
	);
}

/** Wake totals as the chosen priority will play them ("Don't wake" wakes no one). */
function useWakeCounts(
	totals: AgentsPage["totals"] | undefined,
	priority: Priority,
) {
	return useMemo(() => {
		if (!totals) return null;
		const c: Partial<Record<WakeKey, number>> = { ...totals };
		if (priority === "fyi" && c.wakes) {
			c["inbox-only"] = (c["inbox-only"] ?? 0) + c.wakes;
			c.wakes = 0;
		}
		return c;
	}, [totals, priority]);
}

function TokenView({
	t,
	onEdit,
	onRemove,
}: {
	t: Token;
	onEdit: () => void;
	onRemove: () => void;
}) {
	return (
		<>
			{t.lead && <span className="bc-lead"> {t.lead} </span>}
			<span className={`bc-tok${t.code ? " is-code" : ""}`}>
				<button
					type="button"
					className="bc-tok-v"
					onClick={onEdit}
					title={t.kind === "chip" ? `Change ${t.key}` : undefined}
				>
					{t.code ? <code>{t.value}</code> : t.value}
				</button>
				<button
					type="button"
					className="bc-tok-x"
					aria-label={`Remove ${t.kind === "chip" ? t.key : t.value}`}
					onClick={onRemove}
				>
					<XIcon aria-hidden="true" />
				</button>
			</span>
		</>
	);
}

function WakeLegend({ counts }: { counts: Partial<Record<WakeKey, number>> }) {
	const keys = (Object.keys(WAKE) as WakeKey[]).filter((k) => counts[k]);
	return (
		<ul className="bc-legend" aria-label="What happens on send">
			{keys.map((k) => (
				<li key={k}>
					<span className={`bc-glyph ${WAKE[k].cls}`} aria-hidden="true" />
					{num(counts[k] ?? 0)} {WAKE[k].word.toLowerCase()}
				</li>
			))}
		</ul>
	);
}

/** The audience: one card per machine, agents as avatars with wake glyphs. */
function AudienceMapImpl({
	selector,
	total,
	machineFacet,
	chosen,
	items,
	priority,
	mobile,
}: {
	selector: string;
	total: number | undefined;
	machineFacet: Facet | undefined;
	chosen: string[] | null;
	items: AgentRow[];
	priority: Priority;
	mobile: boolean;
}) {
	const values = (machineFacet?.values ?? []).filter(
		(v) => v.count > 0 && (!chosen || chosen.includes(v.value)),
	);
	const shown = values.slice(0, mobile ? values.length : CARDS);
	const byMachine = new Map<string, AgentRow[]>();
	for (const a of items) {
		const list = byMachine.get(a.machine ?? "") ?? [];
		list.push(a);
		byMachine.set(a.machine ?? "", list);
	}
	// Faces for every card: the first page covers the busiest machines; a
	// small sample fills each card it missed.
	const [samples, setSamples] = useState<Record<string, AgentRow[]>>({});
	const missing = shown
		.filter(
			(v) => (byMachine.get(v.value)?.length ?? 0) < Math.min(v.count, FACES),
		)
		.map((v) => v.value)
		.slice(0, 12);
	const key = `${selector}\u0000${missing.join(",")}`;
	useEffect(() => {
		if (!missing.length) return;
		const ctrl = new AbortController();
		for (const m of missing) {
			const sel =
				selector === "*" ? `machine=${m}` : `${selector} machine=${m}`;
			api
				.agents({ selector: sel, limit: FACES, sort: "attention" }, ctrl.signal)
				.then((p) =>
					setSamples((prev) => ({ ...prev, [`${selector}|${m}`]: p.items })),
				)
				.catch(() => {});
		}
		return () => ctrl.abort();
	}, [key]);
	const facesOf = (m: string) => {
		const own = byMachine.get(m) ?? [];
		const sample = samples[`${selector}|${m}`] ?? [];
		return own.length >= sample.length ? own : sample;
	};
	if (total === 0)
		return (
			<p className="bc-empty" role="status">
				No agents match. Remove a part of the sentence to widen it.
			</p>
		);
	if (total === undefined || !machineFacet)
		return (
			<ul className="bc-map" aria-hidden="true">
				{[0, 1, 2, 3].map((i) => (
					<li key={i} className="bc-card is-skel">
						<span className="d-skel" style={{ width: 72, height: 12 }} />
						<span className="bc-faces">
							{Array.from({ length: 6 - i }, (_, j) => (
								<span key={j} className="d-skel bc-face-skel" />
							))}
						</span>
					</li>
				))}
			</ul>
		);
	const rest = values.slice(shown.length);
	const restAgents = total - shown.reduce((s, v) => s + v.count, 0);
	const restMachines = rest.length + (chosen ? 0 : machineFacet.more);
	return (
		<ul className="bc-map">
			{shown.map((v) => {
				const faces = facesOf(v.value).slice(0, FACES);
				const more = v.count - faces.length;
				return (
					<li key={v.value} className="bc-card">
						<span className="bc-card-head">
							<span className="bc-card-name">{v.value}</span>
							<span className="bc-card-n">{num(v.count)}</span>
						</span>
						<span className="bc-faces">
							{faces.map((a) => {
								const w = wakeFor(a, priority) as WakeKey;
								return (
									<span
										key={a.id}
										className="bc-face"
										title={`${a.name} · ${WAKE[w]?.word ?? w}`}
									>
										<AgentAvatar harness={a.harness} size="sm" />
										<span
											className={`bc-glyph ${WAKE[w]?.cls ?? ""}`}
											aria-hidden="true"
										/>
									</span>
								);
							})}
							{more > 0 && <span className="bc-more">+{num(more)}</span>}
						</span>
					</li>
				);
			})}
			{restMachines > 0 && restAgents > 0 && (
				<li className="bc-card is-more">
					<span className="bc-card-head">
						<span className="bc-card-name">
							{plural(restMachines, "more machine")}
						</span>
						<span className="bc-card-n">{num(restAgents)}</span>
					</span>
					<span className="bc-more-note">
						Included. Add a machine to the sentence to look closer.
					</span>
				</li>
			)}
		</ul>
	);
}

/** After send: the same map, avatars lighting up as receipts land. */
function ResultsBoardImpl({
	messageId,
	total,
	known,
	mobile,
}: {
	messageId: string;
	total: number;
	known: Map<string, AgentRow>;
	mobile: boolean;
}) {
	const [r, setR] = useState<ReceiptsPage | null>(null);
	useEffect(() => {
		let live = true;
		api
			.receipts(messageId)
			.then((x) => live && setR(x))
			.catch(() => {});
		const unwatch = watchReceipts(messageId);
		const off = onReceipts((x) => {
			if (x.message.id === messageId) setR(x);
		});
		return () => {
			live = false;
			unwatch();
			off();
		};
	}, [messageId]);
	const byMachine = new Map<string, ReceiptRow[]>();
	for (const it of r?.items ?? []) {
		const list = byMachine.get(it.machine) ?? [];
		list.push(it);
		byMachine.set(it.machine, list);
	}
	const machines = [...byMachine.entries()].sort(
		(a, b) => b[1].length - a[1].length,
	);
	const shown = mobile ? machines : machines.slice(0, CARDS);
	const totals = r?.totals ?? { queued: total };
	const order = [
		"replied",
		"read",
		"delivered",
		"sent",
		"queued",
		"held",
		"refused",
		"failed",
	] as const;
	return (
		<section className="bc-audience" aria-label="Delivery">
			<div className="bc-aud-head">
				<strong className="bc-count">
					{plural(r?.total ?? total, "agent")}
				</strong>
				<ul className="bc-legend" aria-label="Delivery so far">
					{order
						.filter((k) => totals[k])
						.map((k) => (
							<li key={k}>
								<span
									className={`bc-glyph ${STATE_CLS[k]}`}
									aria-hidden="true"
								/>
								{num(totals[k] ?? 0)} {RECEIPT_WORDS[k].toLowerCase()}
							</li>
						))}
				</ul>
			</div>
			<ul className="bc-map">
				{shown.map(([machine, rows]) => (
					<li key={machine} className="bc-card">
						<span className="bc-card-head">
							<span className="bc-card-name">{machine}</span>
							<span className="bc-card-n">{num(rows.length)}</span>
						</span>
						<span className="bc-faces">
							{rows.slice(0, FACES).map((it) => (
								<span
									key={it.agentId}
									className="bc-face"
									title={`${it.agentName} · ${RECEIPT_WORDS[it.state]}`}
									data-state={it.state}
								>
									<AgentAvatar
										harness={it.harness ?? known.get(it.agentId)?.harness}
										size="sm"
									/>
									<span
										className={`bc-glyph ${STATE_CLS[it.state] ?? ""}`}
										aria-hidden="true"
									/>
								</span>
							))}
							{rows.length > FACES && (
								<span className="bc-more">+{num(rows.length - FACES)}</span>
							)}
						</span>
					</li>
				))}
				{machines.length > shown.length && (
					<li className="bc-card is-more">
						<span className="bc-card-head">
							<span className="bc-card-name">
								{plural(machines.length - shown.length, "more machine")}
							</span>
						</span>
					</li>
				)}
			</ul>
		</section>
	);
}

/** Who: free text plus the facets, opened from the sentence ("Add", a token). */
function WhoPanelImpl({
	focus,
	mobile,
	query,
	facets,
	facetSearch,
	addText,
	everyone,
	onAddText,
	onAdd,
	onSearch,
	onToggle,
	onPicker,
	onClose,
}: {
	focus: string;
	mobile: boolean;
	query: Query;
	facets: Record<string, Facet>;
	facetSearch: Record<string, string>;
	addText: string;
	everyone: boolean;
	onAddText: (s: string) => void;
	onAdd: (term: string) => void;
	onSearch: (f: string, q: string) => void;
	onToggle: (f: string, v: string) => void;
	onPicker: (f: string) => void;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	// Desktop: a click outside the panel (and not on the sentence) closes it.
	useEffect(() => {
		if (mobile) return;
		const down = (e: PointerEvent) => {
			const t = e.target as Element;
			if (ref.current?.contains(t) || t.closest?.(".bc-sentence")) return;
			onClose();
		};
		addEventListener("pointerdown", down);
		return () => removeEventListener("pointerdown", down);
	}, [mobile]);
	useEffect(() => {
		if (!focus) return;
		ref.current
			?.querySelector(`[data-facet-section="${focus}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [focus]);
	type F = (typeof FACETS)[number];
	const order: F[] = (FACETS as readonly string[]).includes(focus)
		? [focus as F, ...FACETS.filter((f) => f !== focus)]
		: [...FACETS];
	return (
		<div className="bc-who" id="bc-who" ref={ref}>
			<form
				className="bc-who-add"
				onSubmit={(e) => {
					e.preventDefault();
					if (addText.trim()) onAdd(addText.trim());
					onAddText("");
				}}
			>
				<SearchIcon aria-hidden="true" />
				<input
					className="d-input"
					value={addText}
					placeholder={
						everyone
							? "Narrow it down: a name, ~text or key=value"
							: "Add: a name, ~text or key=value"
					}
					aria-label="Add filter"
					// biome-ignore lint/a11y/noAutofocus: opened to type in it
					autoFocus={!focus && !mobile}
					onChange={(e) => onAddText((e.target as HTMLInputElement).value)}
				/>
			</form>
			<div className="bc-who-facets">
				{order.map((f) => {
					const data = facets[f];
					const q = facetSearch[f] ?? "";
					return (
						<section
							className={`bc-facet${f === focus ? " is-focus" : ""}`}
							key={f}
							aria-label={`${f} facet`}
							data-facet-section={f}
						>
							<header>
								<span className="facet-name">{FACET_NAMES[f]}</span>
								{mobile ? (
									<button
										type="button"
										className="link"
										onClick={() => onPicker(f)}
									>
										All {data ? num(distinctOf(data)) : ""} ›
									</button>
								) : (
									(q || (data && distinctOf(data) > 8)) && (
										<label className="facet-search">
											<SearchIcon aria-hidden="true" />
											<input
												value={q}
												placeholder={
													data
														? `Search ${plural(distinctOf(data), FACET_NAMES[f].toLowerCase())}`
														: "Search"
												}
												aria-label={`Search ${f}`}
												onChange={(e) =>
													onSearch(f, (e.target as HTMLInputElement).value)
												}
											/>
										</label>
									)
								)}
							</header>
							<div className="facet-values">
								{!data &&
									[56, 72, 48].map((w) => (
										<span
											key={w}
											className="d-skel d-fchip-skel"
											style={{ width: w }}
										/>
									))}
								{query.chips
									.find((c) => c.key === f)
									?.values.filter(
										(v) => !data?.values.some((x) => x.value === v),
									)
									.map((v) => (
										<button
											type="button"
											key={`sel-${v}`}
											className="fchip on"
											aria-pressed="true"
											data-facet={f}
											data-value={v}
											onClick={() => onToggle(f, v)}
										>
											{facetLabel(f, v)}
										</button>
									))}
								{data?.values
									.slice(0, f === "machine" && !q ? 8 : undefined)
									.map((v) => {
										const on = has(query, f, v.value);
										return (
											<button
												type="button"
												key={v.value}
												className={`fchip${on ? " on" : ""}`}
												aria-pressed={on}
												data-facet={f}
												data-value={v.value}
												onClick={() => onToggle(f, v.value)}
											>
												{facetLabel(f, v.value)}
												<span className="fcount">{num(v.count)}</span>
											</button>
										);
									})}
								{data && data.values.length === 0 && (
									<span className="d-facet-none">No matches</span>
								)}
							</div>
						</section>
					);
				})}
			</div>
		</div>
	);
}

/** The phone sheet's frame: the title and the close X. */
function BuilderShellImpl({
	title,
	children,
}: {
	mobile: boolean;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div
			className="builder m-builder"
			role="dialog"
			aria-modal="true"
			aria-label={title}
		>
			<header className="m-sheet-head builder-header">
				<span />
				<h1>{title}</h1>
				<CloseX onClick={back} />
			</header>
			{children}
		</div>
	);
}

function FacetPickerImpl({
	facet,
	selector,
	query,
	onToggle,
	onClose,
}: {
	facet: string;
	selector: string;
	query: Query;
	onToggle: (v: string) => void;
	onClose: () => void;
}) {
	const [q, setQ] = useState("");
	const [data, setData] = useState<Facet | null>(null);
	const dq = useDebounced(q, 150);
	useEffect(() => {
		const ctrl = new AbortController();
		api
			.facets(
				{ selector, facet: facet as FacetKey, q: dq, top: 60 },
				ctrl.signal,
			)
			.then(setData)
			.catch(() => {});
		return () => ctrl.abort();
	}, [dq, selector]);
	return (
		<div
			className="facet-picker"
			role="dialog"
			aria-modal="true"
			aria-label={`Choose ${facet}`}
		>
			<header className="builder-header m-sheet-head">
				<span />
				<h1>{facet[0]!.toUpperCase() + facet.slice(1)}</h1>
				<CloseX onClick={onClose} />
			</header>
			<label className="search-box">
				<SearchIcon aria-hidden="true" />
				<input
					value={q}
					placeholder={`Search ${data ? num(distinctOf(data)) : ""} ${facet}s`}
					aria-label={`Search ${facet}`}
					onChange={(e) => setQ((e.target as HTMLInputElement).value)}
				/>
			</label>
			<ul className="picker-list">
				{data?.values.map((v) => {
					const on = has(query, facet, v.value);
					return (
						<li key={v.value}>
							<label className="picker-row">
								<input
									type="checkbox"
									checked={on}
									onChange={() => onToggle(v.value)}
								/>
								<span className="name">{facetLabel(facet, v.value)}</span>
								<span className="fcount">{num(v.count)}</span>
							</label>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

export default observer(BuilderImpl);
const BuilderShell = observer(BuilderShellImpl);
const FacetPicker = observer(FacetPickerImpl);
const AudienceMap = observer(AudienceMapImpl);
const ResultsBoard = observer(ResultsBoardImpl);
const WhoPanel = observer(WhoPanelImpl);

/** Distinct values of a facet: those shown plus the rest. */
function distinctOf(f: Facet): number {
	return f.values.length + f.more;
}
