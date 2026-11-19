import { useEffect, useState } from "react";
import { api, ensureSession } from "../api/client.ts";
import type { AskResponse } from "../api/types.ts";
import { AgentAvatar, AgentStatus } from "../ds/index.ts";
import { navigate } from "../lib/router.ts";
import { Receipts } from "./Composer.tsx";

/**
 * Ask mode of the palette: answers from what pulsar knows (nobody is
 * woken), then "Ask them directly" sends the question to the chosen agents
 * and streams their replies, with who hasn't answered.
 */
export function AskPanel({
	question,
	onClose,
}: {
	question: string;
	onClose: () => void;
}) {
	const [res, setRes] = useState<AskResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [sent, setSent] = useState<{ id: string; total: number } | null>(null);
	const [sending, setSending] = useState(false);

	useEffect(() => {
		setSent(null);
		const q = question.trim();
		if (!q) {
			setRes(null);
			return;
		}
		let live = true;
		const t = setTimeout(() => {
			api
				.ask({ question: q })
				.then((r) => {
					if (!live) return;
					setRes(r);
					setError(null);
					// The top three are picked to ask directly.
					setPicked(new Set(r.matches.slice(0, 3).map((m) => m.agent.id)));
				})
				.catch((e) => live && setError((e as Error).message));
		}, 250);
		return () => {
			live = false;
			clearTimeout(t);
		};
	}, [question]);

	const toggle = (id: string) => {
		const next = new Set(picked);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		setPicked(next);
	};

	const askDirectly = async () => {
		setSending(true);
		try {
			// Asking agents directly is a send as the human operator: prove it first.
			await ensureSession("send");
			const r = await api.send({
				ids: [...picked],
				body: question.trim(),
				priority: "normal",
				expectReply: true,
			});
			if (r.messageId) setSent({ id: r.messageId, total: r.total });
			else
				setError("The daemon asked to confirm; use the builder for big sends");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't send");
		}
		setSending(false);
	};

	if (!question.trim())
		return (
			<div className="d-ask-empty muted pad">
				<p>
					Ask in plain words. Answers come from what Pulsar already knows, so
					nobody is woken.
				</p>
				<ul className="d-ask-examples">
					{[
						"who is editing src/auth/session.ts",
						"who has PR 1402",
						"who is idle on apparish",
					].map((x) => (
						<li key={x}>“{x}”</li>
					))}
				</ul>
			</div>
		);
	return (
		<div className="ask-panel d-ask" data-testid="ask-panel">
			{error && (
				<p className="error pad d-ask-error" role="alert">
					{error}
				</p>
			)}
			{!res && !error && (
				<p className="muted pad d-ask-status" role="status">
					Looking…
				</p>
			)}
			{res && res.matches.length === 0 && (
				<p className="muted pad d-ask-status">
					Nobody matches from what Pulsar knows ({res.scanned} agents checked).
				</p>
			)}
			{res && res.matches.length > 0 && (
				<div className="d-pal-group">
					{res.matches.length === 1
						? "1 agent matches"
						: `${res.matches.length} agents match`}
				</div>
			)}
			<ul className="palette-list ask-results d-ask-list">
				{res?.matches.map((m) => (
					<li key={m.agent.id} className="ask-match d-ask-match">
						<input
							type="checkbox"
							className="d-check"
							checked={picked.has(m.agent.id)}
							onChange={() => toggle(m.agent.id)}
							aria-label={`Ask ${m.agent.name}`}
						/>
						<div className="d-ask-body">
							<button
								type="button"
								className="row d-ask-agent"
								onClick={() => {
									onClose();
									navigate({ view: "agent", id: m.agent.id });
								}}
							>
								<AgentAvatar harness={m.agent.harness} size="xs" />
								<span className="name d-pal-label">{m.agent.name}</span>
								<span className="sub d-pal-sub">
									{[m.agent.machine, m.agent.project]
										.filter(Boolean)
										.join(" · ")}
								</span>
								<AgentStatus
									state={m.agent.state}
									since={m.agent.stateSince}
									needsReason={m.agent.needsYou?.reason}
									lastSession={m.agent.sessionFrom === "folder"}
									variant={m.agent.state === "needs-you" ? "soft" : "plain"}
								/>
							</button>
							<ul className="evidence d-evidence">
								{m.evidence.map((e) => (
									<li key={e}>{e}</li>
								))}
							</ul>
						</div>
					</li>
				))}
			</ul>
			{res && res.matches.length > 0 && !sent && (
				<div className="ask-actions d-ask-actions">
					<span className="muted small">
						Sends your question and waits for replies.
					</span>
					<button
						type="button"
						className="btn primary d-btn primary"
						disabled={picked.size === 0 || sending}
						onClick={askDirectly}
					>
						{sending ? "Asking…" : `Ask them directly (${picked.size})`}
					</button>
				</div>
			)}
			{sent && (
				<div className="ask-replies d-ask-replies">
					<Receipts messageId={sent.id} total={sent.total} expectReply full />
				</div>
			)}
		</div>
	);
}
