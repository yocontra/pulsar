/**
 * Ask, without waking anyone: parse a question into what it is about, pull
 * the files an agent touched out of its transcript events, and rank agents
 * with evidence. Pure (types only), shared by the daemon and the app's mock.
 */

import { ago } from "../format.ts";
import type {
	AgentRow,
	AskIntent,
	AskMatch,
	AskResponse,
	TranscriptEvent,
} from "../http/wire.ts";
import { shortPath } from "../transcripts/summary.ts";

/** One file an agent changed, from a tool call in its transcript. */
export interface Touch {
	/** Absolute when the agent's folder is known, else as the tool gave it. */
	path: string;
	at: number;
	/** "Edited", "Wrote", "Patched", "Deleted". */
	verb: string;
}

/** What the index knows about one agent's recent work. */
export interface AgentWork {
	touches: Touch[];
	/** The newest assistant text, cut to one paragraph. */
	lastText: string | null;
	lastTextAt: number | null;
}

const EDIT_TOOLS = new Set([
	"edit",
	"multiedit",
	"str_replace",
	"str_replace_editor",
	"str_replace_based_edit_tool",
	"notebookedit",
	"edit_file",
	"replace",
]);
const WRITE_TOOLS = new Set(["write", "create", "write_file", "create_file"]);
const PATCH_TOOLS = new Set(["apply_patch", "patch", "multi_patch"]);
const SHELL_TOOLS = new Set([
	"bash",
	"shell",
	"exec_command",
	"local_shell",
	"exec",
]);

function record(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v ? v : undefined;
}

function resolvePath(path: string, cwd: string | null): string {
	if (path.startsWith("/") || !cwd) return path;
	const parts = `${cwd}/${path}`.split("/");
	const out: string[] = [];
	for (const p of parts) {
		if (p === "..") out.pop();
		else if (p && p !== ".") out.push(p);
	}
	return `/${out.join("/")}`;
}

/** Files named in an `apply_patch` envelope (`*** Update File: x`). */
export function patchFiles(patch: string): { path: string; verb: string }[] {
	const out: { path: string; verb: string }[] = [];
	for (const line of patch.split("\n")) {
		const m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line.trim());
		if (m)
			out.push({
				path: m[2]!.trim(),
				verb:
					m[1] === "Add" ? "Wrote" : m[1] === "Delete" ? "Deleted" : "Patched",
			});
		const moved = /^\*\*\* Move to: (.+)$/.exec(line.trim());
		if (moved) out.push({ path: moved[1]!.trim(), verb: "Wrote" });
	}
	return out;
}

/** The files a tool call changed (empty for reads, searches and the rest). */
export function callTouches(
	name: string,
	input: unknown,
	cwd: string | null,
): { path: string; verb: string }[] {
	const lower = name.toLowerCase();
	const args = record(input) ?? {};
	const path =
		str(args.file_path) ??
		str(args.path) ??
		str(args.filePath) ??
		str(args.notebook_path) ??
		str(args.target_file);
	let found: { path: string; verb: string }[] = [];
	if (EDIT_TOOLS.has(lower) && path) found = [{ path, verb: "Edited" }];
	else if (WRITE_TOOLS.has(lower) && path) found = [{ path, verb: "Wrote" }];
	else if (PATCH_TOOLS.has(lower)) {
		const patch =
			typeof input === "string"
				? input
				: (str(args.input) ?? str(args.patch) ?? str(args.patchText) ?? "");
		found = patchFiles(patch);
		if (!found.length && path) found = [{ path, verb: "Patched" }];
	} else if (SHELL_TOOLS.has(lower)) {
		// Codex runs `apply_patch` through its shell tool too.
		const cmd =
			args.command ?? args.cmd ?? (typeof input === "string" ? input : "");
		const text = Array.isArray(cmd) ? cmd.join("\n") : (str(cmd) ?? "");
		if (text.includes("*** Begin Patch")) found = patchFiles(text);
	}
	return found.map((f) => ({ ...f, path: resolvePath(f.path, cwd) }));
}

