import { createHash } from "node:crypto";
/**
 * Development and e2e mock of the pulsar HTTP API (`/api/v1`), plus a static
 * server for the built app in dist/web with the daemon's headers and CSP.
 *
 * Every response is typed with the daemon's wire contract (src/http/wire.ts)
 * and follows the daemon's behavior (src/transport/http.ts,
 * src/service/views.ts, src/service/app.ts, src/http/events.ts). What the
 * mock adds is a simulated pool: ~200 machines (some asleep or down), live
 * status churn, streaming transcripts and receipts that move on their own.
 *
 *   bun web/mock/server.ts            # http://127.0.0.1:47337
 *   PULSAR_MOCK_PORT=4000 bun web/mock/server.ts
 *   PULSAR_MOCK_FEATURES=approvals   # later-phase features, for UI work
 *   PULSAR_MOCK_POOL=small           # four machines, ~80 agents (README shots)
 *   PULSAR_MOCK_STREAM=0             # open sessions stop growing
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson } from "../../src/canonical.ts";
import { generateVapidKeys } from "../../src/push/webpush.ts";
import { RpcError } from "../../src/rpc.ts";
import {
	matches,
	parseSelector,
	type Selector,
	withoutKey,
} from "../../src/selector.ts";
import { actDigest } from "../../src/service/acting.ts";
import {
	type AgentWork,
	parseQuestion,
	rank,
	workFrom,
} from "../../src/service/ask-core.ts";
import type { Principal } from "../../src/service/caller.ts";
import {
	answerApproves,
	answerHash,
	answerLabel,
	cleanAnswer,
	needsDetail as interactionDetail,
} from "../../src/service/interactions.ts";
import {
	type ApprovalBinding,
	MemoryPasskeyStore,
	Passkeys,
} from "../../src/service/passkeys.ts";
import { UserSessions } from "../../src/service/user-sessions.ts";
import { isAutoTag } from "../../src/tags.ts";
import { serveStatic } from "../../src/transport/static.ts";
import type {
	AgentRow,
	AgentSort,
	AgentsPage,
	Approval,
	ApprovalDecision,
	AskRequest,
	AskResponse,
	AttentionItem,
	AttentionList,
	DeliveredMessage,
	DryRun,
	Facet,
	FacetKey,
	FacetsResponse,
	Feature,
	Hello,
	InteractionAnswer,
	LimitWarning,
	ListUpdate,
	MachineCount,
	Message,
	Page,
	Priority,
	ReceiptRow,
	ReceiptState,
	ReceiptsPage,
	Rollup,
	SearchResponse,
	SecurityNotice,
	SendDone,
	ServerEventName,
	ServerEvents,
	StopResult,
	Subscription,
	TreeGroup,
	TreeNode,
	TreeSort,
	UsagePeriod,
	UserSessionInfo,
	Wake,
} from "../src/api/types.ts";
import { openUpload, putFile, searchFiles } from "./attachments.ts";
import {
	changeFile,
	changesSummary,
	editChanges,
	resetChanges,
} from "./changes.ts";
import {
	agentById,
	agents,
	BLOCKS,
	FIX,
	type MockAgent,
	machineByName,
	machineReason,
	machines,
	makeAgent,
	makeApproval,
	makeInteraction,
	OMP_BLOCKS,
	rng,
} from "./data.ts";
import {
	GitMockError,
	gitCommit,
	gitControl,
	gitCreatePr,
	gitPrDetails,
	gitPush,
	gitStatus,
	resetGit,
} from "./git.ts";
import { CHART, SAMPLE_PDF, SCREENSHOT } from "./images.ts";
import { issueControl, issueDetails } from "./issues.ts";
import { launchRoute } from "./launch.ts";
import { searchMessages } from "./search.ts";
import {
	forParentBody,
	subagentById,
	subagentCounts,
	subagentList,
	subagentTranscript,
} from "./subagents.ts";
import {
	appendLine,
	appendOperatorTurn,
	findImage,
	page as transcriptPage,
	step as transcriptStep,
} from "./transcript.ts";
import {
	agentUsage,
	mockUsage,
	setLimitSettings,
	setPrice,
	usageLimits,
	usageReport,
} from "./usage.ts";

/** How the app names each harness ("handed to Claude Code"). */
const HARNESS_NAMES: Record<string, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
};

const PORT = Number(process.env.PULSAR_MOCK_PORT ?? 47337);
const STATIC = resolve(import.meta.dir, "../../dist/web");
const LIVE = process.env.PULSAR_MOCK_LIVE !== "0";
/** PULSAR_MOCK_STREAM=0: an open session does not grow (still screenshots). */
const STREAM = process.env.PULSAR_MOCK_STREAM !== "0";
/** The daemon's CSP (src/transport/http.ts). */
const CSP =
	process.env.PULSAR_MOCK_CSP ??
	"default-src 'self'; script-src 'self'; img-src 'self' data: blob:; frame-src blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

/** The daemon's features (src/service/app.ts), plus any from PULSAR_MOCK_FEATURES. */
const FEATURES: Feature[] = [
	...new Set<Feature>([
		"tree",
		"facets",
		"send",
		"events",
		"transcripts",
		"receipts",
		"stop",
		"approvals",
		"push",
		"ask",
		"usage",
		"attachments",
		"launch",
		"git",
		"issues",
		"search",
		...((process.env.PULSAR_MOCK_FEATURES ?? "")
			.split(",")
			.map((f) => f.trim())
			.filter(Boolean) as Feature[]),
	]),
];
const has = (f: Feature) => FEATURES.includes(f);

/**
 * Like the daemon's drivers: never offline agents, and a Claude session only
 * inside tmux (about half of them here, picked by id).
 */
function canStop(a: { id: string; harness: string; status: string }) {
	if (!has("stop") || a.status === "offline") return false;
	if (a.harness !== "claude") return true;
	let h = 0;
	for (const ch of a.id) h = (h + ch.charCodeAt(0)) % 997;
	return h % 2 === 0;
}

const LOCAL = "studio";
const LOGIN = "you@example.com";
const CONFIRM_ABOVE = 25;
const MAX_DRIFT = 0.05;
const TOKEN_MS = 10 * 60_000;
const WAKES: Wake[] = ["wakes", "inbox-only", "held", "refuses", "queued"];

const rand = rng(77);
/**
 * No random delivery failures (the e2e config sets it): which send draws the
 * 2% depends on test order and timing, so a test's own send could fail.
 */
const STEADY = process.env.PULSAR_MOCK_STEADY === "1";

class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(message);
	}
}
const badRequest = (m: string) => new ApiError(400, "bad_request", m);
const notFound = (m: string) => new ApiError(404, "not_found", m);

// ------------------------------------------------------------------ rows

function address(a: MockAgent) {
	return `${a.machineId}/${a.id}`;
}

/** A mock agent as the daemon's `AgentRow`. */
function row(a: MockAgent): AgentRow {
	const needs = a.status === "needs-you";
	return {
		id: a.id,
		name: a.name,
		harness: a.harness,
		sessionId: a.id.slice(a.id.indexOf(":") + 1),
		pid: null,
		// The gallery's logs run in /work/demo (web/mock/blocks.ts).
		cwd:
			a === BLOCKS || a === OMP_BLOCKS
				? "/work/demo"
				: a.project
					? `~/Projects/${a.project}`
					: null,
		project: a.project,
		branch: a.branch,
		...(a.repoUrl ? { repoUrl: a.repoUrl } : {}),
		machine: a.machine,
		tags: needs ? [...a.tags, "needs:you"] : a.tags,
		// The harness status under the shown state.
		status:
			a.status === "offline" ? "gone" : a.status === "busy" ? "busy" : "idle",
		model: a.model,
		activity: a.activity,
		inbound: a.inbound,
		registered: true,
		reach: a.reach,
		lastSeen: a.lastActive,
		createdAt: a.lastActive - 6 * 3_600_000,
		machineId: a.machineId,
		address: address(a),
		state: a.status,
		stateSince: a.statusSince,
		needsYou: needs
			? {
					reason: a.needs ?? "asked",
					since: a.statusSince,
					detail: needsDetail(a),
				}
			: null,
		wake: a.wake,
		hasTranscript: a.hasTranscript,
		canStop: canStop(a),
		...(subagentCounts(a.id) ? { subagents: subagentCounts(a.id)! } : {}),
	};
}

function needsDetail(a: MockAgent): string | null {
	if (a.needs === "approval")
		return a.approval
			? interactionDetail(
					a.approval.kind ?? "permission",
					a.approval.tool,
					a.approval.prompt ?? null,
				)
			: null;
	if (a.needs === "terminal")
		return "Waiting in the terminal: permission prompt";
	return a.question ?? null;
}

/** The tree filter box: a selector, or one plain word meaning `~word`. */
function filterSelector(filter: string | null | undefined): string {
	const f = filter?.trim() ?? "";
	if (!f) return "*";
	return /[=~#*\s,]/.test(f) ? f : `~${f}`;
}

function matching(selector: string | Selector | null | undefined) {
	const sel =
		typeof selector === "object" && selector
			? selector
			: parseSelector((selector as string | null | undefined) ?? "*");
	if (sel.kind === "all") return agents;
	return agents.filter((a) => matches(row(a), sel));
}

function emptyRollup(): Rollup {
	return {
		agents: 0,
		needsYou: 0,
		busy: 0,
		idle: 0,
		offline: 0,
		lastActive: null,
	};
}

function rollup(list: MockAgent[]): Rollup {
	const r = emptyRollup();
	for (const a of list) {
		r.agents++;
		if (a.status === "needs-you") r.needsYou++;
		else if (a.status === "busy") r.busy++;
		else if (a.status === "offline") r.offline++;
		else r.idle++;
		r.lastActive = Math.max(r.lastActive ?? 0, a.lastActive);
	}
	return r;
}

const STATE_RANK = { "needs-you": 0, busy: 1, idle: 2, offline: 3 };
function sortAgents(list: MockAgent[], sort: AgentSort = "attention") {
	const byName = (a: MockAgent, b: MockAgent) =>
		a.name.localeCompare(b.name) || address(a).localeCompare(address(b));
	return [...list].sort((a, b) => {
		switch (sort) {
			case "name":
				return byName(a, b);
			case "recent":
				return b.lastActive - a.lastActive || byName(a, b);
			case "busy":
				return (
					Number(b.status === "busy") - Number(a.status === "busy") ||
					byName(a, b)
				);
			case "attention":
				return (
					STATE_RANK[a.status] - STATE_RANK[b.status] ||
					b.lastActive - a.lastActive ||
					byName(a, b)
				);
		}
	});
}

function wakeTotals(list: { wake: Wake }[]): Record<Wake, number> {
	const t = Object.fromEntries(WAKES.map((w) => [w, 0])) as Record<
		Wake,
		number
	>;
	for (const a of list) t[a.wake]++;
	return t;
}

// ------------------------------------------------------------------ paging

function encodeCursor(offset: number) {
	return Buffer.from(`o${offset}`).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): number {
	if (!cursor) return 0;
	const n = /^o(\d{1,9})$/.exec(
		Buffer.from(cursor, "base64url").toString(),
	)?.[1];
	if (n === undefined) throw badRequest("bad cursor");
	return Number(n);
}

function page<T>(all: T[], cursor: string | null, limit: number): Page<T> {
	const offset = decodeCursor(cursor);
	const items = all.slice(offset, offset + limit);
	const next = offset + items.length;
	return {
		items,
		total: all.length,
		nextCursor: next < all.length ? encodeCursor(next) : null,
	};
}

function intParam(
	q: URLSearchParams,
	name: string,
	dflt: number,
	max: number,
): number {
	const raw = q.get(name);
	if (raw === null || raw === "") return dflt;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1 || n > max)
		throw badRequest(`${name}: expected an integer from 1 to ${max}`);
	return n;
}

