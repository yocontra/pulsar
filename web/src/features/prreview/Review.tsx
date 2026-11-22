/**
 * The PR review's parts, shared by the desktop page and the phone pages:
 * the PR's head line, Summary (description and reviews), Checks, one
 * file's diff with its review threads at their lines, a thread (reply,
 * resolve), the new-comment box and the review form. Text from GitHub is
 * plain text; links open only when they are https (ExtLink).
 */
import {
	CheckIcon,
	CircleIcon,
	ExternalLinkIcon,
	GitPullRequestIcon,
	LoaderCircleIcon,
	LoaderIcon,
	MessageSquarePlusIcon,
	XIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type {
	AgentRow,
	GitCheck,
	GitPrReview,
	GitReviewComment,
	GitReviewFile,
	GitReviewParams,
	GitReviewThread,
} from "../../api/types.ts";
import { parsePatch } from "../../changes/patch.ts";
import { ExtLink } from "../../components/ExtLink.tsx";
import { ago } from "../../lib/format.ts";
import { DiffBody, type DiffRow, type DiffSide } from "../../session/Diff.tsx";
import { langForPath, useTokens } from "../../session/highlight.tsx";
import { checksSummary, PR_STATE } from "../git/PrCard.tsx";
import { threadIndex, useReviewFile, write } from "./data.ts";

const REVIEW: Record<NonNullable<GitPrReview["review"]>, string> = {
	approved: "Approved",
	changes_requested: "Changes requested",
	review_required: "Review required",
};

const VERDICT: Record<NonNullable<GitReviewComment["verdict"]>, string> = {
	approved: "Approved",
	changes_requested: "Requested changes",
	commented: "Commented",
};

const when = (at: string | null) => {
	const t = at ? Date.parse(at) : Number.NaN;
	return Number.isNaN(t) ? "" : ago(t);
};

/** A button whose progress replaces it in place while its write runs. */
export function Busy({
	busy,
	label,
	children,
}: {
	busy: boolean;
	label: string;
	children: ReactNode;
}) {
	if (!busy) return <>{children}</>;
	return (
		<span className="prv-busy" role="status">
			<LoaderCircleIcon aria-hidden="true" className="g-spin" />
			{label}
		</span>
	);
}

export function PrHead({ r }: { r: GitPrReview }) {
	const pr = r.pr!;
	return (
		<div className="prv-title">
			<GitPullRequestIcon
				aria-hidden="true"
				className={`g-pr-ico ${pr.state}`}
			/>
			<div>
				<h2>
					<ExtLink href={pr.url || null}>
						{pr.title} <span className="prv-num">#{pr.number}</span>
						{pr.url && <ExternalLinkIcon aria-hidden="true" />}
					</ExtLink>
				</h2>
				<p className="prv-sub">
					<span className={`g-pr-state ${pr.state}`}>{PR_STATE[pr.state]}</span>
					{r.author && <span>{r.author}</span>}
					<span className="prv-ref">
						{pr.head} → {pr.base}
					</span>
					{r.review && (
						<span className={`prv-verdict ${r.review}`}>
							{REVIEW[r.review]}
						</span>
					)}
				</p>
			</div>
		</div>
	);
}

/** Why there is no PR to review. */
export function noPrText(r: GitPrReview | undefined, error: unknown): string {
	if (error) return "Couldn't read this PR.";
	if (!r) return "Loading…";
	if (r.message && r.reason) return r.message;
	switch (r.reason) {
		case "no_github":
			return "This branch has no GitHub remote.";
		case "gh_missing":
			return "gh is not installed on the agent's machine.";
		case "gh_logged_out":
			return "gh is not logged in on the agent's machine.";
		case "gh_error":
			return "Couldn't ask GitHub about this branch.";
	}
	return "No PR for this branch.";
}

export function Summary({
	r,
	onFiles,
}: {
	r: GitPrReview;
	onFiles: () => void;
}) {
	const open = r.threads.filter((t) => !t.resolved).length;
	const sum = checksSummary(r.checks);
	return (
		<div className="prv-summary">
			<ul className="prv-stats" aria-label="At a glance">
				<li>
					<button type="button" className="g-link" onClick={onFiles}>
						{r.files.length}
						{r.truncated ? "+" : ""} {r.files.length === 1 ? "file" : "files"}
					</button>
				</li>
				<li>
					{open} open {open === 1 ? "thread" : "threads"}
				</li>
				<li className={`g-sum ${sum.tone}`}>{sum.text}</li>
			</ul>
			<section aria-label="Description" className="prv-sec">
				<h3>Description</h3>
				{r.body.trim() ? (
					<p className="prv-body">{r.body}</p>
				) : (
					<p className="prv-empty">No description.</p>
				)}
			</section>
			<section aria-label="Reviews" className="prv-sec">
				<h3>Reviews</h3>
				{r.reviews.length === 0 ? (
					<p className="prv-empty">No reviews yet.</p>
				) : (
					<ul className="prv-reviews">
						{r.reviews.map((c, i) => (
							<li key={`${c.author}-${i}`} className="prv-review">
								<p className="prv-by">
									<strong>{c.author}</strong>
									{c.verdict && (
										<span className={`prv-verdict ${c.verdict}`}>
											{VERDICT[c.verdict]}
										</span>
									)}
									<span className="prv-when">{when(c.at)}</span>
								</p>
								{c.body && <p className="prv-body">{c.body}</p>}
							</li>
						))}
					</ul>
				)}
			</section>
			{r.message && <p className="prv-note">{r.message}</p>}
		</div>
	);
}

const CHECK_ICON: Record<GitCheck["state"], typeof CheckIcon> = {
	pass: CheckIcon,
	fail: XIcon,
	pending: LoaderIcon,
	skipped: CircleIcon,
};

export function Checks({ checks }: { checks: GitCheck[] }) {
	if (checks.length === 0)
		return <p className="prv-empty">No checks reported</p>;
	// Failing first, then pending; GitHub's order within each.
	const rank = { fail: 0, pending: 1, pass: 2, skipped: 3 };
	const list = [...checks].sort((a, b) => rank[a.state] - rank[b.state]);
	return (
		<ul className="g-checks prv-checks">
			{list.map((c, i) => {
				const Icon = CHECK_ICON[c.state];
				return (
					<li key={`${c.name}-${i}`} className={`g-check ${c.state}`}>
						<Icon aria-label={c.state} />
						<ExtLink href={c.url}>
							<span>{c.name}</span>
						</ExtLink>
						{c.workflow && <span className="g-check-wf">{c.workflow}</span>}
					</li>
				);
			})}
		</ul>
	);
}

/** A text box with Cancel and a send button; the send runs `onSend`. */
export function TextBox({
	label,
	send,
	placeholder,
	onSend,
	onCancel,
	mobile,
}: {
	label: string;
	send: string;
	placeholder: string;
	onSend: (text: string) => Promise<boolean>;
	onCancel: () => void;
	mobile: boolean;
}) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<div className="prv-box">
			<textarea
				className={mobile ? "g-textarea" : "d-input g-textarea"}
				aria-label={label}
				placeholder={placeholder}
				value={text}
				rows={3}
				// biome-ignore lint/a11y/noAutofocus: opened by the operator's tap
				autoFocus
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") onCancel();
				}}
			/>
			<div className="prv-box-foot">
				<button
					type="button"
					className={mobile ? "m-btn gray" : "d-btn sm"}
					onClick={onCancel}
					disabled={busy}
				>
					Cancel
				</button>
				<Busy busy={busy} label="Sending…">
					<button
						type="button"
						className={mobile ? "m-btn" : "d-btn sm primary"}
						disabled={!text.trim()}
						title={text.trim() ? undefined : "Write something first."}
						onClick={async () => {
							setBusy(true);
							const ok = await onSend(text);
							setBusy(false);
							if (ok) onCancel();
						}}
					>
						{send}
					</button>
				</Busy>
			</div>
		</div>
	);
}