/** Touches and the newest assistant text from a run of transcript events. */
export function workFrom(
	events: TranscriptEvent[],
	cwd: string | null,
	maxTouches = 100,
): AgentWork {
	const byPath = new Map<string, Touch>();
	let lastText: string | null = null;
	let lastTextAt: number | null = null;
	for (const e of events) {
		if (e.kind === "tool_call" && e.tool)
			for (const t of callTouches(e.tool.name, e.tool.input, cwd)) {
				const prev = byPath.get(t.path);
				if (!prev || prev.at <= e.ts)
					byPath.set(t.path, { path: t.path, verb: t.verb, at: e.ts });
			}
		if (
			e.role === "assistant" &&
			e.kind === "text" &&
			!e.sidechain &&
			e.text.trim() &&
			(lastTextAt === null || e.ts >= lastTextAt)
		) {
			lastText = e.text
				.trim()
				.split(/\n\s*\n/)[0]!
				.slice(0, 280);
			lastTextAt = e.ts;
		}
	}
	const touches = [...byPath.values()]
		.sort((a, b) => b.at - a.at)
		.slice(0, maxTouches);
	return { touches, lastText, lastTextAt };
}

const STOP = new Set(
	"who what whos who's is are was the a an on in of to for and or with working work doing editing edited edit touched touching changed changing recently lately now right file files path idle busy any anyone somebody someone agent agents project projects machine branch pr issue ticket me tell about there has have".split(
		" ",
	),
);

/**
 * What a question is about. Paths (anything with a slash or a file
 * extension), `#123` / "PR 123" / "issue 123", branches, projects, machines
 * and agent names the pool knows, and idle/busy.
 */
