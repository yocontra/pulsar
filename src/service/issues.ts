import type { IssueDetails, IssueSource } from "../http/wire.ts";
import {
	issueFromBranch,
	issueFromPr,
	issueFromText,
	readIssue,
} from "../issues.ts";
import { githubSlug } from "../prs.ts";
import { RpcError } from "../rpc.ts";
import type { ResolvedTranscript } from "../transcripts/tailer.ts";
import { newParseState, type TranscriptEvent } from "../transcripts/types.ts";
import type { Agent } from "../types.ts";
import { headAsync } from "../util.ts";
import type { Principal } from "./caller.ts";
import type { PoolView } from "./pool.ts";
import type { Registry } from "./registry.ts";

/**
 * GitHub issue awareness for the app: which issue each local agent works
 * on (tagged `issue:<n>`, so `issue=1378` selects it), and the issue's card,
 * read with gh on the agent's own machine (remote agents through their
 * home node, `issue.read`). Read-only.
 *
 * Detection, first hit wins: an `issue:` tag the agent set itself; its
 * branch name; the issue its PR closes (gh, cached for minutes); a `#N` in
 * the operator's first message of the session.
 */

/** How much of the start of a transcript the first-message read parses. */
const HEAD_BYTES = 256 * 1024;

interface IssueOpsOptions {
	registry: Registry;
	pool: () => PoolView | null;
	/** Where an agent's transcript is (the service's resolver). */
	resolve: (
		agent: Agent,
	) => ResolvedTranscript | null | Promise<ResolvedTranscript | null>;
	/** Ask gh which issue an agent's PR closes (off in tests unless asked). */
	prLookup: boolean;
	/** Read the operator's first message from the transcript. */
	firstMessage: boolean;
}

/** The first text the operator typed in a transcript's events, if any. */
export function firstOperatorText(events: TranscriptEvent[]): string | null {
	for (const e of events)
		if (e.role === "user" && e.kind === "text" && !e.subtype && e.text.trim())
			return e.text;
	return null;
}

export class IssueOps {
	private o: IssueOpsOptions;
	/** First operator message per agent session (it never changes once seen). */
	private first = new Map<string, string>();

	constructor(o: IssueOpsOptions) {
		this.o = o;
	}

	/** The issue tags an agent set itself (not the one pulsar detected). */
	private own(agent: Agent): number | null {
		for (const t of agent.tags) {
			if (!t.startsWith("issue:") || t === `issue:${agent.meta.autoIssue}`)
				continue;
			const n = Number(t.slice(6));
			if (Number.isSafeInteger(n) && n > 0) return n;
		}
		return null;
	}

	/** The agent's issue and where it came from, as its tags show it now. */
	current(agent: Agent): { n: number; source: IssueSource } | null {
		const own = this.own(agent);
		if (own) return { n: own, source: "tag" };
		const auto = Number(agent.meta.autoIssue || 0);
		if (auto > 0)
			return {
				n: auto,
				source: (agent.meta.issueFrom as IssueSource) || "branch",
			};
		return null;
	}

	/** The operator's first message in the agent's session, read once. */
	private async firstMessage(agent: Agent): Promise<string | null> {
		const key = `${agent.id}\0${agent.sessionId ?? ""}`;
		const hit = this.first.get(key);
		if (hit !== undefined) return hit;
		if (!this.o.firstMessage) return null;
		const r = await this.o.resolve(agent);
		if (r?.source.kind !== "file") return null;
		let head = await headAsync(r.source.path, HEAD_BYTES);
		// Only whole lines; a header line (pi/omp) parses like any other.
		const nl = head.lastIndexOf("\n");
		head = nl >= 0 ? head.slice(0, nl + 1) : "";
		if (!head) return null;
		let events: TranscriptEvent[] = [];
		try {
			events = r.parse(head, newParseState({ atStart: true, cwd: agent.cwd }));
		} catch {
			return null;
		}
		const text = firstOperatorText(events);
		if (text !== null) this.first.set(key, text);
		return text;
	}

	/** Detects each live local agent's issue and tags it (a background job). */
	async refresh() {
		const reg = this.o.registry;
		const live = new Set<string>();
		for (const agent of reg.live()) {
			if (agent.id.includes("/")) continue;
			live.add(agent.id);
			if (this.own(agent)) {
				reg.setAutoIssue(agent, null, null);
				continue;
			}
			let n = issueFromBranch(agent.branch);
			let from: IssueSource = "branch";
			const pr = Number(agent.meta.autoPr || 0) || null;
			if (!n && pr && agent.cwd && this.o.prLookup) {
				n = await issueFromPr(agent.cwd, pr);
				from = "pr";
			}
			if (!n) {
				n = issueFromText(
					await this.firstMessage(agent),
					githubSlug(agent.repoUrl ?? null),
					pr,
				);
				from = "message";
			}
			reg.setAutoIssue(agent, n, n ? from : null);
		}
		for (const key of this.first.keys())
			if (!live.has(key.split("\0")[0]!)) this.first.delete(key);
	}

	/** The issue card for an agent: read where the agent runs. */
	async details(id: string, as?: Principal): Promise<IssueDetails> {
		const agent = this.o.registry.get(id);
		if (!agent) {
			const pool = this.o.pool();
			if (!id.includes("/") || !pool)
				throw new RpcError("not_found", `no agent ${id}`);
			const none: IssueDetails = {
				agent: id,
				number: null,
				issue: null,
				reason: "unsupported",
				message: "That machine runs an older Pulsar.",
			};
			if (!pool.issueRead) return none;
			try {
				const r = (await pool.issueRead(id, as)) as IssueDetails;
				return { ...r, agent: id };
			} catch (e) {
				if (e instanceof RpcError && e.code === "unsupported") return none;
				throw e;
			}
		}
		// The number comes from the agent's own tags, never from the caller.
		const cur = this.current(agent);
		if (!cur)
			return { agent: id, number: null, issue: null, reason: "no_issue" };
		const base = { agent: id, number: cur.n, source: cur.source };
		if (!agent.cwd) return { ...base, issue: null, reason: "no_github" };
		return { ...base, ...(await readIssue(agent.cwd, cur.n)) };
	}
}