function enumParam<T extends string>(
	q: URLSearchParams,
	name: string,
	values: readonly T[],
): T | undefined {
	const v = q.get(name);
	if (v === null || v === "") return undefined;
	if (!values.includes(v as T))
		throw badRequest(`${name}: expected one of ${values.join(", ")}`);
	return v as T;
}

const TREE_SORTS = ["needs", "busy", "recent", "name"] as const;
const AGENT_SORTS = ["attention", "recent", "name", "busy"] as const;
const AGENT_SORT: Record<TreeSort, AgentSort> = {
	needs: "attention",
	busy: "busy",
	recent: "recent",
	name: "name",
};

// ------------------------------------------------------------------ tree

const enc = encodeURIComponent;
const machineNodeId = (machineId: string) => `m:${enc(machineId)}`;
const projectNodeId = (project: string | null) => `p:${enc(project ?? "")}`;
const agentNodeId = (a: MockAgent) => `a:${enc(address(a))}`;

function parseNodeId(id: string): { machineId?: string; project?: string } {
	const out: { machineId?: string; project?: string } = {};
	for (const part of id.split("/")) {
		const m = /^([mp]):(.*)$/.exec(part);
		if (!m) throw badRequest(`bad node id ${id}`);
		let value: string;
		try {
			value = decodeURIComponent(m[2]!);
		} catch {
			throw badRequest(`bad node id ${id}`);
		}
		if (m[1] === "m") out.machineId = value;
		else out.project = value;
	}
	return out;
}

function term(key: string, value: string) {
	return `${key}=${value.replace(/[\s,]+/g, "*")}`;
}

function idTerm(list: MockAgent[]) {
	return list.length ? `id=${list.map((a) => a.id).join("|")}` : "id=";
}

function machineNode(machineId: string, list: MockAgent[]): TreeNode {
	const m = machineByName.get(machineId)!;
	const reason = machineReason(m);
	return {
		id: machineNodeId(machineId),
		kind: "machine",
		label: m.name,
		selector: term("machine", m.name),
		machineId,
		machine: m.name,
		project: null,
		link: m.link,
		...(reason ? { reason } : {}),
		rollup: rollup(list),
		childCount: new Set(list.map((a) => a.project)).size,
		agent: null,
	};
}

function projectNode(
	id: string,
	project: string | null,
	list: MockAgent[],
	within: string | null,
): TreeNode {
	const selector =
		project === null
			? idTerm(list)
			: [within ? term("machine", within) : null, term("project", project)]
					.filter(Boolean)
					.join(" ");
	const node: TreeNode = {
		id,
		kind: "project",
		label: project ?? "(no project)",
		selector,
		machineId: within,
		machine: within,
		project,
		link: null,
		rollup: rollup(list),
		childCount: within
			? list.length
			: new Set(list.map((a) => a.machineId)).size,
		agent: null,
	};
	if (within)
		node.elsewhere = new Set(
			agents
				.filter((a) => a.project === project && a.machineId !== within)
				.map((a) => a.machineId),
		).size;
	return node;
}

function agentNode(a: MockAgent): TreeNode {
	return {
		id: agentNodeId(a),
		kind: "agent",
		label: a.name,
		selector: term("id", a.id),
		machineId: a.machineId,
		machine: a.machine,
		project: a.project,
		link: null,
		rollup: null,
		childCount: 0,
		agent: row(a),
	};
}

function groupBy<T, K>(xs: T[], key: (x: T) => K) {
	const m = new Map<K, T[]>();
	for (const x of xs) {
		const k = key(x);
		const l = m.get(k);
		if (l) l.push(x);
		else m.set(k, [x]);
	}
	return m;
}

function sortNodes(
	nodes: TreeNode[],
	sort: TreeSort = "name",
	first: (a: TreeNode, b: TreeNode) => number = () => 0,
) {
	const r = (n: TreeNode) => n.rollup ?? emptyRollup();
	// Simulated federation: machines whose agents are all offline sort last.
	const away = (n: TreeNode) =>
		n.kind === "machine" && r(n).agents > 0 && r(n).offline === r(n).agents
			? 1
			: 0;
	const by: Record<TreeSort, (a: TreeNode, b: TreeNode) => number> = {
		needs: (a, b) => r(b).needsYou - r(a).needsYou || r(b).busy - r(a).busy,
		busy: (a, b) => r(b).busy - r(a).busy,
		recent: (a, b) => (r(b).lastActive ?? 0) - (r(a).lastActive ?? 0),
		name: () => 0,
	};
	return nodes.sort(
		(a, b) =>
			first(a, b) ||
			away(a) - away(b) ||
			by[sort](a, b) ||
			a.label.localeCompare(b.label),
	);
}

const localFirst = (a: TreeNode, b: TreeNode) =>
	Number(b.machineId === LOCAL) - Number(a.machineId === LOCAL);
const noProjectLast = (a: TreeNode, b: TreeNode) =>
	Number(a.project === null) - Number(b.project === null);

function treeNodes(
	group: TreeGroup,
	filter?: string | null,
	sort?: TreeSort,
): TreeNode[] {
	const list = matching(filterSelector(filter));
	if (group === "projects")
		return sortNodes(
			[...groupBy(list, (a) => a.project)].map(([p, l]) =>
				projectNode(projectNodeId(p), p, l, null),
			),
			sort,
			noProjectLast,
		);
	const byMachine = groupBy(list, (a) => a.machineId);
	const nodes = [...byMachine].map(([m, l]) => machineNode(m, l));
	// Simulated federation: a known machine with no agents still shows.
	if (!filter?.trim())
		for (const m of machines)
			if (!byMachine.has(m.id)) nodes.push(machineNode(m.id, []));
	return sortNodes(nodes, sort, localFirst);
}

function childNodes(
	nodeId: string,
	filter?: string | null,
	sort?: TreeSort,
): TreeNode[] {
	const { machineId, project } = parseNodeId(nodeId);
	const list = matching(filterSelector(filter)).filter(
		(a) =>
			(machineId === undefined || a.machineId === machineId) &&
			(project === undefined || (a.project ?? "") === project),
	);
	if (machineId !== undefined && project !== undefined)
		return sortAgents(list, AGENT_SORT[sort ?? "needs"]).map(agentNode);
	if (machineId !== undefined)
		return sortNodes(
			[...groupBy(list, (a) => a.project)].map(([p, l]) =>
				projectNode(
					`${machineNodeId(machineId)}/${projectNodeId(p)}`,
					p,
					l,
					machineId,
				),
			),
			sort,
			noProjectLast,
		);
	return sortNodes(
		[...groupBy(list, (a) => a.machineId)].map(([mid, l]) => {
			const node = machineNode(mid, l);
			return {
				...node,
				id: `${projectNodeId(project ?? null)}/${machineNodeId(mid)}`,
				selector: project
					? `${node.selector} ${term("project", project)}`
					: idTerm(l),
				project: project || null,
				childCount: l.length,
			};
		}),
		sort,
	);
}

// ------------------------------------------------------------------ views

function hello(): Hello {
	return {
		version: "2.0.0-mock",
		machineId: LOCAL,
		machine: LOCAL,
		fedProtocol: [1, 1],
		features: FEATURES,
		you: { login: LOGIN, node: "localhost" },
		appUrl: "https://studio.tail1234.ts.net:7337/",
		machines: machines.length,
		agents: agents.filter((a) => a.status !== "offline").length,
		firstRun: false,
	};
}

/**
 * Ask, like the daemon's Lookup: the same parser and ranking (ask-core), the
 * touched files read from the newest transcript page of the most recently
 * active agents (live ones only).
 */
function ask(question: string, selector?: string): AskResponse {
	const live = matching(selector ?? "*").filter((a) => a.status !== "offline");
	const rows = live.map(row);
	const intent = parseQuestion(question, rows);
	const work = new Map<string, AgentWork>();
	if (
		intent.paths.length +
		intent.numbers.length +
		intent.agents.length +
		intent.words.length
	) {
		const named = new Set(intent.agents);
		const candidates = live
			.filter((a) => a.hasTranscript)
			.sort(
				(x, y) =>
					Number(named.has(y.name.toLowerCase())) -
						Number(named.has(x.name.toLowerCase())) ||
					y.lastActive - x.lastActive,
			)
			.slice(0, 150);
		for (const a of candidates)
			work.set(a.id, workFrom(transcriptPage(a, null).events, null));
	}
	return rank(question, intent, rows, (r) => work.get(r.id) ?? null);
}

/** Who waits on the user: approvals first, newest first (like the daemon). */
function attention(): AttentionList {
	const items: AttentionItem[] = agents
		.filter((a) => a.status === "needs-you")
		.sort(
			(a, b) =>
				Number(b.needs === "approval") - Number(a.needs === "approval") ||
				b.statusSince - a.statusSince,
		)
		.map((a) => {
			const r = row(a);
			const needs = r.needsYou!;
			return {
				id: `${r.address}@${needs.since}`,
				kind: needs.reason,
				agent: r,
				title:
					needs.detail ??
					(needs.reason === "approval" ? "Approval" : "Asked you"),
				createdAt: needs.since,
				...(has("approvals") && a.approval ? { approval: a.approval } : {}),
				...(a.needs === "terminal"
					? {
							terminal: a.expiredApproval
								? { why: "expired" as const, approval: a.expiredApproval }
								: { why: "not-sent" as const },
						}
					: {}),
			};
		});
	return { items, total: items.length };
}

const FACET_KEYS: FacetKey[] = [
	"machine",
	"project",
	"harness",
	"model",
	"branch",
	"status",
	"pr",
	"role",
	"tag",
];

function facetValues(r: AgentRow, key: FacetKey): string[] {
	switch (key) {
		case "machine":
			return r.machine ? [r.machine] : [];
		case "project":
		case "harness":
		case "model":
		case "branch":
		case "status": {
			const v = r[key];
			return v ? [v] : [];
		}
		case "pr":
		case "role":
			return r.tags
				.filter((t) => t.startsWith(`${key}:`))
				.map((t) => t.slice(key.length + 1));
		case "tag":
			return r.tags.filter(
				(t) =>
					!isAutoTag(t) &&
					!t.startsWith("pr:") &&
					!t.startsWith("role:") &&
					!t.startsWith("needs:"),
			);
	}
}

function facetTerm(key: FacetKey, value: string) {
	if (key !== "tag") return `${key}=${value}`;
	const colon = value.indexOf(":");
	return colon > 0
		? `${value.slice(0, colon)}=${value.slice(colon + 1)}`
		: value;
}

