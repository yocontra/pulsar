/**
 * A PR's card: state, review verdict, checks, review comments, a link and
 * "Ask {agent} to fix". Text from GitHub is shown as plain text and only
 * sent to the agent after the operator reads and confirms it.
 */
import {
	CheckIcon,
	CircleDotIcon,
	CircleIcon,
	ExternalLinkIcon,
	GitPullRequestIcon,
	LoaderIcon,
	MessageSquareIcon,
	XIcon,
} from "lucide-react";
import { useState } from "react";
import type {
	AgentRow,
	GitCheck,
	GitPr,
	GitPrDetails,
} from "../../api/types.ts";
import { ExtLink } from "../../components/ExtLink.tsx";
import { toast } from "../../lib/toast.ts";
import { fixRequest } from "./model.ts";
import { usePrDetails } from "./run.ts";

export const PR_STATE: Record<GitPr["state"], string> = {
	open: "Open",
	draft: "Draft",
	merged: "Merged",
	closed: "Closed",
};

const CHECK_ICON: Record<GitCheck["state"], typeof CheckIcon> = {
	pass: CheckIcon,
	fail: XIcon,
	pending: LoaderIcon,
	skipped: CircleIcon,
};

/** "2 failing", "3 pending", "All 5 passed". */
export function checksSummary(checks: GitCheck[]): {
	text: string;
	tone: "fail" | "pending" | "pass" | "none";
} {
	if (checks.length === 0) return { text: "No checks reported", tone: "none" };
	const fail = checks.filter((c) => c.state === "fail").length;
	const pending = checks.filter((c) => c.state === "pending").length;
	if (fail) return { text: `${fail} failing`, tone: "fail" };
	if (pending) return { text: `${pending} pending`, tone: "pending" };
	return {
		text: checks.length === 1 ? "Check passed" : `All ${checks.length} passed`,
		tone: "pass",
	};
}

const REVIEW: Record<NonNullable<GitPrDetails["review"]>, string> = {
	approved: "Approved",
	changes_requested: "Changes requested",
	review_required: "Review required",
};