export function parseQuestion(question: string, rows: AgentRow[]): AskIntent {
	const q = question.trim();
	const words = q.split(/[\s,?!;:()"'`]+/).filter(Boolean);
	const lower = q.toLowerCase();
	const known = (pick: (r: AgentRow) => string | null | undefined) =>
		new Set(
			rows
				.map(pick)
				.filter((v): v is string => Boolean(v))
				.map((v) => v.toLowerCase()),
		);
	const projects = known((r) => r.project);
	const machines = known((r) => r.machine);
	const branches = known((r) => r.branch);
	const names = known((r) => r.name);
	const intent: AskIntent = {
		paths: [],
		numbers: [],
		branches: [],
		projects: [],
		machines: [],
		agents: [],
		state: null,
		words: [],
	};
	const add = (list: string[], v: string) => {
		if (!list.includes(v)) list.push(v);
	};
	for (const m of q.matchAll(
		/(?:#|\b(?:pr|pull request|issue|ticket)\s*#?)(\d{1,7})\b/gi,
	))
		add(intent.numbers, m[1]!);
	if (/\bidle\b|\bfree\b|\bavailable\b/.test(lower)) intent.state = "idle";
	else if (/\bbusy\b/.test(lower)) intent.state = "busy";
	for (const raw of words) {
		const w = raw.replace(/^[.]+|[.]+$/g, "");
		const lw = w.toLowerCase();
		if (!w || /^#?\d+$/.test(w)) continue;
		if (names.has(lw) || names.has(lw.replace(/^@/, "")))
			add(intent.agents, lw.replace(/^@/, ""));
		else if (branches.has(lw)) add(intent.branches, lw);
		else if (projects.has(lw)) add(intent.projects, lw);
		else if (machines.has(lw)) add(intent.machines, lw);
		else if (w.includes("/") || /\.[a-z0-9]{1,8}$/i.test(w))
			add(intent.paths, w.replace(/^\.\//, ""));
		else if (!STOP.has(lw) && lw.length > 2) add(intent.words, lw);
	}
	return intent;
}

/** True when `path` is the asked path or ends with it at a `/` boundary. */
function pathMatches(path: string, asked: string): boolean {
	const a = asked.replace(/^\/+/, "");
	return path === asked || path.endsWith(`/${a}`) || path === a;
}

/**
 * Ranks agents for a parsed question. `work` returns what the index knows
 * about an agent (null when it was not read). Agents with no evidence are
 * left out, except that a question naming only a project, machine or state
 * lists who is there.
 */
export function rank(
	question: string,
	intent: AskIntent,
	rows: AgentRow[],
	work: (row: AgentRow) => AgentWork | null,
	now = Date.now(),
	max = 20,
): AskResponse {
	const matches: AskMatch[] = [];
	const scoped =
		intent.projects.length > 0 ||
		intent.machines.length > 0 ||
		intent.state !== null;
	const specific =
		intent.paths.length +
			intent.numbers.length +
			intent.branches.length +
			intent.agents.length +
			intent.words.length >
		0;
	for (const r of rows) {
		if (
			intent.projects.length &&
			!intent.projects.includes((r.project ?? "").toLowerCase())
		)
			continue;
		if (
			intent.machines.length &&
			!intent.machines.includes((r.machine ?? "").toLowerCase())
		)
			continue;
		if (intent.state === "idle" && r.state !== "idle") continue;
		if (intent.state === "busy" && r.state !== "busy") continue;
		const evidence: string[] = [];
		let score = 0;
		const w = specific ? work(r) : null;
		for (const p of intent.paths)
			for (const t of w?.touches ?? [])
				if (pathMatches(t.path, p)) {
					evidence.push(
						`${t.verb} ${shortPath(t.path, r.cwd)} ${ago(t.at, now)}`,
					);
					// Recent edits rank first.
					score += 100 + Math.max(0, 50 - (now - t.at) / 60_000);
				}
		const pr = r.tags.find((t) => t.startsWith("pr:"))?.slice(3) ?? null;
		for (const n of intent.numbers) {
			if (pr === n) {
				evidence.push(`PR #${n}`);
				score += 120;
			}
			if (r.branch?.includes(n)) {
				evidence.push(`branch ${r.branch}`);
				score += 80;
			}
			if (r.activity?.includes(n)) {
				evidence.push(`says: ${r.activity}`);
				score += 60;
			}
			if (w?.lastText?.includes(`#${n}`) || w?.lastText?.includes(n)) {
				evidence.push(`mentioned ${n} ${ago(w.lastTextAt ?? now, now)}`);
				score += 30;
			}
		}
		for (const b of intent.branches)
			if ((r.branch ?? "").toLowerCase() === b) {
				evidence.push(`branch ${r.branch}`);
				score += 100;
			}
		if (intent.agents.includes(r.name.toLowerCase())) {
			score += 200;
			if (r.activity) evidence.push(`says: ${r.activity}`);
			if (w?.lastText) evidence.push(`last said: ${w.lastText}`);
			const t = w?.touches[0];
			if (t)
				evidence.push(
					`${t.verb} ${shortPath(t.path, r.cwd)} ${ago(t.at, now)}`,
				);
			if (!evidence.length)
				evidence.push(`${r.state}, seen ${ago(r.lastSeen, now)}`);
		}
		for (const word of intent.words) {
			const hay =
				`${r.branch ?? ""} ${r.activity ?? ""} ${r.tags.join(" ")}`.toLowerCase();
			if (hay.includes(word)) {
				// Name the field that matched: activity, branch, else the tag.
				const tag = r.tags.find((t) => t.toLowerCase().includes(word));
				evidence.push(
					r.activity?.toLowerCase().includes(word)
						? `says: ${r.activity}`
						: r.branch?.toLowerCase().includes(word)
							? `branch ${r.branch}`
							: `tag ${tag}`,
				);
				score += 20;
			} else if (w?.touches.some((t) => t.path.toLowerCase().includes(word))) {
				const t = w.touches.find((t) => t.path.toLowerCase().includes(word))!;
				evidence.push(
					`${t.verb} ${shortPath(t.path, r.cwd)} ${ago(t.at, now)}`,
				);
				score += 15;
			}
		}
		if (!specific && scoped) {
			evidence.push(
				[
					r.state,
					r.branch && `branch ${r.branch}`,
					r.activity && `says: ${r.activity}`,
				]
					.filter(Boolean)
					.join(" · "),
			);
			score += r.state === "idle" ? 2 : 1;
		}
		if (score > 0)
			matches.push({
				agent: r,
				score: Math.round(score),
				evidence: [...new Set(evidence)],
			});
	}
	matches.sort(
		(a, b) => b.score - a.score || b.agent.lastSeen - a.agent.lastSeen,
	);
	return {
		question,
		intent,
		matches: matches.slice(0, max),
		total: matches.length,
		scanned: rows.length,
	};
}

/** An answer without evidence quoted from transcripts ("last said: …"). */
export function withoutTranscriptText(r: AskResponse): AskResponse {
	return {
		...r,
		matches: r.matches.map((m) => ({
			...m,
			evidence: m.evidence.filter(
				(e) => !e.startsWith("last said: ") && !e.startsWith("mentioned "),
			),
		})),
	};
}
