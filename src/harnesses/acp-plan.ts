import { createHash } from "node:crypto";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { TranscriptEvent, TranscriptTodo } from "../transcripts/types.ts";

export type AcpPlanUpdate = Extract<
	SessionUpdate,
	{ sessionUpdate: "plan" | "plan_update" | "plan_removed" }
>;

export function isPlanUpdate(update: SessionUpdate): update is AcpPlanUpdate {
	return (
		update.sessionUpdate === "plan" ||
		update.sessionUpdate === "plan_update" ||
		update.sessionUpdate === "plan_removed"
	);
}

export function planKey(sessionId: string, update: AcpPlanUpdate): string {
	const plan = update.sessionUpdate === "plan_update" ? update.plan : update;
	return createHash("sha256")
		.update(JSON.stringify([sessionId, "planId" in plan ? plan.planId : null]))
		.digest("hex");
}

export function acpPlanEvent(
	sessionId: string,
	update: AcpPlanUpdate,
): Omit<TranscriptEvent, "ts"> {
	const plan = update.sessionUpdate === "plan_update" ? update.plan : update;
	const id = planKey(sessionId, update);
	const event = {
		id: `acp:plan:${id}`,
		role: "assistant",
		kind: "text",
	} as const;
	if ("type" in plan && plan.type === "markdown" && plan.content)
		return {
			...event,
			text:
				plan.content.length > 32768
					? `${plan.content.slice(0, 32768)}…`
					: plan.content,
		};
	const checklist: TranscriptTodo[] = [];
	let remaining = 24 * 1024;
	if ("entries" in plan) {
		for (const { content, priority, status } of plan.entries) {
			if (remaining <= 0 || checklist.length === 256) break;
			const text =
				content.length > remaining
					? `${content.slice(0, remaining)}…`
					: content;
			remaining -= Buffer.byteLength(JSON.stringify(text));
			checklist.push({
				text,
				priority,
				status:
					status === "completed"
						? "done"
						: status === "in_progress"
							? "active"
							: "todo",
			});
		}
	}
	return {
		...event,
		checklist,
		...("entries" in plan && plan.entries.length > checklist.length
			? { checklistOmitted: plan.entries.length - checklist.length }
			: {}),
		text: checklist
			.map(
				({ text, status }) =>
					`- [${status === "done" ? "x" : status === "active" ? "~" : " "}] ${text}`,
			)
			.join("\n"),
	};
}

/** Providers may send the entire unchanged checklist after every tool call. */
export class AcpPlans {
	private readonly latest = new Map<string, string>();

	apply(sessionId: string, update: AcpPlanUpdate) {
		const event = acpPlanEvent(sessionId, update);
		const digest = createHash("sha256")
			.update(JSON.stringify(event))
			.digest("hex");
		if (this.latest.get(event.id) === digest) return null;
		this.latest.delete(event.id);
		this.latest.set(event.id, digest);
		if (this.latest.size > 256)
			this.latest.delete(this.latest.keys().next().value!);
		return event;
	}
}