export function Thread({
	agentId,
	number,
	t,
	mobile,
}: {
	agentId: string;
	number: number;
	t: GitReviewThread;
	mobile: boolean;
}) {
	const [shown, setShown] = useState(!t.resolved);
	const [replying, setReplying] = useState(false);
	const [busy, setBusy] = useState(false);
	const first = t.comments[0];
	const label = `Thread by ${first?.author ?? "someone"}${t.resolved ? ", resolved" : ""}`;
	return (
		<section
			className={`prv-thread${t.resolved ? " resolved" : ""}`}
			aria-label={label}
		>
			<header className="prv-thread-head">
				{t.outdated && <span className="prv-tag">Outdated</span>}
				{t.resolved && <span className="prv-tag ok">Resolved</span>}
				{t.line === null && t.originalLine && (
					<span className="prv-at">was line {t.originalLine}</span>
				)}
				{t.resolved && (
					<button
						type="button"
						className="g-link"
						aria-expanded={shown}
						onClick={() => setShown(!shown)}
					>
						{shown
							? "Hide"
							: `Show ${t.comments.length === 1 ? "comment" : `${t.comments.length} comments`}`}
					</button>
				)}
			</header>
			{shown && (
				<>
					<ul className="prv-comments">
						{t.comments.map((c) => (
							<li key={c.id} className="prv-comment">
								<p className="prv-by">
									<strong>{c.author}</strong>
									<span className="prv-when">
										<ExtLink href={c.url}>{when(c.at) || "link"}</ExtLink>
									</span>
								</p>
								<p className="prv-body">{c.body}</p>
							</li>
						))}
					</ul>
					{replying ? (
						<TextBox
							label="Reply"
							send="Reply"
							placeholder="Write a reply…"
							mobile={mobile}
							onCancel={() => setReplying(false)}
							onSend={(body) =>
								write(agentId, "reply", { number, thread: t.id, body })
							}
						/>
					) : (
						<div className="prv-thread-foot">
							<button
								type="button"
								className={mobile ? "m-btn gray sm" : "d-btn sm"}
								disabled={!t.canReply}
								title={
									t.canReply ? undefined : "You can't reply in this thread."
								}
								onClick={() => setReplying(true)}
							>
								Reply
							</button>
							<Busy
								busy={busy}
								label={t.resolved ? "Reopening…" : "Resolving…"}
							>
								<button
									type="button"
									className={mobile ? "m-btn gray sm" : "d-btn sm"}
									disabled={!t.canResolve}
									title={
										t.canResolve
											? undefined
											: "Only people with write access can resolve threads."
									}
									onClick={async () => {
										setBusy(true);
										await write(agentId, "resolve", {
											number,
											thread: t.id,
											resolved: !t.resolved,
										});
										setBusy(false);
									}}
								>
									{t.resolved ? "Reopen" : "Resolve"}
								</button>
							</Busy>
						</div>
					)}
				</>
			)}
		</section>
	);
}