export function PrCard({
	agent,
	fallback,
	mobile,
	onAsk,
}: {
	agent: AgentRow;
	/** The PR from the status, shown while the details load. */
	fallback: GitPr | null;
	mobile: boolean;
	/** Opens the confirm for "Ask {agent} to fix" with this text. */
	onAsk: (text: string) => void;
}) {
	const q = usePrDetails(agent.id, true);
	const d = q.data;
	const pr = d?.pr ?? fallback;
	if (!pr)
		return (
			<div className="g-pr-card">
				<p className="g-pr-empty">
					{q.isLoading ? "Loading…" : (d?.message ?? "No PR for this branch.")}
				</p>
			</div>
		);
	const sum = d ? checksSummary(d.checks) : null;
	const text = d ? fixRequest(d) : "";
	const canAsk =
		!!d && (d.checks.some((c) => c.state === "fail") || d.comments.length > 0);
	return (
		<div className={`g-pr-card${mobile ? " mobile" : ""}`}>
			<div className="g-pr-head">
				<GitPullRequestIcon
					aria-hidden="true"
					className={`g-pr-ico ${pr.state}`}
				/>
				<div className="g-pr-title">
					<ExtLink href={pr.url || null}>
						<span className="g-pr-num">#{pr.number}</span> {pr.title}
						{pr.url && <ExternalLinkIcon aria-hidden="true" />}
					</ExtLink>
					<span className="g-pr-sub">
						<span className={`g-pr-state ${pr.state}`}>
							{PR_STATE[pr.state]}
						</span>
						{pr.head} → {pr.base}
						{d?.review && (
							<span className="g-pr-review"> · {REVIEW[d.review]}</span>
						)}
					</span>
				</div>
			</div>
			<section aria-label="Checks" className="g-pr-sec">
				<h3>
					Checks
					{sum && <span className={`g-sum ${sum.tone}`}>{sum.text}</span>}
				</h3>
				{!d ? (
					<p className="g-pr-empty">Loading checks…</p>
				) : d.checks.length === 0 ? (
					<p className="g-pr-empty">No checks reported</p>
				) : (
					<ul className="g-checks">
						{d.checks.map((c, i) => {
							const Icon = CHECK_ICON[c.state];
							return (
								<li key={`${c.name}-${i}`} className={`g-check ${c.state}`}>
									<Icon aria-label={c.state} />
									<ExtLink href={c.url}>
										<span>{c.name}</span>
									</ExtLink>
									{c.workflow && (
										<span className="g-check-wf">{c.workflow}</span>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</section>
			{d && d.comments.length > 0 && (
				<section aria-label="Review comments" className="g-pr-sec">
					<h3>
						Review comments{" "}
						<span className="g-sum none">{d.comments.length}</span>
					</h3>
					<ul className="g-comments">
						{d.comments.map((c, i) => (
							<li key={`${c.author}-${i}`} className="g-comment">
								<div className="g-comment-by">
									<MessageSquareIcon aria-hidden="true" />
									<strong>{c.author}</strong>
									{c.path && (
										<span className="g-comment-at">
											{c.path}
											{c.line ? `:${c.line}` : ""}
										</span>
									)}
									{c.verdict === "changes_requested" && (
										<span className="g-pr-state closed">Changes requested</span>
									)}
								</div>
								{c.body && <p className="g-comment-body">{c.body}</p>}
							</li>
						))}
					</ul>
				</section>
			)}
			<div className="g-pr-foot">
				<button
					type="button"
					className={mobile ? "m-btn tinted wide" : "d-btn sm"}
					disabled={!canAsk}
					title={
						canAsk
							? undefined
							: "Nothing to fix: no failing checks or comments."
					}
					onClick={() => onAsk(text)}
				>
					<CircleDotIcon aria-hidden="true" />
					Ask {agent.name} to fix
				</button>
			</div>
		</div>
	);
}

/** Sends the fix request to the agent (the app's normal send path). */
export async function sendFix(agent: AgentRow, body: string): Promise<boolean> {
	const data = await import("../../data/index.ts");
	try {
		const r = await data.sendMessage({
			req: { ids: [agent.id], body, clientId: data.newClientId() },
			agentId: agent.id,
		});
		if (r.drift || r.reconfirm) {
			void toast(`Not sent to ${agent.name}`, {
				tone: "warning",
				description: "Who gets it changed. Try again.",
			});
			return false;
		}
		void toast(`Asked ${agent.name} to fix`, { tone: "success" });
		return true;
	} catch (e) {
		const { ProveCancelled } = await import("../../api/client.ts");
		if (e instanceof ProveCancelled) return false;
		void toast(`Couldn't send to ${agent.name}`, {
			tone: "error",
			description: (e as Error).message,
		});
		return false;
	}
}

/** The confirm before sending: the text can be read and edited first. */
export function AskFixForm({
	agent,
	initial,
	mobile,
	onDone,
}: {
	agent: AgentRow;
	initial: string;
	mobile: boolean;
	onDone: () => void;
}) {
	const [text, setText] = useState(initial);
	const [sending, setSending] = useState(false);
	return (
		<div className={`g-ask${mobile ? " mobile" : ""}`}>
			<p className="g-ask-note">
				This sends the PR's failing checks and review comments to {agent.name}.
				Review comments come from GitHub: read them before you send.
			</p>
			<textarea
				className={mobile ? "g-textarea" : "d-input g-textarea"}
				aria-label="Message"
				value={text}
				onChange={(e) => setText(e.target.value)}
				rows={mobile ? 8 : 10}
			/>
			<div className={mobile ? "g-sheet-foot" : "d-pop-foot"}>
				<button
					type="button"
					className={mobile ? "m-btn gray" : "d-btn"}
					onClick={onDone}
				>
					Cancel
				</button>
				<button
					type="button"
					className={mobile ? "m-btn" : "d-btn primary"}
					disabled={!text.trim() || sending}
					onClick={async () => {
						setSending(true);
						const ok = await sendFix(agent, text.trim());
						setSending(false);
						if (ok) onDone();
					}}
				>
					{sending ? "Sending…" : `Send to ${agent.name}`}
				</button>
			</div>
		</div>
	);
}