function facets(
	selectorText: string | null,
	facet: FacetKey | undefined,
	needleRaw: string | null,
	top: number,
): FacetsResponse {
	const selector = parseSelector(selectorText ?? "*");
	const total = matching(selector).length;
	const needle = needleRaw?.toLowerCase() ?? "";
	const one = (key: FacetKey): Facet => {
		const counts = new Map<string, number>();
		for (const a of matching(withoutKey(selector, key)))
			for (const v of new Set(facetValues(row(a), key)))
				if (!needle || v.toLowerCase().includes(needle))
					counts.set(v, (counts.get(v) ?? 0) + 1);
		const sorted = [...counts].sort(
			(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
		);
		return {
			values: sorted.slice(0, top).map(([value, count]) => ({
				value,
				count,
				term: facetTerm(key, value),
			})),
			more: Math.max(0, sorted.length - top),
		};
	};
	if (facet) return { total, facet, ...one(facet) };
	return {
		total,
		facets: Object.fromEntries(FACET_KEYS.map((k) => [k, one(k)])) as Record<
			FacetKey,
			Facet
		>,
	};
}

function search(text: string, max = 5): SearchResponse {
	const needle = text.trim().toLowerCase();
	if (!needle) return { machines: [], projects: [], agents: [], tags: [] };
	const hit = (v: string | null | undefined) =>
		Boolean(v?.toLowerCase().includes(needle));
	const byMachine = groupBy(agents, (a) => a.machineId);
	return {
		machines: [...byMachine]
			.filter(([id]) => hit(id))
			.map(([id, l]) => ({
				id: machineNodeId(id),
				machineId: id,
				name: id,
				agents: l.length,
			}))
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, max),
		projects: [...groupBy(agents, (a) => a.project)]
			.filter(([p]) => hit(p))
			.map(([p, l]) => ({
				id: projectNodeId(p),
				name: p ?? "",
				agents: l.length,
				machines: new Set(l.map((a) => a.machineId)).size,
			}))
			.sort((a, b) => b.agents - a.agents || a.name.localeCompare(b.name))
			.slice(0, max),
		agents: sortAgents(
			agents.filter(
				(a) =>
					hit(a.name) ||
					hit(a.id) ||
					hit(a.branch) ||
					hit(a.activity) ||
					hit(a.model),
			),
		)
			.slice(0, max)
			.map(row),
		tags: [
			...agents
				.flatMap((a) => a.tags.filter(hit))
				.reduce(
					(m, t) => m.set(t, (m.get(t) ?? 0) + 1),
					new Map<string, number>(),
				),
		]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, max)
			.map(([tag, count]) => ({ tag, count, term: facetTerm("tag", tag) })),
	};
}

// ------------------------------------------------------------------ sends

type Step = {
	at: number;
	state: ReceiptState;
	detail: string | null;
	reply?: string;
};

interface Sent {
	message: Message;
	receipts: Map<string, ReceiptRow>;
	replies: DeliveredMessage[];
	plan: Map<string, Step[]>;
}
const sent = new Map<string, Sent>();
const tokens = new Map<
	string,
	{ key: string; ids: Set<string>; expiresAt: number }
>();

function wakeOf(a: MockAgent, priority: Priority): Wake {
	if (a.wake === "wakes" && priority === "fyi") return "inbox-only";
	return a.wake;
}

const REPLIES = [
	"on it",
	"ack — pausing refresh() changes",
	"done, pushed to my branch",
	"no conflicts here",
	"will do after the current test run",
];

interface SendInput {
	to?: string;
	ids?: string[];
	body?: string;
	priority: Priority;
	expectReply: boolean;
	dryRun: boolean;
	resolveToken?: string;
	viaParent?: boolean;
	clientId?: string;
	/** Not on the wire: the send came with a passkey session (the echo's framing). */
	proven?: boolean;
}

const SEND_KEYS = new Set([
	"to",
	"ids",
	"body",
	"priority",
	"expectReply",
	"dryRun",
	"resolveToken",
	"viaParent",
	"clientId",
]);

function parseSend(raw: unknown): SendInput {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw badRequest("the body must be a JSON object");
	const o = raw as Record<string, unknown>;
	for (const k of Object.keys(o))
		if (!SEND_KEYS.has(k)) throw badRequest(`request: unrecognized key "${k}"`);
	const str = (k: string) => {
		if (o[k] !== undefined && typeof o[k] !== "string")
			throw badRequest(`${k}: expected a string`);
		return o[k] as string | undefined;
	};
	const bool = (k: string) => {
		if (o[k] !== undefined && typeof o[k] !== "boolean")
			throw badRequest(`${k}: expected a boolean`);
		return Boolean(o[k]);
	};
	const priority = (o.priority ?? "normal") as Priority;
	if (!["urgent", "normal", "fyi"].includes(priority))
		throw badRequest("priority: expected urgent, normal or fyi");
	if (
		o.ids !== undefined &&
		!(Array.isArray(o.ids) && o.ids.every((x) => typeof x === "string"))
	)
		throw badRequest("ids: expected an array of strings");
	return {
		to: str("to"),
		ids: o.ids as string[] | undefined,
		body: str("body"),
		priority,
		expectReply: bool("expectReply"),
		dryRun: bool("dryRun"),
		resolveToken: str("resolveToken"),
		viaParent: bool("viaParent"),
		clientId: str("clientId"),
	};
}

/**
 * A send naming a subagent, as the daemon does it: one that takes messages
 * directly is a target of its own; one that can't is refused (409) unless
 * `viaParent`, which sends to its parent naming it.
 */
function subagentSend(input: SendInput): SendInput {
	const subId = input.ids?.find((id) => id.includes("/sub:"));
	if (!subId) return input;
	const sub = subagentById(subId);
	if (!sub) throw notFound(`no subagent ${subId}`);
	if (sub.messaging.mode === "direct") return input;
	if (!input.viaParent || input.ids!.length !== 1)
		throw new ApiError(409, "subagent_unreachable", sub.messaging.note, {
			parentId: sub.parentId,
			note: sub.messaging.note,
		});
	return {
		...input,
		ids: [sub.parentId],
		body: forParentBody(sub, input.body ?? ""),
	};
}

/** A direct subagent as a send target (its parent's record, renamed). */
function subagentTarget(id: string): MockAgent | undefined {
	const sub = subagentById(id);
	const parent = sub && agentById.get(sub.parentId);
	if (!sub || !parent || sub.messaging.mode !== "direct") return undefined;
	return { ...parent, id: sub.id, name: sub.name, status: "busy" };
}

function dryRun(key: string, targets: MockAgent[], priority: Priority): DryRun {
	const rows = targets.map((a) => ({ ...row(a), wake: wakeOf(a, priority) }));
	const byMachine = new Map<string, MachineCount>();
	for (const r of rows) {
		const m = byMachine.get(r.machineId);
		if (m) m.count++;
		else
			byMachine.set(r.machineId, {
				machineId: r.machineId,
				machine: r.machine ?? r.machineId,
				count: 1,
			});
	}
	const resolveToken = `rt_${Math.floor(rand() * 1e12).toString(36)}`;
	const expiresAt = Date.now() + TOKEN_MS;
	tokens.set(resolveToken, {
		key,
		ids: new Set(targets.map((a) => a.id)),
		expiresAt,
	});
	return {
		dryRun: true,
		count: rows.length,
		machines: byMachine.size,
		breakdown: [...byMachine.values()].sort((a, b) => b.count - a.count),
		totals: wakeTotals(rows),
		resolveToken,
		expiresAt,
		preview: rows.slice(0, 20),
	};
}

function doSend(input: SendInput): DryRun | SendDone {
	if (input.clientId && !input.dryRun) {
		const held = sentByClientId.get(input.clientId);
		if (held) return held;
		const r = doSendOnce(input) as SendDone;
		sentByClientId.set(input.clientId, r);
		return r;
	}
	return doSendOnce(input);
}

function doSendOnce(input: SendInput): DryRun | SendDone {
	const ids = input.ids?.length ? [...new Set(input.ids)] : null;
	const to = input.to?.trim() ?? "";
	if (!ids && !to) throw badRequest("give `to` (a selector) or `ids`");
	if (ids && to) throw badRequest("give `to` or `ids`, not both");
	const key = ids ? `ids:${[...ids].sort().join(",")}` : `to:${to}`;
	const targets = sortAgents(
		ids
			? ids
					.map((id) => agentById.get(id) ?? subagentTarget(id))
					.filter((a): a is MockAgent => !!a && a.status !== "offline")
			: matching(to),
	);
	const priority = input.priority;
	if (input.dryRun) return dryRun(key, targets, priority);
	if (targets.length === 0)
		throw new ApiError(
			404,
			"no_recipients",
			ids ? "none of those agents is live" : `no live agent matches "${to}"`,
		);
	const conflict = (code: string, message: string) =>
		new ApiError(409, code, message, { ...dryRun(key, targets, priority) });
	if (input.resolveToken) {
		const token = tokens.get(input.resolveToken);
		tokens.delete(input.resolveToken);
		if (!token || token.expiresAt <= Date.now() || token.key !== key)
			throw conflict(
				"stale_token",
				"the resolve token expired or belongs to another send; confirm again",
			);
		const now = new Set(targets.map((a) => a.id));
		let diff = 0;
		for (const id of now) if (!token.ids.has(id)) diff++;
		for (const id of token.ids) if (!now.has(id)) diff++;
		if (diff / Math.max(token.ids.size, 1) > MAX_DRIFT)
			throw conflict(
				"drift",
				`the recipients changed since the dry run (${token.ids.size} → ${targets.length}); confirm again`,
			);
	} else if (targets.length > CONFIRM_ABOVE) {
		throw conflict(
			"confirm",
			`a send to ${targets.length} agents needs a dry run first; confirm with its resolveToken`,
		);
	}

	const now = Date.now();
	const id = `m_${now.toString(36)}${Math.floor(rand() * 0xffffffff).toString(16)}`;
	const message: Message = {
		id,
		threadId: id,
		fromId: `user:${LOGIN}`,
		fromName: "user",
		to: ids
			? ids.length <= 10
				? `id=${ids.join("|")}`
				: `ids:${ids.length}`
			: to,
		body: input.body ?? "",
		priority,
		replyTo: null,
		expectReply: input.expectReply,
		createdAt: now,
	};
	const s: Sent = {
		message,
		receipts: new Map(),
		replies: [],
		plan: new Map(),
	};
	for (const a of targets) {
		const w = wakeOf(a, priority);
		const offline = w === "queued";
		s.receipts.set(a.id, {
			messageId: id,
			agentId: a.id,
			agentName: a.name,
			state: "queued",
			via: null,
			detail: offline ? `waiting, ${a.machine} is offline` : null,
			updatedAt: now,
			machineId: a.machineId,
			machine: a.machine,
			harness: a.harness,
		});
		const steps: Step[] = [];
		if (!offline) {
			const t0 = now + 200 + rand() * 1500;
			if (w === "held")
				steps.push({
					at: t0,
					state: "held",
					detail: "held by the agent's inbound policy",
				});
			else if (w === "refuses")
				steps.push({
					at: t0,
					state: "refused",
					detail: "the agent refuses messages",
				});
			else if (rand() < 0.02 && !STEADY)
				steps.push({
					at: t0,
					state: "failed",
					detail: "harness socket closed",
				});
			else {
				steps.push({
					at: t0,
					state: "sent",
					detail: `handed to ${HARNESS_NAMES[a.harness] ?? a.harness}`,
				});
				if (w === "wakes")
					steps.push({
						at: t0 + 400 + rand() * 1500,
						state: "delivered",
						detail: "in its conversation",
					});
				steps.push({
					at: t0 + 1500 + rand() * 3000,
					state: "read",
					detail: null,
				});
				if (input.expectReply && rand() < 0.45)
					steps.push({
						at: t0 + 3000 + rand() * 8000,
						state: "replied",
						detail: null,
						reply: REPLIES[Math.floor(rand() * REPLIES.length)],
					});
			}
		}
		s.plan.set(a.id, steps);
	}
	sent.set(id, s);
	// One live recipient: its transcript records the push as the operator's
	// turn (like the daemon's frame), so the bubble shows its delivery state.
	const only = targets.length === 1 ? targets[0]! : null;
	// Like the daemon's frame: proven, the operator's own turn; unproven, the
	// app's (a peer line). After `echoMs` (faults), so the echo can come late.
	if (only && wakeOf(only, priority) !== "queued") {
		const proven = input.proven === true;
		setTimeout(() => {
			const e = proven
				? appendOperatorTurn(only, message.body, id)
				: appendLine(only, message.body, "peer", {
						from: "Pulsar app",
						pulsar: { sender: "app", messageId: id, machine: "studio" },
					});
			for (const st of streams.values())
				if (st.push && st.sub.session === only.id)
					write(st, "transcript", { agent: only.id, events: [e] });
		}, faults.echoMs);
	}
	const receipts = [...s.receipts.values()];
	return {
		dryRun: false,
		message,
		count: receipts.length,
		totals: { queued: receipts.length },
		receipts: receipts.slice(0, 50).map((r) => ({ ...r })),
	};
}