/**
 * One file of the PR: its diff with line numbers, the threads at their
 * lines, outdated threads above, and a comment button on every line.
 */
export function FileReview({
	agent,
	r,
	file,
	layout,
	mobile,
}: {
	agent: AgentRow;
	r: GitPrReview;
	file: GitReviewFile;
	layout: "split" | "unified";
	mobile: boolean;
}) {
	const q = useReviewFile(agent.id, r.head, file);
	const threads = useMemo(
		() => threadIndex(r.threads).get(file.path),
		[r.threads, file.path],
	);
	const [draft, setDraft] = useState<string | null>(null);
	const number = r.pr!.number;
	const loose = threads?.loose ?? [];
	let body: ReactNode;
	if (file.binary)
		body = <p className="cv-placeholder">Binary file, not shown.</p>;
	else if (file.tooLarge)
		body = (
			<p className="cv-placeholder">
				This diff is too large to show. Open it on GitHub.
			</p>
		);
	else if (q.data?.patch != null)
		body = (
			<ReviewPatch
				patch={q.data.patch}
				path={file.path}
				layout={layout}
				extras={{
					gutter: (row, side) => {
						const line = side === "LEFT" ? row.oldLine : row.newLine;
						if (!line || !r.head) return null;
						return (
							<button
								type="button"
								className="prv-add"
								aria-label={`Comment on line ${line}`}
								title="Comment on this line"
								onClick={() => setDraft(`${side}:${line}`)}
							>
								<MessageSquarePlusIcon aria-hidden="true" />
							</button>
						);
					},
					after: (row, side) => {
						const line = side === "LEFT" ? row.oldLine : row.newLine;
						if (!line) return null;
						const k = `${side}:${line}`;
						const here = threads?.at.get(k) ?? [];
						const box = draft === k;
						if (!here.length && !box) return null;
						return (
							<div key={k} className="prv-at-line">
								{here.map((t) => (
									<Thread
										key={t.id}
										agentId={agent.id}
										number={number}
										t={t}
										mobile={mobile}
									/>
								))}
								{box && (
									<TextBox
										label={`Comment on line ${line}`}
										send="Comment"
										placeholder="Leave a comment…"
										mobile={mobile}
										onCancel={() => setDraft(null)}
										onSend={(text) =>
											write(agent.id, "comment", {
												number,
												head: r.head!,
												path: file.path,
												line,
												side,
												body: text,
											})
										}
									/>
								)}
							</div>
						);
					},
				}}
			/>
		);
	else if (q.error)
		body = <p className="cv-placeholder">Couldn't load this diff.</p>;
	else
		body = (
			<div className="cv-loading" aria-busy="true">
				<span className="cv-sr">Loading diff</span>
			</div>
		);
	return (
		<div className="prv-file-body">
			{loose.length > 0 && (
				<div className="prv-loose">
					{loose.map((t) => (
						<Thread
							key={t.id}
							agentId={agent.id}
							number={number}
							t={t}
							mobile={mobile}
						/>
					))}
				</div>
			)}
			{body}
		</div>
	);
}

