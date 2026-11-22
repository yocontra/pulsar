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

/**
 * A Claude subagent: its log (one user and one assistant record) and meta.
 * The assistant record is stamped `last`, else at `mtime` (when it last
 * worked), else now (as the file's own mtime). `trailer` appends records with no timestamp,
 * as Claude does on resume.
 */
export function writeClaudeSub(
	sessionDir: string,
	key: string,
	meta: Record<string, unknown>,
	opts: {
		mtime?: number;
		started?: string;
		last?: string;
		trailer?: string;
	} = {},
) {
	const sub = join(sessionDir, "subagents");
	mkdirSync(sub, { recursive: true });
	const file = join(sub, `agent-${key}.jsonl`);
	const ts = opts.started ?? "2026-11-10T10:00:00.000Z";
	const last = opts.last ?? new Date(opts.mtime ?? Date.now()).toISOString();
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
				timestamp: last,
				message: {
					id: `msg_${key}`,
					role: "assistant",
					content: [{ type: "text", text: `done by ${key}` }],
				},
			}) +
			(opts.trailer ?? ""),
	);
	writeFileSync(join(sub, `agent-${key}.meta.json`), JSON.stringify(meta));
	if (opts.mtime) {
		const t = opts.mtime / 1000;
		utimesSync(file, t, t);
	}
	return file;
}

/** A Claude agent team's config: `teams/<name>/config.json` under `configDir`. */
export function writeClaudeTeam(
	configDir: string,
	name: string,
	leadSessionId: string,
	members: Array<{ name: string; joinedAt?: number }>,
	opts: { mtime?: number } = {},
) {
	const dir = join(configDir, "teams", name);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "config.json");
	writeFileSync(
		file,
		JSON.stringify({
			name,
			leadSessionId,
			members: [
				{ agentId: `team-lead@${name}`, name: "team-lead", joinedAt: 1 },
				...members.map((m) => ({
					agentId: `${m.name}@${name}`,
					name: m.name,
					joinedAt: m.joinedAt ?? 1,
					backendType: "in-process",
				})),
			],
		}),
	);
	// A distinct mtime per write, so a cached copy is never kept by mistake.
	const t = (opts.mtime ?? Date.now()) / 1000;
	utimesSync(file, t, t);
	return file;
}
