import type {
	DeliveredMessage,
	Message,
	PublicAgent,
	Receipt,
} from "./types.ts";

export function ago(ms: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

export function agentLine(a: PublicAgent): string {
	const selfTags = a.tags.filter((t) => !/^(harness|project|branch):/.test(t));
	const bits = [
		a.name,
		`[${a.harness}]`,
		a.project ? `project=${a.project}` : null,
		a.branch ? `branch=${a.branch}` : null,
		a.status,
		a.reach === "push" ? "push" : "pull-only",
		selfTags.length ? `tags=${selfTags.join(",")}` : null,
		a.registered ? null : "(not running pulsar)",
		a.inbound !== "accept" ? `inbound=${a.inbound}` : null,
	].filter(Boolean);
	return `- ${bits.join(" · ")}${a.summary ? `\n  ${a.summary}` : ""}\n  id: ${a.id}`;
}

export function agentsText(agents: PublicAgent[], selector: string): string {
	if (agents.length === 0) return `No live agents match "${selector}".`;
	return `${agents.length} agent${agents.length === 1 ? "" : "s"} (${selector}):\n${agents.map(agentLine).join("\n")}`;
}

export function messageText(m: DeliveredMessage | Message): string {
	const from = "from" in m ? `${m.from.name} [${m.from.harness}]` : m.fromName;
	return `- ${m.id} · from ${from} · ${ago(m.createdAt)}${m.priority !== "normal" ? ` · ${m.priority}` : ""}${
		m.expectReply ? " · wants a reply" : ""
	}${m.replyTo ? ` · reply to ${m.replyTo}` : ""}\n  ${m.body.replace(/\n/g, "\n  ")}`;
}

export function receiptsText(receipts: Receipt[]): string {
	return receipts
		.map(
			(r) =>
				`- ${r.agentName}: ${r.state}${r.via ? ` via ${r.via}` : ""}${r.detail ? ` (${r.detail})` : ""}`,
		)
		.join("\n");
}