function ReviewPatch({
	patch,
	path,
	layout,
	extras,
}: {
	patch: string;
	path: string;
	layout: "split" | "unified";
	extras: {
		gutter: (r: DiffRow, side: DiffSide) => ReactNode;
		after: (r: DiffRow, side: DiffSide) => ReactNode;
	};
}) {
	const p = useMemo(() => parsePatch(patch), [patch]);
	const lang = langForPath(path);
	const A = useTokens(p.before, p.before ? lang : null);
	const B = useTokens(p.after, p.after ? lang : null);
	if (p.hunks === 0) return <p className="cv-placeholder">Nothing to show.</p>;
	return (
		<DiffBody
			items={p.items}
			A={A}
			B={B}
			layout={layout}
			numbers
			extras={extras}
			className="cv-diff prv-diff"
		/>
	);
}

const EVENTS: {
	event: GitReviewParams["event"];
	label: string;
	hint: string;
}[] = [
	{ event: "comment", label: "Comment", hint: "Feedback without a verdict." },
	{ event: "approve", label: "Approve", hint: "Ready to merge." },
	{
		event: "request_changes",
		label: "Request changes",
		hint: "Must be addressed before merging.",
	},
];

/** Submit a review: Comment, Approve or Request changes, with a summary. */
export function ReviewForm({
	agentId,
	r,
	mobile,
	onDone,
}: {
	agentId: string;
	r: GitPrReview;
	mobile: boolean;
	onDone: () => void;
}) {
	const [event, setEvent] = useState<GitReviewParams["event"]>("comment");
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const own = r.ownPr;
	const needsText = event !== "approve" && !body.trim();
	return (
		<div className={`prv-form${mobile ? " mobile" : ""}`}>
			<textarea
				className={mobile ? "g-textarea" : "d-input g-textarea"}
				aria-label="Review summary"
				placeholder="Leave a summary…"
				value={body}
				rows={mobile ? 5 : 4}
				onChange={(e) => setBody(e.target.value)}
			/>
			<div className="prv-events" role="radiogroup" aria-label="Verdict">
				{EVENTS.map((e) => {
					const off = own && e.event !== "comment";
					return (
						<label
							key={e.event}
							className={`prv-event${off ? " off" : ""}`}
							title={
								off
									? "You can't approve or request changes on your own PR."
									: undefined
							}
						>
							<input
								type="radio"
								name="prv-event"
								value={e.event}
								checked={event === e.event}
								disabled={off}
								onChange={() => setEvent(e.event)}
							/>
							<span>
								<strong>{e.label}</strong>
								<span className="prv-hint">
									{off ? "Not on your own PR." : e.hint}
								</span>
							</span>
						</label>
					);
				})}
			</div>
			<div className={mobile ? "g-sheet-foot" : "d-pop-foot"}>
				<button
					type="button"
					className={mobile ? "m-btn gray" : "d-btn"}
					onClick={onDone}
					disabled={busy}
				>
					Cancel
				</button>
				<Busy busy={busy} label="Submitting…">
					<button
						type="button"
						className={mobile ? "m-btn" : "d-btn primary"}
						disabled={needsText}
						title={needsText ? "Write a summary first." : undefined}
						onClick={async () => {
							setBusy(true);
							const ok = await write(agentId, "review", {
								number: r.pr!.number,
								event,
								body,
							});
							setBusy(false);
							if (ok) onDone();
						}}
					>
						Submit review
					</button>
				</Busy>
			</div>
		</div>
	);
}