const RECEIPT_ORDER: Record<ReceiptState, number> = {
	failed: 0,
	replied: 1,
	refused: 2,
	held: 3,
	queued: 4,
	sent: 5,
	delivered: 6,
	read: 7,
	acked: 8,
	done: 9,
	nacked: 10,
	expired: 11,
	dead: 12,
};

function receiptsOf(
	s: Sent,
	q: { state?: ReceiptState; cursor?: string | null; limit?: number } = {},
): ReceiptsPage {
	const all = [...s.receipts.values()];
	const totals: ReceiptsPage["totals"] = {};
	for (const r of all) totals[r.state] = (totals[r.state] ?? 0) + 1;
	const items = all
		.filter((r) => !q.state || r.state === q.state)
		.sort(
			(a, b) =>
				RECEIPT_ORDER[a.state] - RECEIPT_ORDER[b.state] ||
				a.agentName.localeCompare(b.agentName),
		)
		.map((r) => ({ ...r }));
	const p = page(items, q.cursor ?? null, q.limit ?? 100);
	return {
		message: s.message,
		totals,
		items: p.items,
		total: p.total,
		replies: s.replies,
		nextCursor: p.nextCursor,
	};
}

function advanceReceipts(now: number) {
	for (const s of sent.values()) {
		for (const [agentId, steps] of s.plan) {
			while (steps.length && steps[0]!.at <= now) {
				const st = steps.shift()!;
				const r = s.receipts.get(agentId)!;
				r.state = st.state;
				r.detail = st.detail;
				r.via = st.state === "sent" ? "socket" : r.via;
				r.updatedAt = now;
				if (st.reply) {
					r.reply = st.reply;
					const a = agentById.get(agentId)!;
					const replyId = `m_${now.toString(36)}${Math.floor(rand() * 0xffff).toString(16)}`;
					s.replies.push({
						id: replyId,
						threadId: s.message.threadId,
						fromId: a.id,
						fromName: a.name,
						to: "user",
						body: st.reply,
						priority: "normal",
						replyTo: s.message.id,
						expectReply: false,
						createdAt: now,
						from: {
							id: a.id,
							name: a.name,
							harness: a.harness,
							project: a.project,
						},
					});
				}
			}
		}
	}
}

// ------------------------------------------------------------------ SSE

const BOOT_ID = `b${Date.now().toString(36)}`;
const RETAIN_MS = 5 * 60_000;

type TopicKind =
	| "attention"
	| "tree"
	| "children"
	| "agent"
	| "query"
	| "results"
	| "receipts"
	| "transcript";

interface Computed {
	event: ServerEventName;
	full: Record<string, unknown>;
	state: Map<string, string>;
	diff: (prev: Map<string, string>) => Record<string, unknown> | null;
}

interface Stream {
	id: string;
	sub: Subscription;
	/** Last sent comparison state per topic key. */
	topics: Map<string, Map<string, string> | null>;
	push: ((chunk: string) => void) | null;
	detachedAt: number;
	/** Ends the open response (mock only: a dropped connection). */
	close?: () => void;
}
const streams = new Map<string, Stream>();
let seq = 0;

const EMPTY_SUB: Subscription = {
	expanded: [],
	window: null,
	session: null,
	query: null,
	results: null,
	receipts: [],
};

function topicKey(kind: TopicKind, ...args: string[]) {
	return JSON.stringify([kind, ...args]);
}

function topicsOf(sub: Subscription): string[] {
	const keys = [topicKey("attention")];
	const filter = sub.window?.filter ?? "";
	if (sub.window) keys.push(topicKey("tree", sub.window.group, filter));
	for (const id of sub.expanded) keys.push(topicKey("children", id, filter));
	if (sub.session)
		keys.push(
			topicKey("agent", sub.session),
			topicKey("transcript", sub.session),
		);
	if (sub.query !== null) keys.push(topicKey("query", sub.query));
	if (sub.results) {
		const r = sub.results;
		keys.push(
			topicKey(
				"results",
				r.selector,
				r.sort ?? "attention",
				String(r.offset ?? 0),
				String(r.limit ?? 50),
			),
		);
	}
	for (const id of sub.receipts) keys.push(topicKey("receipts", id));
	return keys;
}

/** JSON with `lastSeen`/`lastActive` cut to the minute (the daemon's rule). */
function compareKey(value: unknown): string {
	return JSON.stringify(value, (k, v) =>
		(k === "lastSeen" || k === "lastActive") && typeof v === "number"
			? Math.floor(v / 60_000)
			: v,
	);
}

/** `Omit` that keeps union members apart. */
type WithoutFull<T> = T extends unknown ? Omit<T, "full"> : never;

function whole<K extends ServerEventName>(
	event: K,
	payload: WithoutFull<ServerEvents[K]>,
): Computed {
	const state = new Map([["", compareKey(payload)]]);
	return {
		event,
		full: payload as Record<string, unknown>,
		state,
		diff: (prev) => (prev.get("") === state.get("") ? null : payload),
	};
}

function list(
	event: "tree" | "children",
	head: Record<string, unknown>,
	items: TreeNode[],
): Computed {
	const state = new Map(items.map((n) => [n.id, compareKey(n)]));
	const ids = items.map((n) => n.id);
	state.set("", JSON.stringify(ids));
	const full: ListUpdate<TreeNode> = { full: true, items, total: items.length };
	return {
		event,
		full: { ...head, ...full },
		state,
		diff: (prev) => {
			const changed = items.filter((n) => prev.get(n.id) !== state.get(n.id));
			const removed = [...prev.keys()].filter(
				(id) => id !== "" && !state.has(id),
			);
			if (!changed.length && !removed.length && prev.get("") === state.get(""))
				return null;
			return {
				...head,
				items: changed,
				removed,
				order: ids,
				total: items.length,
			};
		},
	};
}

function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

function compute(key: string): Computed | null {
	const [kind, a = "", b = "", c = "", d = ""] = JSON.parse(key) as [
		TopicKind,
		...string[],
	];
	switch (kind) {
		case "attention":
			return whole("attention", attention());
		case "tree":
			return list(
				"tree",
				{ group: a, filter: b },
				treeNodes(a as TreeGroup, b || undefined),
			);
		case "children":
			return list(
				"children",
				{ nodeId: a, filter: b },
				safe(() => childNodes(a, b || undefined), []),
			);
		case "agent": {
			const ag = agentById.get(a);
			return whole("agent", {
				id: a,
				agent: ag && ag.status !== "offline" ? row(ag) : null,
			});
		}
		case "query": {
			const rows = matching(a);
			return whole("query", {
				selector: a,
				total: rows.length,
				machines: new Set(rows.map((r) => r.machineId)).size,
				totals: wakeTotals(rows),
			});
		}
		case "results": {
			const offset = Number(c) || 0;
			const limit = Number(d) || 50;
			const all = sortAgents(matching(a), b as AgentSort);
			return whole("results", {
				selector: a,
				sort: b as AgentSort,
				offset,
				limit,
				items: all.slice(offset, offset + limit).map(row),
				total: all.length,
				machines: new Set(all.map((x) => x.machineId)).size,
			});
		}
		case "receipts": {
			const s = sent.get(a);
			return whole(
				"receipts",
				s
					? { messageId: a, ...receiptsOf(s) }
					: { messageId: a, missing: true },
			);
		}
		case "transcript":
			return null;
	}
}

