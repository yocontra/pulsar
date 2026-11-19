import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../src/types.ts";

/** Synthetic subagent files and agent records for the subagent tests (never real sessions). */

export function agentRecord(over: Partial<Agent> = {}): Agent {
	return {
		id: "claude:0000aaaa-1111-4222-8333-444455556666",
		name: "lead",
		harness: "claude",
		sessionId: "0000aaaa-1111-4222-8333-444455556666",
		pid: null,
		cwd: "/work/demo",
		project: "demo",
		branch: "main",
		tags: [],
		status: "busy",
		model: null,
		activity: null,
		inbound: "accept",
		registered: true,
		reach: "push",
		lastSeen: 0,
		createdAt: 0,
		meta: {},
		...over,
	};
}

export const rec = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

/** A Claude subagent: its log (one user and one assistant record) and meta. */
export function writeClaudeSub(
	sessionDir: string,
	key: string,
	meta: Record<string, unknown>,
	opts: { mtime?: number; started?: string } = {},
) {
	const sub = join(sessionDir, "subagents");
	mkdirSync(sub, { recursive: true });
	const file = join(sub, `agent-${key}.jsonl`);
	const ts = opts.started ?? "2026-11-10T10:00:00.000Z";
	writeFileSync(
		file,
		rec({
			type: "user",
			uuid: `${key}-u1`,
			isSidechain: true,
			agentId: key,
			timestamp: ts,
			message: { role: "user", content: `task for ${key}` },
		}) +
			rec({
				type: "assistant",
				uuid: `${key}-a1`,
				isSidechain: true,
				agentId: key,
				timestamp: ts,
				message: {
					id: `msg_${key}`,
					role: "assistant",
					content: [{ type: "text", text: `done by ${key}` }],
				},
			}),
	);
	writeFileSync(join(sub, `agent-${key}.meta.json`), JSON.stringify(meta));
	if (opts.mtime) {
		const t = opts.mtime / 1000;
		utimesSync(file, t, t);
	}
	return file;
}
