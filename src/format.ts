import type { AskResponse } from "./http/wire.ts";
import { neutralizeHumanTag } from "./human-tag.ts";
import type {
	DeliveredMessage,
	Message,
	PublicAgent,
	Receipt,
} from "./types.ts";

/** "5s ago", "3m ago", "2h ago", "4d ago". */
export function ago(ms: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

function agentLine(a: PublicAgent): string {
	const selfTags = a.tags.filter(
		(t) =>
			!/^(harness|project|branch|worktree|pr|issue|model|machine):/.test(t),
	);
	const pr = a.tags.find((t) => t.startsWith("pr:"))?.slice(3);
	const issue = a.tags.find((t) => t.startsWith("issue:"))?.slice(6);
	const worktree = a.tags.find((t) => t.startsWith("worktree:"))?.slice(9);
	const bits = [
		a.name,
		`[${a.harness}]`,
		a.capabilities?.surface === "managed-acp" ? "managed ACP" : null,
		a.capabilities?.host ? `host=${a.capabilities.host}` : null,
		a.project ? `project=${a.project}` : null,
		a.branch ? `branch=${a.branch}` : null,
		worktree ? `worktree=${worktree}` : null,
		pr ? `pr=${pr}` : null,
		issue ? `issue=${issue}` : null,
		a.model ? `model=${a.model}` : null,
		a.status,
		a.reach === "push" ? "push" : "pull-only",
		selfTags.length ? `tags=${selfTags.join(",")}` : null,
		a.registered ? null : "(not running Pulsar)",
		a.inbound !== "accept" ? `inbound=${a.inbound}` : null,
	].filter(Boolean);
	return `- ${bits.join(" · ")}${a.activity ? `\n  doing: ${a.activity}` : ""}\n  id: ${a.id}`;
}

export function agentsText(agents: PublicAgent[], selector: string): string {
	if (agents.length === 0) return `No live agents match "${selector}".`;
	return `${agents.length} agent${agents.length === 1 ? "" : "s"} (${selector}):\n${agents.map(agentLine).join("\n")}`;
}

export function messageText(m: DeliveredMessage | Message): string {
	const from = neutralizeHumanTag(
		"from" in m ? `${m.from.name} [${m.from.harness}]` : m.fromName,
	);
	const attempt =
		"attempt" in m && m.attempt && m.attempt > 1
			? ` · attempt ${m.attempt}${m.maxAttempts ? ` of ${m.maxAttempts}` : ""} (you may have seen it before)`
			: "";
	return `- ${m.id} · from ${from} · ${ago(m.createdAt)}${attempt}${m.priority !== "normal" ? ` · ${m.priority}` : ""}${
		m.expectReply ? " · wants a reply" : ""
	}${m.replyTo ? ` · reply to ${m.replyTo}` : ""}\n  ${neutralizeHumanTag(m.body).replace(/\n/g, "\n  ")}`;
}

export function receiptsText(receipts: Receipt[]): string {
	return receipts
		.map(
			(r) =>
				`- ${r.agentName}: ${r.state}${r.attempt && r.attempt > 1 ? ` · attempt ${r.attempt}` : ""}${r.via ? ` via ${r.via}` : ""}${r.detail ? ` (${r.detail})` : ""}`,
		)
		.join("\n");
}

/** A lookup answer: ranked agents with why they match. */
export function askText(r: AskResponse): string {
	if (!r.matches.length)
		return `Nobody matches "${r.question}" from what Pulsar knows (${r.scanned} agents checked). Ask them directly to reach more.`;
	const lines = r.matches.map((m) => {
		const a = m.agent;
		const where = [a.machine, a.project].filter(Boolean).join("/");
		return `- ${a.name} (${a.id}) ${where} [${a.state}]\n    ${m.evidence.join("\n    ")}`;
	});
	const more =
		r.total > r.matches.length ? `\n(${r.total - r.matches.length} more)` : "";
	return `${lines.join("\n")}${more}`;
}

export type WaitAnswer = {
	event: string;
	message?: DeliveredMessage;
	agent?: PublicAgent;
	receipt?: Receipt;
};

export function waitText(r: WaitAnswer, timeout: number): string {
	if (r.event === "timeout") return `Nothing happened within ${timeout}s.`;
	if (["dead", "nacked", "withdrawn"].includes(r.event) && r.receipt)
		return `${r.event}:\n${receiptsText([r.receipt])}`;
	if (r.message) return `${r.event}:\n${messageText(r.message)}`;
	if (r.agent)
		return r.event === "gone"
			? `${r.agent.name} is gone (its session ended).`
			: `${r.agent.name} is idle.`;
	return r.event;
}