function frame(stream: Stream, event: ServerEventName, data: unknown) {
	return `id: ${BOOT_ID}.${stream.id}.${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function write<K extends ServerEventName>(
	stream: Stream,
	event: K,
	data: ServerEvents[K],
) {
	stream.push?.(frame(stream, event, data));
}

/** Sends one stream the current state of a topic (`full: true`). */
function snapshot(stream: Stream, key: string, resuming = false) {
	const c = compute(key);
	if (!c) {
		// A transcript has no snapshot (the app pages it); on a resume, say so.
		const [, agent] = JSON.parse(key) as [string, string];
		stream.topics.set(key, null);
		if (resuming)
			write(stream, "gap", { reason: "expired", topic: "transcript", agent });
		return;
	}
	stream.topics.set(key, c.state);
	stream.push?.(frame(stream, c.event, { ...c.full, full: true }));
}

function setSubscription(stream: Stream, sub: Subscription) {
	const next = topicsOf(sub);
	stream.sub = sub;
	for (const key of [...stream.topics.keys()])
		if (!next.includes(key)) stream.topics.delete(key);
	for (const key of next) if (!stream.topics.has(key)) snapshot(stream, key);
}

/** Recomputes every topic of a stream and sends what changed. */
function refresh(stream: Stream) {
	for (const [key, prev] of stream.topics) {
		if (prev === null) continue;
		const c = compute(key);
		if (!c) continue;
		const diff = c.diff(prev);
		stream.topics.set(key, c.state);
		if (diff) stream.push?.(frame(stream, c.event, { ...diff, full: false }));
	}
}

function openStream(req: Request): Response {
	const last = req.headers.get("last-event-id");
	const m = last ? /^([\w-]+)\.([\w-]+)\.(\d+)$/.exec(last.trim()) : null;
	const existing = m && m[1] === BOOT_ID ? streams.get(m[2]!) : undefined;
	const stream: Stream = existing ?? {
		id: `s${Math.floor(rand() * 1e12).toString(36)}`,
		sub: EMPTY_SUB,
		topics: new Map(),
		push: null,
		detachedAt: 0,
	};
	streams.set(stream.id, stream);
	const encoder = new TextEncoder();
	let ping: ReturnType<typeof setInterval> | undefined;
	const detach = () => {
		clearInterval(ping);
		if (stream.push === push) {
			stream.push = null;
			stream.detachedAt = Date.now();
		}
	};
	let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
	const push = (chunk: string) => {
		try {
			controllerRef?.enqueue(encoder.encode(chunk));
		} catch {
			detach();
		}
	};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controllerRef = controller;
			stream.push = push;
			stream.close = () => {
				detach();
				try {
					controller.close();
				} catch {}
			};
			stream.detachedAt = 0;
			write(stream, "ready", {
				streamId: stream.id,
				bootId: BOOT_ID,
				resumed: Boolean(existing),
			});
			if (existing) {
				// No replay log here: every topic gets a fresh snapshot (the
				// daemon's path for topics whose events were pruned).
				for (const key of [...stream.topics.keys()])
					snapshot(stream, key, true);
			} else {
				if (last) write(stream, "gap", { reason: "expired" });
				setSubscription(stream, EMPTY_SUB);
			}
			ping = setInterval(() => push(": keepalive\n\n"), 15_000);
		},
		cancel() {
			detach();
		},
	});
	req.signal.addEventListener("abort", detach);
	return new Response(body, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"X-Accel-Buffering": "no",
		},
	});
}

const SUB_KEYS = new Set([
	"expanded",
	"window",
	"session",
	"query",
	"results",
	"receipts",
	"changes",
	"subagents",
]);

function parseSubscription(raw: unknown): Subscription {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw badRequest("the body must be a JSON object");
	const o = raw as Record<string, unknown>;
	for (const k of Object.keys(o))
		if (!SUB_KEYS.has(k)) throw badRequest(`request: unrecognized key "${k}"`);
	const strings = (k: string) => {
		const v = o[k] ?? [];
		if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
			throw badRequest(`${k}: expected an array of strings`);
		return v as string[];
	};
	const nullableString = (k: string) => {
		const v = o[k] ?? null;
		if (v !== null && typeof v !== "string")
			throw badRequest(`${k}: expected a string or null`);
		return v as string | null;
	};
	return {
		expanded: strings("expanded"),
		window: (o.window ?? null) as Subscription["window"],
		session: nullableString("session"),
		query: nullableString("query"),
		results: (o.results ?? null) as Subscription["results"],
		receipts: strings("receipts"),
		changes: (o.changes ?? null) as Subscription["changes"],
		subagents: strings("subagents"),
	};
}

type RealtimeChange =
	| { action: "status"; id: string; status: "busy" | "idle" }
	/** A finished or failed turn the operator should hear about (`notify`). */
	| { action: "turn"; id: string; kind: "finished" | "failed" }
	/** A plan usage limit warning (`limit`), as the daemon sends it. */
	| { action: "limit"; warning: LimitWarning }
	/** This node holds a push subscription for `endpoint` (no passkey ceremony in tests). */
	| { action: "push-subscription"; endpoint: string }
	| { action: "add-agent"; name: string; machine?: string; project?: string }
	/** A permission prompt for `tool` (Bash when absent). */
	| { action: "needs-you"; id: string; tool?: string }
	/** An interaction of one kind (question, plan, confirm, select, input). */
	| { action: "interaction"; id: string; kind: string }
	/** The agent's own screen answered its pending prompt first. */
	| { action: "answered-locally"; id: string }
	/**
	 * A prompt only the terminal can answer; `expired`: the app's time to
	 * answer its relayed Bash prompt ran out first.
	 */
	| { action: "terminal"; id: string; expired?: boolean }
	| { action: "transcript"; id: string; text: string }
	/** The agent edits a file in its worktree (the diff viewer goes live). */
	| { action: "changes"; id: string; path: string; line: string }
	| {
			action: "receipt";
			state: ReceiptState;
			reply?: string;
			messageId?: string;
	  }
	| { action: "restore" };

/** What realtime changes touched, so `restore` puts the fixtures back. */
const rtSaved = new Map<string, MockAgent>();
const rtAdded = new Set<MockAgent>();
function rtTouch(a: MockAgent) {
	if (!rtSaved.has(a.id) && !rtAdded.has(a)) rtSaved.set(a.id, { ...a });
	return a;
}

/** Applies one change and pushes what it changed to every open stream now. */
function realtime(raw: unknown) {
	const c = raw as RealtimeChange;
	const now = Date.now();
	let out: Record<string, unknown> = { ok: true };
	switch (c.action) {
		case "status": {
			const a = rtTouch(agentOr404(c.id));
			a.status = c.status;
			a.needs = undefined;
			a.approval = undefined;
			a.statusSince = now;
			a.lastActive = now;
			// Keep it where the test put it (no random churn).
			a.fixed = true;
			break;
		}
		case "turn": {
			const a = agentOr404(c.id);
			const n = { kind: c.kind, agentId: a.id, at: now };
			for (const s of streams.values()) s.push?.(frame(s, "notify", n));
			// The token a push would carry (sw.js resolves it on tap).
			const ref = `ref-${turnRefs.size + 1}`;
			turnRefs.set(ref, a.id);
			out = { ok: true, ref };
			break;
		}
		case "limit": {
			for (const s of streams.values()) s.push?.(frame(s, "limit", c.warning));
			break;
		}
		case "push-subscription": {
			pushPrefs.set(c.endpoint, pushPrefs.get(c.endpoint) ?? {});
			break;
		}
		case "add-agent": {
			const m = machineByName.get(c.machine ?? "studio");
			if (!m) throw notFound(`no machine ${c.machine}`);
			const a = makeAgent(m, c.project ?? "apparish", {
				name: c.name,
				status: "idle",
				fixed: true,
				lastActive: now,
				statusSince: now,
			});
			rtAdded.add(a);
			out = { ok: true, id: a.id };
			break;
		}
		case "needs-you": {
			const a = rtTouch(agentOr404(c.id));
			a.status = "needs-you";
			a.needs = "approval";
			a.approval = makeApproval(a, c.tool ?? "Bash");
			a.statusSince = now;
			a.fixed = true;
			break;
		}
		case "interaction": {
			const a = rtTouch(agentOr404(c.id));
			a.status = "needs-you";
			a.needs = "approval";
			a.approval = makeInteraction(a, c.kind);
			a.statusSince = now;
			a.fixed = true;
			out = { ok: true, requestId: a.approval.requestId };
			break;
		}
		case "terminal": {
			const a = rtTouch(agentOr404(c.id));
			a.status = "needs-you";
			a.needs = "terminal";
			a.approval = undefined;
			a.expiredApproval = c.expired
				? {
						...makeApproval(a, "Bash"),
						createdAt: now - 540_000,
						expiresAt: now,
						state: "expired",
						outcome: "Expired: the agent's own prompt decides",
					}
				: undefined;
			a.statusSince = now;
			a.fixed = true;
			break;
		}
		case "answered-locally": {
			const a = rtTouch(agentOr404(c.id));
			if (!a.approval) throw notFound("no pending prompt");
			const t = new Date().toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			});
			a.approval = {
				...a.approval,
				state: "answered-locally",
				outcome: `Answered on ${a.machine} · ${t}`,
			};
			a.needs = undefined;
			a.status = "busy";
			pushApproval(a.approval);
			break;
		}
		case "transcript": {
			const a = agentOr404(c.id);
			const e = appendLine(a, c.text);
			for (const s of streams.values())
				if (s.push && s.sub.session === a.id)
					write(s, "transcript", { agent: a.id, events: [e] });
			out = { ok: true, event: e.id };
			break;
		}
		case "changes": {
			const a = agentOr404(c.id);
			if (!editChanges(a, c.path, c.line)) throw notFound("no repo");
			for (const s of streams.values()) {
				const w = s.sub.changes;
				if (s.push && w?.agent === a.id)
					write(s, "changes", changesSummary(a, w.mode));
			}
			out = { ok: true };
			break;
		}
		case "receipt": {
			const s = c.messageId ? sent.get(c.messageId) : [...sent.values()].at(-1);
			if (!s) throw notFound("no sent message");
			for (const [agentId, r] of s.receipts) {
				s.plan.set(agentId, []);
				r.state = c.state;
				r.updatedAt = now;
				if (c.reply) r.reply = c.reply;
			}
			out = { ok: true, messageId: s.message.id };
			break;
		}
		case "restore": {
			resetChanges();
			resetGit();
			for (const a of rtAdded) {
				agents.splice(agents.indexOf(a), 1);
				agentById.delete(a.id);
			}
			rtAdded.clear();
			for (const [id, saved] of rtSaved) {
				const a = agentById.get(id);
				if (a)
					Object.assign(a, saved, {
						approval: saved.approval,
						needs: saved.needs,
					});
			}
			rtSaved.clear();
			break;
		}
		default:
			throw badRequest("unknown action");
	}
	for (const s of streams.values()) if (s.push) refresh(s);
	return out;
}

const STATUSES: MockAgent["status"][] = ["busy", "idle"];
function mutate(now: number) {
	if (!LIVE) return;
	for (let i = 0; i < 12; i++) {
		const a = agents[Math.floor(rand() * agents.length)]!;
		if (a.fixed || a.status === "offline" || a.status === "needs-you") continue;
		const s = STATUSES[Math.floor(rand() * 2)]!;
		if (s !== a.status) {
			a.status = s;
			a.statusSince = now;
		}
		a.lastActive = now;
	}
}

setInterval(() => {
	const now = Date.now();
	mutate(now);
	advanceReceipts(now);
	for (const [id, s] of streams) {
		if (!s.push) {
			if (now - s.detachedAt > RETAIN_MS) streams.delete(id);
			continue;
		}
		refresh(s);
		const session = s.sub.session;
		if (session && STREAM) {
			const a = agentById.get(session);
			if (
				a?.hasTranscript &&
				a.status !== "offline" &&
				(a.fixed ? a !== FIX.xss : true)
			) {
				const events = transcriptStep(a);
				if (events.length) write(s, "transcript", { agent: a.id, events });
			}
		}
	}
}, 700);

function broadcastAttention() {
	const c = compute(topicKey("attention"))!;
	for (const s of streams.values()) {
		if (!s.push) continue;
		const prev = s.topics.get(topicKey("attention"));
		if (!prev) continue;
		const diff = c.diff(prev);
		s.topics.set(topicKey("attention"), c.state);
		if (diff) s.push(frame(s, "attention", { ...diff, full: false }));
	}
}

// A new approval shows up now and then, so the needs-you path stays live.
if (LIVE)
	setInterval(() => {
		const cand = agents.filter((a) => !a.fixed && a.status === "busy");
		const a = cand[Math.floor(rand() * cand.length)];
		if (!a) return;
		a.status = "needs-you";
		a.needs = "approval";
		a.approval = makeApproval(a, "Bash");
		a.statusSince = Date.now();
		broadcastAttention();
	}, 45000);

// ------------------------------------------------------------- approvals

// Real passkey checks (the daemon's own code), with passkeys in memory. The
// relying party is the host the page was opened on: WebAuthn needs a name,
// so open the mock on http://localhost:<port> to approve.
const passkeys = new Passkeys(new MemoryPasskeyStore());

// Passkey sessions with the daemon's own code; sessions kept in a Map.
const sessionMeta = new Map<string, string>();
const userSessions = new UserSessions({
	passkeys,
	store: {
		metaByPrefix: (prefix) =>
			[...sessionMeta]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, value]) => ({ key, value })),
		metaSet: (key, value) => {
			sessionMeta.set(key, value);
		},
		metaDelete: (key) => {
			sessionMeta.delete(key);
		},
	},
});

/**
 * Mock only: which device a request comes from, by its user agent (the
 * daemon asks Tailscale). A phone or tablet runs no pulsar; anything else
 * is this computer ("studio"), which does.
 */
type MockDevice = Extract<Principal, { kind: "human" }> & {
	nodeId: string;
	pulsarNode: boolean;
};
function deviceOf(req: Request): MockDevice {
	const ua = req.headers.get("user-agent") ?? "";
	const phone = /iPhone|iPad|Android/.test(ua);
	return {
		kind: "human",
		login: LOGIN,
		name: "You",
		node: phone ? "iphone" : "studio",
		nodeId: phone ? "iphone" : "studio",
		os: phone ? (/Android/.test(ua) ? "android" : "iOS") : "macOS",
		pulsarNode: !phone,
	};
}

/** The passkey session a request's bearer token names (like the daemon). */
function sessionOf(req: Request): UserSessionInfo | null {
	const token = /^Bearer\s+(\S+)$/i.exec(
		req.headers.get("authorization") ?? "",
	)?.[1];
	return token ? userSessions.check(token, LOGIN, deviceOf(req).nodeId) : null;
}

function requireSession(req: Request) {
	if (!sessionOf(req))
		throw new ApiError(
			401,
			"session_required",
			"prove you're human first (Prove Human, Face ID / Touch ID)",
		);
}
/**
 * Acting ops (src/service/acting.ts), as the daemon checks them: an agent
 * on this machine (no `/` in its id) or no `machine` needs the passkey
 * session; one on "another machine" (an address, or a `machine`) needs an
 * assertion over this mock's `/acting/options` challenge for exactly that
 * op, target and params. Feature routes call it before acting.
 */
async function requireActing(
	req: Request,
	op: string,
	target: { agent?: string; machine?: string },
	params: unknown,
	assertion: unknown,
) {
	const remote = target.agent ? target.agent.includes("/") : !!target.machine;
	if (!remote) return requireSession(req);
	if (assertion === undefined)
		throw new ApiError(
			401,
			"session_required",
			"this action on another machine needs Face ID / Touch ID for that action",
		);
	const url = new URL(req.url);
	try {
		await passkeys.verifyAct(
			LOGIN,
			{ rpId: url.hostname, origins: [url.origin] },
			{ op, target: actTarget(target), digest: actDigest(params) },
			assertion,
		);
	} catch (e) {
		if (e instanceof RpcError)
			throw new ApiError(RPC_STATUS[e.code] ?? 400, e.code, e.message);
		throw e;
	}
}

/** The target an acting challenge names (the home node's local id, or `machine:`). */
const actTarget = (t: { agent?: string }) =>
	t.agent ? t.agent.slice(t.agent.indexOf("/") + 1) : "machine:";

const ATTACH_STATUS: Record<string, number> = {
	not_found: 404,
	too_large: 413,
	unreachable: 503,
};

const RPC_STATUS: Record<string, number> = {
	bad_assertion: 403,
	no_passkey: 409,
	forbidden: 403,
	not_found: 404,
	rate_limited: 429,
	decided: 409,
};

/** A security notice to every open stream (the daemon's `security` event). */
function security(kind: SecurityNotice["kind"], message: string) {
	const notice: SecurityNotice = {
		kind,
		message,
		node: "studio",
		at: Date.now(),
	};
	for (const st of streams.values()) st.push?.(frame(st, "security", notice));
}

const vapid = generateVapidKeys();
/** Agent tokens of finish/fail pushes (`GET /push/turns/:ref`). */
const turnRefs = new Map<string, string>();
/** Finish/fail settings by push endpoint (the daemon keeps them on the subscription row). */
const pushPrefs = new Map<
	string,
	{ turns?: "off" | "notify" | "sound" | "both"; inApp?: boolean }
>();

function findApproval(id: string) {
	const a = agents.find((x) => x.approval?.requestId === id);
	if (!a?.approval) throw notFound(`no approval ${id}`);
	return { agent: a, approval: a.approval };
}

const DECISIONS = ["allow-once", "allow-session", "deny", "answer"] as const;

/** An approval change to every open stream (the daemon's `approval` event). */
function pushApproval(approval: Approval) {
	for (const st of streams.values())
		st.push?.(frame(st, "approval", { approval }));
}

function binding(
	approval: Approval,
	decision: ApprovalDecision,
	note?: string,
	answer?: InteractionAnswer | null,
): ApprovalBinding {
	return {
		requestId: approval.requestId,
		inputHash: approval.inputHash,
		agentId: approval.agentId,
		decision,
		grantHash:
			decision === "allow-session"
				? canonicalJson(approval.sessionRules ?? [])
				: "",
		noteHash:
			decision === "answer" && answer
				? answerHash(answer)
				: decision === "deny" && note
					? createHash("sha256").update(note.slice(0, 2000)).digest("hex")
					: "",
		expiresAt: approval.expiresAt,
	};
}

/** The daemon's session decision rule (see `Approvals.verifySessionDecision`). */
function sessionSigner(
	req: Request,
	approval: Approval,
	decision: ApprovalDecision,
	body: { inputHash?: unknown; sessionRules?: unknown },
) {
	if (approval.requestId.includes("/"))
		throw new ApiError(
			403,
			"bad_assertion",
			"a prompt on another machine needs that machine's passkey signature",
		);
	const s = sessionOf(req);
	if (!s)
		throw new ApiError(
			401,
			"session_required",
			"answering needs a passkey session or a passkey signature",
		);
	if (body.inputHash !== approval.inputHash)
		throw new ApiError(
			403,
			"bad_assertion",
			"the prompt's input differs from the card that was answered",
		);
	if (
		decision === "allow-session" &&
		canonicalJson(body.sessionRules ?? null) !==
			canonicalJson(approval.sessionRules ?? null)
	)
		throw new ApiError(
			403,
			"bad_assertion",
			"the rules differ from the ones the card listed",
		);
	return { method: "passkey session", device: s.device };
}

async function approvalRoute(
	req: Request,
	url: URL,
	seg: string[],
	POST: boolean,
): Promise<Response> {
	const rp = { rpId: url.hostname, origins: [url.origin] };
	const me = deviceOf(req);
	if (POST && seg[1] === "register" && seg[2] === "options") {
		const body = (await jsonBody(req)) as { label?: string };
		const options = await passkeys.registrationOptions(LOGIN, rp, {
			label: String(body.label ?? "browser"),
		});
		return json({ options });
	}
	if (POST && seg[1] === "register" && seg[2] === "verify") {
		const body = (await jsonBody(req)) as { response?: unknown };
		const info = await passkeys.verifyRegistration(LOGIN, rp, body.response);
		security("passkey-added", `New passkey '${info.label}' added on studio`);
		return json({ ...info, ...userSessions.issue(LOGIN, info.label, me) });
	}
	if (seg[0] === "passkeys" && !POST && seg.length === 1)
		return json({ items: passkeys.list() });
	if (seg[0] === "passkeys" && POST && seg[2] === "remove") {
		requireSession(req);
		const label = passkeys.list().find((k) => k.id === seg[1])?.label;
		if (!passkeys.remove(seg[1]!)) throw notFound("no such passkey");
		security("passkey-removed", `Passkey '${label}' removed on studio`);
		return json({ ok: true });
	}
	if (seg[0] !== "approvals" || !seg[1]) throw notFound("no such endpoint");
	const { agent, approval } = findApproval(seg[1]);
	if (!POST && seg.length === 2) return json(approval);
	const body = (await jsonBody(req)) as {
		decision?: ApprovalDecision;
		note?: string;
		answer?: unknown;
		assertion?: unknown;
		inputHash?: unknown;
		sessionRules?: unknown;
	};
	const decision = body.decision;
	if (!decision || !DECISIONS.includes(decision))
		throw badRequest("decision: allow-once, allow-session, deny or answer");
	const isPermission = (approval.kind ?? "permission") === "permission";
	if (isPermission === (decision === "answer"))
		throw badRequest(
			isPermission
				? "a permission prompt takes allow-once, allow-session or deny"
				: `this ${approval.kind} takes decision "answer"`,
		);
	let answer: InteractionAnswer | null = null;
	if (decision === "answer" && approval.prompt) {
		try {
			answer = cleanAnswer(body.answer, approval.prompt);
		} catch (e) {
			throw badRequest((e as Error).message);
		}
	}
	if (POST && seg[2] === "options") {
		if (approval.outcome)
			throw new ApiError(409, "decided", approval.outcome, { approval });
		if (!passkeys.has(LOGIN, rp)) return json({ register: true });
		const options = await passkeys.assertionOptions(
			LOGIN,
			rp,
			binding(approval, decision, body.note, answer),
		);
		return json({ options });
	}
	if (POST && seg[2] === "decide") {
		if (approval.outcome) return json({ won: false, approval });
		// Like the daemon: a local prompt may be decided with the request's
		// passkey session, bound to the card's input hash (and listed rules).
		const signer =
			body.assertion === undefined
				? sessionSigner(req, approval, decision, body)
				: await passkeys.verifyAssertion(
						LOGIN,
						rp,
						binding(approval, decision, body.note, answer),
						body.assertion,
					);
		if (answer) {
			const t = new Date().toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			});
			const done: Approval = {
				...approval,
				answer,
				state: answerApproves(answer, approval.prompt ?? null)
					? "allowed"
					: "denied",
				outcome: `${answerLabel(answer, approval.prompt ?? null)} by You · ${signer.method} on ${signer.device} · ${t}`,
			};
			// Kept (decided) so a second answer from another device loses.
			agent.approval = done;
			agent.needs = undefined;
			agent.status = "busy";
			agent.statusSince = Date.now();
			pushApproval(done);
			broadcastAttention();
			return json({ won: true, approval: done });
		}
		const t = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		const what =
			decision === "deny"
				? "Denied"
				: decision === "allow-session"
					? "Allowed for session"
					: "Allowed once";
		const done: Approval = {
			...approval,
			state: decision === "deny" ? "denied" : "allowed",
			outcome: `${what} by You · ${signer.method} on ${signer.device} · ${t}`,
		};
		// The studio fixture always needs you, so every run (and screenshot) sees it pending.
		if (agent !== FIX.auth) {
			agent.status = "busy";
			agent.needs = undefined;
			agent.approval = undefined;
			agent.statusSince = Date.now();
		}
		broadcastAttention();
		return json({ won: true, approval: done });
	}
	throw notFound("no such endpoint");
}

// ------------------------------------------------------------------ HTTP

const SECURITY_HEADERS: Record<string, string> = {
	"Content-Security-Policy": CSP,
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Opener-Policy": "same-origin",
};

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function apiError(e: ApiError) {
	return json(
		{ error: { code: e.code, message: e.message }, ...e.extra },
		e.status,
	);
}

async function jsonBody(req: Request): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		throw badRequest("the body must be JSON");
	}
}

function agentOr404(id: string) {
	const a = agentById.get(id);
	if (!a) throw notFound(`no agent ${id}`);
	return a;
}

const RECEIPT_STATES = Object.keys(RECEIPT_ORDER) as ReceiptState[];

let identityOutage = { left: 0, eventsOnly: false };

/**
 * Mock only (`POST /__mock/faults`): a slow or failing network for the
 * optimistic-rendering tests. Each rule matches a method and a path prefix
 * (under /api/v1) and applies to its next `count` requests (default all);
 * the first rule with requests left wins:
 * `beforeMs` waits before handling, `afterMs` handles and then waits (the
 * echo can win the race), `fail` answers that status without handling,
 * `failAfter` handles and then answers that status (a lost response).
 * `echoMs` delays the echo of a send to one live agent into its
 * transcript (as its harness records the push; at once by default).
 * `{}` clears all.
 */
interface FaultRule {
	method?: string;
	path: string;
	count?: number;
	beforeMs?: number;
	afterMs?: number;
	fail?: number;
	failAfter?: number;
}
let faults: { rules: FaultRule[]; echoMs: number } = {
	rules: [],
	echoMs: 0,
};
/** Real sends by clientId (the daemon's idempotent retry). */
const sentByClientId = new Map<string, SendDone>();

function faultFor(req: Request, path: string): FaultRule | null {
	const r = faults.rules.find(
		(f) =>
			(f.count ?? 1) > 0 &&
			(!f.method || f.method === req.method) &&
			path.startsWith(f.path),
	);
	if (!r) return null;
	if (r.count !== undefined) r.count--;
	return r;
}

const faultError = (status: number) =>
	new ApiError(status, "mock_fault", `injected failure (${status})`);

async function route(
	req: Request,
	url: URL,
	faulted = false,
): Promise<Response> {
	const path = url.pathname.slice("/api/v1".length);
	const sameOrigin = req.headers.get("sec-fetch-site") === "same-origin";
	const exempt =
		req.method === "GET" &&
		(path === "/hello" ||
			(sameOrigin && (path === "/events" || path === "/qr")));
	if (req.headers.get("x-pulsar") !== "1" && !exempt)
		throw new ApiError(
			403,
			"missing_header",
			"API calls need the X-Pulsar: 1 header",
		);
	const q = url.searchParams;
	const seg = path.split("/").filter(Boolean).map(decodeURIComponent);
	const GET = req.method === "GET";
	const POST = req.method === "POST";
	const PUT = req.method === "PUT";

	// Mock only: the next `count` requests (or only event streams) answer
	// like a daemon whose Tailscale identity lookup is slow; `drop` closes
	// the open streams so they reconnect into it.
	if (POST && path === "/__mock/identity") {
		const b = (await jsonBody(req)) as {
			count: number;
			eventsOnly?: boolean;
			drop?: boolean;
		};
		identityOutage = { left: b.count, eventsOnly: b.eventsOnly === true };
		if (b.drop) for (const s of streams.values()) s.close?.();
		return json({ ok: true });
	}
	if (POST && path === "/__mock/faults") {
		const b = (await jsonBody(req)) as Partial<typeof faults>;
		faults = { rules: b.rules ?? [], echoMs: b.echoMs ?? 0 };
		return json({ ok: true });
	}
	const fault =
		faulted || path.startsWith("/__mock/") ? null : faultFor(req, path);
	if (fault) {
		if (fault.beforeMs) await Bun.sleep(fault.beforeMs);
		if (fault.fail) throw faultError(fault.fail);
		if (fault.afterMs || fault.failAfter) {
			const res = await route(req, url, true);
			if (fault.afterMs) await Bun.sleep(fault.afterMs);
			if (fault.failAfter) throw faultError(fault.failAfter);
			return res;
		}
	}
	if (
		identityOutage.left > 0 &&
		!path.startsWith("/__mock/") &&
		(!identityOutage.eventsOnly || path === "/events")
	) {
		identityOutage.left--;
		return new Response(
			JSON.stringify({
				error: {
					code: "identity_unavailable",
					message: "the Tailscale identity lookup timed out; try again",
				},
			}),
			{
				status: 503,
				headers: { "Content-Type": "application/json", "Retry-After": "1" },
			},
		);
	}

	if (GET && path === "/hello") {
		const rp = { rpId: url.hostname, origins: [url.origin] };
		const me = deviceOf(req);
		return json({
			...hello(),
			// Which mock this is: the e2e worker that started it checks it
			// (e2e/infra.ts), so a port collision fails loudly.
			...(process.env.PULSAR_E2E_TOKEN
				? { e2eToken: process.env.PULSAR_E2E_TOKEN }
				: {}),
			you: { login: LOGIN, node: me.node, name: me.name },
			session: sessionOf(req),
			canSession: passkeys.has(LOGIN, rp),
			persistSession: !me.pulsarNode,
		});
	}
	if (POST && (path === "/session/options" || path === "/session/verify")) {
		const rp = { rpId: url.hostname, origins: [url.origin] };
		const body = (await jsonBody(req)) as {
			device?: string;
			requestId?: string;
			assertion?: unknown;
		};
		try {
			const me = deviceOf(req);
			return json(
				path === "/session/options"
					? await userSessions.options(LOGIN, rp, body.device, me.nodeId)
					: await userSessions.verify(
							LOGIN,
							rp,
							{ requestId: body.requestId, assertion: body.assertion },
							me,
						),
			);
		} catch (e) {
			if (e instanceof RpcError)
				throw new ApiError(RPC_STATUS[e.code] ?? 400, e.code, e.message);
			throw e;
		}
	}
	if (GET && path === "/sessions")
		return json({ sessions: userSessions.list(LOGIN) });
	if (POST && seg[0] === "sessions" && seg[2] === "revoke") {
		if (!userSessions.revoke(LOGIN, seg[1]!)) throw notFound("no such session");
		return json({ ok: true });
	}
	if (GET && path === "/tree") {
		const group =
			enumParam(q, "group", ["machines", "projects"] as const) ?? "machines";
		const sort = enumParam(q, "sort", TREE_SORTS);
		return json(
			page(
				treeNodes(group, q.get("filter"), sort),
				q.get("cursor"),
				intParam(q, "limit", 50, 500),
			),
		);
	}
	if (GET && seg[0] === "tree" && seg[2] === "children" && seg.length === 3) {
		const sort = enumParam(q, "sort", TREE_SORTS);
		return json(
			page(
				childNodes(seg[1]!, q.get("filter"), sort),
				q.get("cursor"),
				intParam(q, "limit", 100, 1000),
			),
		);
	}
	if (GET && path === "/attention") return json(attention());
	if (GET && path === "/recent")
		return json({
			items: sortAgents(
				agents.filter((a) => a.status !== "offline"),
				"recent",
			)
				.slice(0, intParam(q, "limit", 10, 50))
				.map(row),
		});
	if (GET && path === "/agents") {
		const sort = enumParam(q, "sort", AGENT_SORTS) ?? "attention";
		const all = sortAgents(matching(q.get("selector")), sort);
		const p = page(all, q.get("cursor"), intParam(q, "limit", 50, 500));
		const body: AgentsPage = {
			...p,
			items: p.items.map(row),
			machines: new Set(all.map((a) => a.machineId)).size,
			totals: wakeTotals(all),
		};
		return json(body);
	}
	// Subagents: never in /agents; their own list, page and transcript.
	if (
		GET &&
		seg[0] === "agents" &&
		seg[2] === "subagents" &&
		seg.length === 3
	) {
		const a = agentOr404(seg[1]!);
		return json(
			subagentList(a.id) ?? { agentId: a.id, items: [], total: 0, running: 0 },
		);
	}
	if (GET && seg[0] === "subagents" && seg.length === 2) {
		const sub = subagentById(seg[1]!);
		if (!sub) throw notFound(`no subagent ${seg[1]}`);
		return json(sub);
	}
	if (
		GET &&
		seg[0] === "agents" &&
		seg[2] === "transcript" &&
		seg.length === 3 &&
		seg[1]!.includes("/sub:")
	) {
		const t = subagentTranscript(seg[1]!);
		if (!t) throw notFound(`no agent ${seg[1]}`);
		return json(t);
	}
	if (GET && seg[0] === "agents" && seg.length === 2) {
		const a = agentOr404(seg[1]!);
		if (a.status === "offline") throw notFound(`no agent ${seg[1]}`);
		return json(row(a));
	}
	// Images: same-origin, X-Pulsar required; 404 unknown id, 415 disallowed type.
	if (
		GET &&
		seg[0] === "agents" &&
		seg[2] === "transcript" &&
		seg[3] === "images" &&
		seg[4]
	) {
		const a = agentOr404(seg[1]!);
		const owner = findImage(a, seg[4]);
		if (!owner) throw notFound(`no image ${seg[4]}`);
		if (seg[4].endsWith("#img9"))
			throw new ApiError(
				415,
				"unsupported_media",
				"only PNG, JPEG, GIF and WebP images are served",
			);
		if (seg[4].includes("#doc"))
			return new Response(SAMPLE_PDF, {
				headers: {
					"Content-Type": "application/pdf",
					"Content-Disposition": "inline",
					"X-Content-Type-Options": "nosniff",
					"Content-Security-Policy": "sandbox; default-src 'none'",
				},
			});
		return new Response(owner.role === "tool" ? SCREENSHOT : CHART, {
			headers: {
				"Content-Type": "image/png",
				"Content-Disposition": "inline",
				"Cache-Control": "private, max-age=3600",
			},
		});
	}
	if (
		GET &&
		seg[0] === "agents" &&
		seg[2] === "transcript" &&
		seg.length === 3
	) {
		const a = agentOr404(seg[1]!);
		if (!a.hasTranscript)
			return json({ events: [], cursor: null, available: false });
		const m = machineByName.get(a.machineId)!;
		// Simulated federation: a sleeping machine can't serve its transcripts.
		if (m.link === "asleep" || m.link === "daemon-down")
			throw new ApiError(504, "unreachable", `${a.machine} is unreachable`, {
				machine: a.machine,
			});
		const cursor = q.get("cursor");
		if (cursor !== null && !/^\d+$/.test(cursor))
			throw new ApiError(400, "bad_cursor", "bad cursor");
		return json(transcriptPage(a, cursor));
	}
	if (GET && seg[0] === "agents" && seg[2] === "changes") {
		const a = agentOr404(seg[1]!);
		const mode = q.get("mode") ?? "worktree";
		if (mode !== "worktree" && mode !== "base")
			throw badRequest("mode: expected worktree or base");
		if (seg.length === 3) return json(changesSummary(a, mode));
		if (seg[3] === "file" && seg.length === 4) {
			const path = q.get("path");
			if (!path) throw badRequest("path: required");
			const d = changeFile(a, mode, path);
			if (!d) throw notFound(`no change to ${path}`);
			return json(d);
		}
	}
	// Attachments: the manifest is the acting op; then each file's bytes.
	if (seg[0] === "agents" && seg[2] === "attachments") {
		const a = agentOr404(seg[1]!);
		try {
			if (POST && seg.length === 3) {
				const b = (await jsonBody(req)) as {
					manifest?: unknown;
					assertion?: unknown;
				};
				await requireActing(
					req,
					"attachments.upload",
					{ agent: a.id },
					b.manifest ?? null,
					b.assertion,
				);
				return json(openUpload(a.id, b.manifest));
			}
			if (req.method === "PUT" && seg.length === 5)
				return json(
					putFile(
						a.id,
						seg[3]!,
						Number(seg[4]),
						new Uint8Array(await req.arrayBuffer()),
					),
				);
		} catch (e) {
			if (e instanceof RpcError)
				throw new ApiError(ATTACH_STATUS[e.code] ?? 400, e.code, e.message);
			throw e;
		}
	}
	if (GET && seg[0] === "agents" && seg[2] === "files" && seg.length === 3) {
		const a = agentOr404(seg[1]!);
		return json({
			agent: a.id,
			available: true,
			items: searchFiles(q.get("q") ?? ""),
		});
	}
	// New agent (features/launch): web/mock/launch.ts.
	const launched = await launchRoute(req, url, seg, {
		requireActing,
		broadcast: (s) => {
			for (const st of streams.values()) write(st, "launch", s);
		},
		local: LOCAL,
		error: (status, code, message) => new ApiError(status, code, message),
		stepMs: Number(process.env.PULSAR_MOCK_LAUNCH_MS ?? 600),
	});
	if (launched !== null) return json(launched);
	// Git actions (web/mock/git.ts). An agent address (`<machine>/<id>`)
	// stands for an agent on another machine: its acts need that machine's
	// passkey check, like the daemon's home-node proof.
	if (seg[0] === "agents" && seg[2] === "git" && seg.length === 4) {
		const raw = seg[1]!;
		const a = agentOr404(
			raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw,
		);
		try {
			if (GET && seg[3] === "status")
				return json(gitStatus(a, changesSummary(a, "worktree")));
			if (GET && seg[3] === "pr") return json(gitPrDetails(a));
			if (POST && ["commit", "push", "pr"].includes(seg[3]!)) {
				const body = await jsonBody(req);
				if (!body || typeof body !== "object" || Array.isArray(body))
					throw badRequest("the body must be an object");
				const { assertion, ...params } = body as Record<string, unknown>;
				await requireActing(
					req,
					`git.${seg[3]}`,
					{ agent: raw },
					params,
					assertion,
				);
				const s = changesSummary(a, "worktree");
				if (!s.available)
					throw new ApiError(
						409,
						"git_refused",
						"The agent's folder is not a git worktree.",
					);
				if (seg[3] === "commit") return json(gitCommit(a, s, params));
				if (seg[3] === "push") return json(gitPush(a, params));
				return json(gitCreatePr(a, params));
			}
		} catch (e) {
			if (e instanceof GitMockError)
				throw new ApiError(e.status, e.code, e.message);
			throw e;
		}
	}
	// The issue card (web/mock/issues.ts); an address stands for a remote agent.
	if (GET && seg[0] === "agents" && seg[2] === "issue" && seg.length === 3) {
		const raw = seg[1]!;
		const a = agentOr404(
			raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw,
		);
		return json(issueDetails(a, raw));
	}
	// Mock only: how gh answers the issue card next.
	if (POST && path === "/__mock/issue")
		return json(issueControl((await jsonBody(req)) as { mode?: unknown }));
	// Mock only: change an agent's git state, or fail its next action.
	if (POST && path === "/__mock/git") {
		const b = (await jsonBody(req)) as { agent: string } & Parameters<
			typeof gitControl
		>[1];
		// By name; a fixed fixture first (random agents can share a name).
		const named = agents.filter((x) => x.name === b.agent);
		const a = named.find((x) => x.fixed) ?? named[0];
		if (!a) throw notFound(`no agent ${b.agent}`);
		return json(gitControl(a, b));
	}
	// Mock only: a stand-in acting op (the web client's api.acting flow).
	if (POST && path === "/__mock/acting") {
		const b = (await jsonBody(req)) as {
			op: string;
			agent?: string;
			machine?: string;
			params?: unknown;
			assertion?: unknown;
		};
		await requireActing(
			req,
			b.op,
			{
				...(b.agent ? { agent: b.agent } : {}),
				...(b.machine ? { machine: b.machine } : {}),
			},
			b.params ?? null,
			b.assertion,
		);
		return json({ ok: true, op: b.op });
	}
	// Token usage (web/mock/usage.ts).
	if (GET && path === "/usage") {
		const period = q.get("period") ?? "7d";
		if (!["24h", "7d", "30d", "90d"].includes(period))
			throw badRequest("period: 24h, 7d, 30d or 90d");
		return json(
			usageReport(period as UsagePeriod, Number(q.get("tz") ?? 0) || 0),
		);
	}
	if (GET && seg[0] === "agents" && seg[2] === "usage" && seg.length === 3)
		return json(agentUsage(agentOr404(seg[1]!)));
	if (PUT && path === "/usage/prices") {
		const b = (await jsonBody(req)) as {
			model?: string;
			price?: Record<string, number> | null;
		};
		if (!b.model || b.price === undefined) throw badRequest("model, price");
		try {
			return json(setPrice(b.model, b.price));
		} catch (e) {
			throw badRequest((e as Error).message);
		}
	}
	// Plan usage limits and when to warn (web/mock/usage.ts).
	if (GET && path === "/usage/limits") return json(usageLimits());
	if (PUT && path === "/usage/limits") {
		try {
			return json(setLimitSettings((await jsonBody(req)) as object));
		} catch (e) {
			throw badRequest((e as Error).message);
		}
	}
	// Mock only: no usage at all, the defaults back, or other limit readings.
	if (POST && path === "/__mock/usage")
		return json(
			mockUsage((await jsonBody(req)) as Parameters<typeof mockUsage>[0]),
		);
	// The home node's challenge for an acting op on another machine.
	if (POST && path === "/acting/options") {
		const body = (await jsonBody(req)) as {
			op?: string;
			agent?: string;
			machine?: string;
			params?: unknown;
		};
		if (!body.op) throw badRequest("op: required");
		const remote = body.agent ? body.agent.includes("/") : !!body.machine;
		if (!remote)
			throw badRequest(
				"an action on this machine uses your passkey session; no options needed",
			);
		const rp = { rpId: url.hostname, origins: [url.origin] };
		return json(
			await passkeys.actOptions(LOGIN, rp, {
				op: body.op,
				target: actTarget(body),
				digest: actDigest(body.params ?? null),
			}),
		);
	}
	if (POST && seg[0] === "agents" && seg[2] === "stop" && seg.length === 3) {
		if (!has("stop"))
			throw new ApiError(
				501,
				"not_implemented",
				"stopping agents is not available yet",
			);
		requireSession(req);
		const a = agentOr404(seg[1]!);
		const running = a.status === "busy" || a.status === "needs-you";
		if (running && !a.fixed) {
			a.status = "idle";
			a.statusSince = Date.now();
		}
		const r: StopResult = {
			agentId: a.id,
			result: running ? "interrupted" : "not-running",
			via: "mock",
		};
		return json(r);
	}
	// Mock only: change server state and push it to every stream at once
	// (not on the 700 ms tick), for the realtime end-to-end tests.
	if (POST && path === "/__mock/realtime")
		return json(realtime(await jsonBody(req)));
	// Mock only: forget every passkey and passkey session (test isolation).
	// Mock only: a passkey session without WebAuthn, for WebKit tests (no
	// virtual authenticator there); the test hands the token to the app.
	if (POST && path === "/__mock/session")
		return json(userSessions.issue(LOGIN, "e2e", deviceOf(req)));
	if (POST && path === "/__mock/reset-passkeys") {
		for (const k of passkeys.list()) passkeys.remove(k.id);
		sessionMeta.clear();
		return json({ ok: true });
	}
	// Mock only: serve the app from another folder (a staged deploy) and/or
	// hold every HTML response (a slow network), for the service worker tests.
	if (POST && path === "/__mock/static") {
		const body = (await jsonBody(req)) as {
			root?: string;
			htmlDelayMs?: number;
		};
		web.root = body.root ? resolve(body.root) : STATIC;
		web.htmlDelayMs = body.htmlDelayMs ?? 0;
		return json({ ok: true });
	}
	if (seg[0] === "push") {
		if (GET && seg[1] === "key") return json({ publicKey: vapid.publicKey });
		if (POST && (seg[1] === "subscribe" || seg[1] === "unsubscribe")) {
			// Like the daemon: notifications on or off take a passkey session.
			requireSession(req);
			const b = (await jsonBody(req)) as { endpoint?: string };
			if (seg[1] === "subscribe" && b.endpoint)
				pushPrefs.set(b.endpoint, pushPrefs.get(b.endpoint) ?? {});
			return json({ ok: true });
		}
		// The agent a finish/fail push was about (its payload has only a token).
		if (GET && seg[1] === "turns" && seg[2]) {
			const agentId = turnRefs.get(seg[2]);
			if (!agentId) throw notFound("that notification is too old");
			return json({ agentId });
		}
		// This browser's finish/fail settings, kept with its subscription.
		if (POST && seg[1] === "settings") {
			const b = (await jsonBody(req)) as {
				endpoint?: string;
				turns?: "off" | "notify" | "sound" | "both";
				inApp?: boolean;
			};
			if (typeof b.endpoint !== "string") throw badRequest("endpoint");
			const held = pushPrefs.get(b.endpoint);
			if (held) {
				if (b.turns) held.turns = b.turns;
				if (typeof b.inApp === "boolean") held.inApp = b.inApp;
			}
			return json({
				subscribed: !!held,
				chosen: held?.turns !== undefined,
				turns: held?.turns ?? b.turns ?? "notify",
				inApp: held?.inApp ?? b.inApp ?? true,
			});
		}
	}
	if (seg[0] === "approvals" || seg[0] === "passkeys") {
		if (!has("approvals"))
			throw new ApiError(
				501,
				"not_implemented",
				"approvals are not available yet",
			);
		try {
			return await approvalRoute(req, url, seg, POST);
		} catch (e) {
			if (e instanceof RpcError)
				throw new ApiError(
					RPC_STATUS[e.code] ?? 400,
					e.code,
					e.message,
					(e.data as Record<string, unknown>) ?? {},
				);
			throw e;
		}
	}
	if (GET && path === "/facets") {
		const facet = enumParam(q, "facet", FACET_KEYS);
		return json(
			facets(q.get("selector"), facet, q.get("q"), intParam(q, "top", 8, 100)),
		);
	}
	if (GET && path === "/search") return json(search(q.get("q") ?? ""));
	if (GET && path === "/search/messages") {
		const text = q.get("q") ?? "";
		if (text.length > 200)
			throw new ApiError(400, "bad_request", "q: too long");
		const one = q.get("agent");
		if (one) {
			// Like the daemon: one agent's search runs on its home machine.
			const a = agentOr404(one);
			const link = machineByName.get(a.machineId)?.link;
			if (link === "asleep" || link === "daemon-down")
				throw new ApiError(504, "unreachable", `${a.machine} is unreachable`, {
					machine: a.machine,
				});
		}
		return json(
			searchMessages(text, agents, {
				row,
				...(one ? { agent: one } : {}),
				unreachable: (a) => {
					const link = machineByName.get(a.machineId)?.link;
					return link === "asleep" || link === "daemon-down";
				},
			}),
		);
	}
	if (POST && path === "/ask") {
		const body = (await jsonBody(req)) as Partial<AskRequest>;
		if (typeof body.question !== "string" || !body.question.trim())
			throw new ApiError(400, "bad_request", "question: required");
		return json(ask(body.question, body.selector));
	}
	if (POST && path === "/send") {
		const input = subagentSend(parseSend(await jsonBody(req)));
		return json(doSend({ ...input, proven: sessionOf(req) !== null }));
	}
	if (GET && seg[0] === "messages" && seg[2] === "receipts") {
		const s = sent.get(seg[1]!);
		if (!s) throw notFound(`no message ${seg[1]}`);
		return json(
			receiptsOf(s, {
				state: enumParam(q, "state", RECEIPT_STATES),
				cursor: q.get("cursor"),
				limit: intParam(q, "limit", 100, 500),
			}),
		);
	}
	if (req.method === "PUT" && seg[0] === "subscriptions" && seg[1]) {
		const sub = parseSubscription(await jsonBody(req));
		const s = streams.get(seg[1]);
		if (!s) throw notFound("no such stream; open /events again");
		setSubscription(s, sub);
		return json({ ok: true });
	}
	if (GET && path === "/qr")
		return new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
			headers: { "Content-Type": "image/svg+xml; charset=utf-8" },
		});
	if (GET && path === "/events") return openStream(req);
	throw notFound("no such endpoint");
}

async function api(req: Request, url: URL): Promise<Response> {
	let res: Response;
	try {
		res = await route(req, url);
	} catch (err) {
		res =
			err instanceof ApiError
				? apiError(err)
				: json(
						{ error: { code: "internal", message: (err as Error).message } },
						500,
					);
	}
	if (!res.headers.has("Cache-Control") || res.status !== 200)
		res.headers.set("Cache-Control", "no-store");
	return res;
}

/**
 * The built app with the daemon's static rules (src/transport/static.ts).
 * The root and an HTML delay can change at runtime (`/__mock/static`) so the
 * e2e tests can stage a deploy and a slow network for the service worker.
 */
const web = { root: STATIC, htmlDelayMs: 0 };
async function staticFile(req: Request, url: URL): Promise<Response> {
	const r = await serveStatic(web.root, url.pathname, {
		acceptEncoding: req.headers.get("accept-encoding") ?? undefined,
		ifNoneMatch: req.headers.get("if-none-match") ?? undefined,
	});
	if (r.status === 404 && !existsSync(join(web.root, "index.html")))
		return new Response("dist/web is missing: run `bun run build:web`", {
			status: 500,
		});
	if (web.htmlDelayMs && r.headers["Content-Type"]?.startsWith("text/html"))
		await new Promise((ok) => setTimeout(ok, web.htmlDelayMs));
	return new Response(r.body, { status: r.status, headers: r.headers });
}

const server = Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		const res =
			url.pathname.startsWith("/api/v1/") || url.pathname === "/api/v1"
				? await api(req, url)
				: await staticFile(req, url);
		for (const [k, v] of Object.entries(SECURITY_HEADERS))
			res.headers.set(k, v);
		return res;
	},
});

console.log(
	`pulsar mock: http://${server.hostname}:${server.port} (${machines.length} machines, ${agents.length} agents; features ${FEATURES.join(",")})`,
);

// Started by an e2e worker (web/e2e/infra.ts): stdin is a pipe from it, and
// it closes when the worker ends, even if the worker was killed.
if (process.env.PULSAR_E2E_PIPE === "1") {
	process.stdin.on("close", () => process.exit(0));
	process.stdin.on("end", () => process.exit(0));
	process.stdin.resume();
}
