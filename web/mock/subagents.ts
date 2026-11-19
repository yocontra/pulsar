/**
 * Mock subagents (docs/subagents.md), shaped like the daemon's: apparish-auth
 * (Claude Code) runs four: an Explore task still running, a finished task
 * that started a nested one, and an idle teammate. The running and the
 * finished task are linked from Task cards in its transcript. Claude Code subagents
 * can't take messages, so the composer offers the parent. The first OpenCode
 * agent on studio has one child session that takes messages directly.
 */
import type {
	SubagentCounts,
	SubagentList,
	SubagentRow,
	TranscriptEvent,
} from "../../src/http/wire.ts";
import { agents, FIX, type MockAgent, NOW0 } from "./data.ts";
import { logFor } from "./transcript.ts";

const subs = new Map<string, SubagentRow[]>();
const logs = new Map<string, TranscriptEvent[]>();

function note(harness: string, parent: string) {
	return harness === "opencode"
		? {
				mode: "direct" as const,
				note: "Goes straight into this subagent's own OpenCode session.",
			}
		: {
				mode: "parent" as const,
				note: `Claude Code subagents can't receive messages from Pulsar. This goes to the parent agent, ${parent}, naming the subagent.`,
			};
}

function make(
	parent: MockAgent,
	key: string,
	o: Partial<SubagentRow> & Pick<SubagentRow, "name" | "state" | "kind">,
): SubagentRow {
	return {
		id: `${parent.id}/sub:${key}`,
		parentId: parent.id,
		harness: parent.harness,
		agentType: null,
		description: null,
		startedAt: NOW0 - 10 * 60_000,
		updatedAt: NOW0 - 30_000,
		finishedAt: null,
		callId: null,
		parentSubId: null,
		hasTranscript: true,
		messaging: note(parent.harness, parent.name),
		...o,
	};
}

function log(id: string, task: string, reply: string, done: boolean) {
	const t = NOW0 - 9 * 60_000;
	const events: TranscriptEvent[] = [
		{ id: `${id}#u`, ts: t, role: "user", kind: "text", text: task },
		{
			id: `${id}#c`,
			ts: t + 2000,
			role: "assistant",
			kind: "tool_call",
			text: "",
			tool: {
				name: "Grep",
				callId: `${id}-grep`,
				input: { pattern: "refresh\\(" },
				summary: "Searched refresh\\(",
				done: true,
			},
		},
		{
			id: `${id}#r`,
			ts: t + 3000,
			role: "tool",
			kind: "tool_result",
			text: "src/auth/session.ts\nsrc/api.ts\nsrc/middleware.ts",
			tool: { name: "Grep", callId: `${id}-grep`, summary: "3 files" },
		},
	];
	if (done)
		events.push({
			id: `${id}#a`,
			ts: t + 5000,
			role: "assistant",
			kind: "text",
			text: reply,
		});
	logs.set(id, events);
}

/**
 * A Task call in a mock agent's log, newest first (`back` 0), so its card
 * links to the subagent.
 */
function taskCall(a: MockAgent, back = 0): string | null {
	const calls = logFor(a)
		.events.filter((e) => e.kind === "tool_call" && e.tool?.name === "Task")
		.map((e) => e.tool!.callId);
	return calls[calls.length - 1 - back] ?? null;
}

function seed() {
	const auth = FIX.auth;
	const list = [
		make(auth, "a1explore", {
			name: "Find other refresh callers",
			kind: "task",
			agentType: "Explore",
			state: "running",
			startedAt: NOW0 - 90_000,
			updatedAt: NOW0 - 5_000,
			callId: taskCall(auth),
		}),
		make(auth, "a2fix", {
			name: "Write the regression test",
			kind: "task",
			agentType: "general-purpose",
			state: "done",
			startedAt: NOW0 - 20 * 60_000,
			updatedAt: NOW0 - 12 * 60_000,
			finishedAt: NOW0 - 12 * 60_000,
			// The card before the newest: a finished subagent stays reachable
			// from it with "Show finished subagents" off.
			callId: taskCall(auth, 1),
		}),
		make(auth, "a3nested", {
			name: "Check the test runner flags",
			kind: "task",
			agentType: "Explore",
			state: "done",
			startedAt: NOW0 - 18 * 60_000,
			updatedAt: NOW0 - 15 * 60_000,
			finishedAt: NOW0 - 15 * 60_000,
			parentSubId: `${auth.id}/sub:a2fix`,
		}),
		make(auth, "a4mate", {
			name: "reviewer",
			kind: "teammate",
			agentType: "general-purpose",
			description: "Review the refresh fix",
			state: "idle",
			startedAt: NOW0 - 40 * 60_000,
			updatedAt: NOW0 - 6 * 60_000,
		}),
	];
	subs.set(auth.id, list);
	log(list[0]!.id, "List every caller of refresh().", "", false);
	log(
		list[1]!.id,
		"Write a regression test for the refresh race.",
		"Added `session.test.ts`: two concurrent refreshes now share one request.",
		true,
	);
	log(
		list[2]!.id,
		"Which flags does the test runner take?",
		"`--rerun-each` and `--timeout`.",
		true,
	);
	log(
		list[3]!.id,
		"Review the refresh fix.",
		"Waiting for the next task.",
		true,
	);
	const oc = agents.find(
		(a) =>
			a.harness === "opencode" &&
			a.machine === "studio" &&
			a.status !== "offline",
	);
	if (oc) {
		const kid = make(oc, "ses_mockkid", {
			name: "explore the repo",
			kind: "session",
			agentType: "explore",
			state: "running",
			hasTranscript: false,
		});
		subs.set(oc.id, [kid]);
	}
}

let seeded = false;
function ensure() {
	if (!seeded) {
		seeded = true;
		seed();
	}
}

/** `AgentRow.subagents` for a mock agent. */
export function subagentCounts(agentId: string): SubagentCounts | undefined {
	ensure();
	const list = subs.get(agentId);
	if (!list?.length) return undefined;
	return {
		total: list.length,
		running: list.filter((s) => s.state === "running").length,
		done: list.filter((s) => s.state === "done").length,
	};
}

export function subagentList(agentId: string): SubagentList | null {
	ensure();
	const items = subs.get(agentId);
	if (!items) return null;
	return {
		agentId,
		items,
		total: items.length,
		running: items.filter((s) => s.state === "running").length,
	};
}

export function subagentById(id: string): SubagentRow | undefined {
	ensure();
	const at = id.lastIndexOf("/sub:");
	if (at <= 0) return undefined;
	return subs.get(id.slice(0, at))?.find((s) => s.id === id);
}

export function subagentTranscript(id: string) {
	ensure();
	const sub = subagentById(id);
	if (!sub) return null;
	if (!sub.hasTranscript) return { events: [], cursor: null, available: false };
	return { events: logs.get(id) ?? [], cursor: null, available: true };
}

/** The body a redirected message carries (as the daemon's `forParentBody`). */
export function forParentBody(sub: SubagentRow, body: string) {
	return `For your subagent "${sub.name}" (${sub.id.slice(sub.id.lastIndexOf("/sub:") + 5)}): ${body}`;
}
