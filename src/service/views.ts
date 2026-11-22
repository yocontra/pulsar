import type {
	AgentRow,
	AgentSort,
	AgentState,
	AgentsPage,
	Approval,
	AttentionList,
	Facet,
	FacetKey,
	Page,
	Rollup,
	SearchResponse,
	SubagentCounts,
	TreeGroup,
	TreeNode,
	TreePage,
	TreeSort,
	Wake,
} from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import {
	matches,
	parseSelector,
	type Selector,
	withoutKey,
} from "../selector.ts";
import type { Store } from "../store.ts";
import { isAutoTag } from "../tags.ts";
import { isPane } from "../tmux.ts";
import type { Agent, Priority } from "../types.ts";
import { LIMITS } from "./limits.ts";
import { isRemote } from "./pool.ts";
import type { Registry } from "./registry.ts";
import { driverSupports } from "./transcripts.ts";

/**
 * The pool as the app sees it: lazily expanded trees with rollups, paged
 * agent lists, facet counts and search, all computed here so the browser
 * never holds the whole pool. Remote agents (federation's `PoolView`) come
 * in with their pool address as their id.
 */

export type {
	AgentRow,
	AgentSort,
	AgentState,
	Facet,
	FacetKey,
	FacetValue,
	Page,
	Rollup,
	TreeGroup,
	TreeNode,
	TreeSort,
	Wake,
} from "../http/wire.ts";

export const WAKES: readonly Wake[] = [
	"wakes",
	"inbox-only",
	"held",
	"refuses",
	"queued",
];

export const FACET_KEYS = [
	"machine",
	"project",
	"harness",
	"model",
	"branch",
	"status",
	"pr",
	"role",
	"tag",
] as const satisfies readonly FacetKey[];

/** Offsets as opaque cursors. */
export function encodeCursor(offset: number): string {
	return Buffer.from(`o${offset}`).toString("base64url");
}

export function decodeCursor(cursor: string | undefined | null): number {
	if (!cursor) return 0;
	const text = Buffer.from(cursor, "base64url").toString();
	const n = /^o(\d{1,9})$/.exec(text)?.[1];
	if (n === undefined) throw new RpcError("bad_request", "bad cursor");
	return Number(n);
}

function page<T>(all: T[], cursor: string | undefined, limit: number): Page<T> {
	const offset = decodeCursor(cursor);
	const items = all.slice(offset, offset + limit);
	const next = offset + items.length;
	return {
		items,
		total: all.length,
		nextCursor: next < all.length ? encodeCursor(next) : null,
	};
}

const enc = encodeURIComponent;

function machineNodeId(machineId: string) {
	return `m:${enc(machineId)}`;
}

function projectNodeId(project: string | null) {
	return `p:${enc(project ?? "")}`;
}

function agentNodeId(address: string) {
	return `a:${enc(address)}`;
}

/** Parses a tree node id into its machine and project parts. */
function parseNodeId(id: string): { machineId?: string; project?: string } {
	const out: { machineId?: string; project?: string } = {};
	for (const part of id.split("/")) {
		const m = /^([mp]):(.*)$/.exec(part);
		if (!m) throw new RpcError("bad_request", `bad node id ${id}`);
		let value: string;
		try {
			value = decodeURIComponent(m[2]!);
		} catch {
			throw new RpcError("bad_request", `bad node id ${id}`);
		}
		if (m[1] === "m") out.machineId = value;
		else out.project = value;
	}
	return out;
}

const STATE_RANK: Record<AgentState, number> = {
	"needs-you": 0,
	busy: 1,
	idle: 2,
	offline: 3,
};

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

function addToRollup(r: Rollup, row: AgentRow) {
	r.agents++;
	if (row.state === "needs-you") r.needsYou++;
	else if (row.state === "busy") r.busy++;
	else if (row.state === "offline") r.offline++;
	else r.idle++;
	r.lastActive = Math.max(r.lastActive ?? 0, row.lastSeen);
}

function facetValues(row: AgentRow, key: FacetKey): string[] {
	switch (key) {
		case "machine":
			return row.machine ? [row.machine] : [];
		case "project":
		case "harness":
		case "model":
		case "branch":
		case "status": {
			const v = row[key];
			return v ? [v] : [];
		}
		case "pr":
		case "role":
			return row.tags
				.filter((t) => t.startsWith(`${key}:`))
				.map((t) => t.slice(key.length + 1));
		case "tag":
			return row.tags.filter(
				(t) =>
					!isAutoTag(t) &&
					!t.startsWith("pr:") &&
					!t.startsWith("role:") &&
					!t.startsWith("needs:"),
			);
	}
}

function facetTerm(key: FacetKey, value: string): string {
	if (key !== "tag") return `${key}=${value}`;
	const colon = value.indexOf(":");
	return colon > 0
		? `${value.slice(0, colon)}=${value.slice(colon + 1)}`
		: value;
}

/** Why `n` agents can or cannot hear a message, by wake state. */
export function wakeTotals(rows: Iterable<{ wake: Wake }>) {
	const totals = Object.fromEntries(WAKES.map((w) => [w, 0])) as Record<
		Wake,
		number
	>;
	for (const r of rows) totals[r.wake]++;
	return totals;
}

export class Views {
	private readonly registry: Registry;
	private readonly store: Store;
	private readonly machineId: () => string;
	private readonly approvalFor: (agentId: string) => Approval | null;
	private readonly expiredBefore: (
		agent: Agent,
		since: number,
	) => Approval | null;
	private readonly canStop: (agent: Agent) => boolean;
	private readonly subagents: (agentId: string) => SubagentCounts | undefined;

	constructor(deps: {
		registry: Registry;
		store: Store;
		machineId: () => string;
		/** The agent's oldest pending permission prompt (attention items). */
		approvalFor?: (agentId: string) => Approval | null;
		/** The relayed prompt a terminal wait is left over from (Approvals.expiredBefore). */
		expiredBefore?: (agent: Agent, since: number) => Approval | null;
		canStop?: (agent: Agent) => boolean;
		/** A local agent's subagent counts, once found. */
		subagents?: (agentId: string) => SubagentCounts | undefined;
	}) {
		this.registry = deps.registry;
		this.store = deps.store;
		this.machineId = deps.machineId;
		this.approvalFor = deps.approvalFor ?? (() => null);
		this.expiredBefore = deps.expiredBefore ?? (() => null);
		this.canStop = deps.canStop ?? (() => false);
		this.subagents = deps.subagents ?? (() => undefined);
	}

	/**
	 * What a message at `priority` would do, in the order `Router.deliver`
	 * decides: refuse/hold policy, a full inbox, `fyi` (never pushed), then
	 * whether pulsar can push into the session at all.
	 */
	wakeOf(
		agent: Agent,
		priority: Priority = "normal",
		full?: Set<string>,
	): Wake {
		if (agent.status === "gone") return "queued";
		if (agent.inbound === "refuse") return "refuses";
		if (agent.inbound === "hold") return "held";
		const inboxFull = full
			? full.has(agent.id)
			: this.store.unreadCount(agent.id) >= LIMITS.inboxCap;
		if (inboxFull) return "refuses";
		if (priority === "fyi") return "inbox-only";
		return agent.reach === "push" ? "wakes" : "inbox-only";
	}

	stateOf(agent: Agent): AgentState {
		// An idle whose settle time passed shows even if its timer has not run yet.
		if (!isRemote(agent)) this.registry.settleIdle();
		if (agent.status === "gone") return "offline";
		if (isRemote(agent) && !this.reachable(agent)) return "offline";
		if (this.registry.needsYou(agent.id)) return "needs-you";
		return agent.status === "busy" ? "busy" : "idle";
	}

	/** A remote agent's machine answers its link now. */
	private reachable(agent: Agent): boolean {
		const m = this.registry.pool?.machine(agent.meta.machineId ?? "");
		return m?.link === "tailnet";
	}

	/** A remote agent's row: what its home node said, with this node's view of the link. */
	private remoteRow(agent: Agent, priority: Priority): AgentRow {
		const pool = this.registry.pool!;
		const state = this.stateOf(agent);
		let wake: Wake = pool.wake(agent.id) ?? "inbox-only";
		if (!this.reachable(agent)) wake = "queued";
		else if (priority === "fyi" && wake === "wakes") wake = "inbox-only";
		return {
			...this.registry.view(agent),
			machineId: agent.meta.machineId!,
			address: agent.id,
			state,
			stateSince: this.stateSince(agent, state),
			needsYou: this.registry.needsYou(agent.id),
			wake,
			hasTranscript: pool.hasTranscript(agent.id),
			canStop: this.reachable(agent) && pool.canStop(agent.id),
			...subagentField(pool.subagentCounts?.(agent.id)),
		};
	}

	row(
		agent: Agent,
		priority: Priority = "normal",
		full?: Set<string>,
	): AgentRow {
		if (isRemote(agent)) return this.remoteRow(agent, priority);
		const machineId = this.machineId();
		const state = this.stateOf(agent);
		return {
			...this.registry.view(agent),
			machineId,
			address: `${machineId}/${agent.id}`,
			state,
			stateSince: this.stateSince(agent, state),
			needsYou: this.registry.needsYou(agent.id),
			wake: this.wakeOf(agent, priority, full),
			hasTranscript: driverSupports(agent),
			canStop: this.canStop(agent),
			...(isPane(agent.meta.tmux) ? { tmux: agent.meta.tmux } : {}),
			...subagentField(this.subagents(agent.id)),
		};
	}

	/**
	 * When the agent entered its shown state, from the time each change
	 * happened (not when a row was next built): needs-you from the prompt,
	 * an unreachable machine from its link, else from the status change.
	 */
	private stateSince(agent: Agent, state: AgentState): number {
		if (state === "needs-you")
			return (
				this.registry.needsYou(agent.id)?.since ?? this.noticed(agent.id, state)
			);
		if (!isRemote(agent)) return this.registry.statusSince(agent);
		const pool = this.registry.pool;
		if (state === "offline" && agent.status !== "gone") {
			const since = pool?.machine(agent.meta.machineId ?? "")?.linkSince;
			if (since) return since;
		}
		return pool?.statusSince(agent.id) ?? this.noticed(agent.id, state);
	}

	/** Remote agents from nodes that don't send `statusSince`: noticed as rows are built. */
	private since = new Map<string, { state: AgentState; at: number }>();

	private noticed(id: string, state: AgentState): number {
		const seen = this.since.get(id);
		if (seen?.state === state) return seen.at;
		const at = Date.now();
		if (this.since.size > 10_000) this.since.clear();
		this.since.set(id, { state, at });
		return at;
	}

	/** Rows for every live agent in the pool, each computed once (one inbox query for all). */
	rows(priority: Priority = "normal"): AgentRow[] {
		const full = this.store.fullInboxes(LIMITS.inboxCap);
		const local = this.registry.live().map((a) => this.row(a, priority, full));
		const remote = this.registry.remoteAgents();
		if (remote.length === 0) return local;
		for (const a of remote)
			if (a.status !== "gone") local.push(this.remoteRow(a, priority));
		return local;
	}

	/** Live rows a selector matches. */
	matching(selector: string | Selector, rows = this.rows()): AgentRow[] {
		const sel =
			typeof selector === "string" ? parseSelector(selector) : selector;
		return sel.kind === "all" ? rows : rows.filter((r) => matches(r, sel));
	}

	private sortRows(rows: AgentRow[], sort: AgentSort): AgentRow[] {
		const byName = (a: AgentRow, b: AgentRow) =>
			a.name.localeCompare(b.name) || a.address.localeCompare(b.address);
		const sorted = [...rows];
		switch (sort) {
			case "name":
				return sorted.sort(byName);
			case "recent":
				return sorted.sort((a, b) => b.lastSeen - a.lastSeen || byName(a, b));
			case "busy":
				return sorted.sort(
					(a, b) =>
						Number(b.state === "busy") - Number(a.state === "busy") ||
						byName(a, b),
				);
			case "attention":
				return sorted.sort(
					(a, b) =>
						STATE_RANK[a.state] - STATE_RANK[b.state] ||
						b.lastSeen - a.lastSeen ||
						byName(a, b),
				);
		}
	}

	/** `GET /agents`: a page of the match, with its size and machine count. */
	agents(q: {
		selector?: string;
		sort?: AgentSort;
		cursor?: string;
		limit?: number;
	}): AgentsPage {
		const matched = this.sortRows(
			this.matching(q.selector ?? "*"),
			q.sort ?? "attention",
		);
		const machines = new Set(matched.map((r) => r.machineId)).size;
		return {
			...page(matched, q.cursor, q.limit ?? 50),
			machines,
			totals: wakeTotals(matched),
		};
	}

	private machineNode(machineId: string, rows: AgentRow[]): TreeNode {
		const rollup = emptyRollup();
		const projects = new Set<string | null>();
		for (const r of rows) {
			addToRollup(rollup, r);
			projects.add(r.project);
		}
		const local = machineId === this.machineId();
		const remote = local ? undefined : this.registry.pool?.machine(machineId);
		const machine = rows[0]?.machine ?? remote?.name ?? null;
		return {
			id: machineNodeId(machineId),
			kind: "machine",
			label: machine ?? machineId,
			selector: machine ? term("machine", machine) : idTerm(rows),
			machineId,
			machine,
			project: null,
			link: local ? "local" : (remote?.link ?? null),
			...(remote?.reason ? { reason: remote.reason } : {}),
			rollup,
			childCount: projects.size,
			agent: null,
		};
	}

	private projectNode(
		id: string,
		project: string | null,
		rows: AgentRow[],
		within: { machineId: string; machine: string | null } | null,
	): TreeNode {
		const rollup = emptyRollup();
		const machines = new Set<string>();
		for (const r of rows) {
			addToRollup(rollup, r);
			machines.add(r.machineId);
		}
		// No selector key matches "no project": name the agents instead.
		const selector =
			project === null
				? idTerm(rows)
				: [
						within?.machine ? term("machine", within.machine) : null,
						term("project", project),
					]
						.filter(Boolean)
						.join(" ");
		return {
			id,
			kind: "project",
			label: project ?? "(no project)",
			selector,
			machineId: within?.machineId ?? null,
			machine: within?.machine ?? null,
			project,
			link: null,
			rollup,
			// Inside a machine a project holds agents; at the top it holds machines.
			childCount: within ? rows.length : machines.size,
			agent: null,
		};
	}

	private agentNode(row: AgentRow): TreeNode {
		return {
			id: agentNodeId(row.address),
			kind: "agent",
			label: row.name,
			selector: term("id", row.id),
			machineId: row.machineId,
			machine: row.machine ?? null,
			project: row.project,
			link: null,
			rollup: null,
			childCount: 0,
			agent: row,
		};
	}

	/** Every top-level node of a grouping (no paging), sorted; this machine first. */
	treeNodes(group: TreeGroup, filter?: string, sort?: TreeSort): TreeNode[] {
		const rows = this.matching(filterSelector(filter));
		const local = this.machineId();
		if (group === "machines") {
			const byMachine = groupBy(rows, (r) => r.machineId);
			// Pool machines with nothing to show (no agents, asleep before a
			// snapshot, a version to upgrade) still appear, unfiltered.
			if (filterSelector(filter) === "*")
				for (const m of this.registry.pool?.machines() ?? [])
					if (!byMachine.has(m.machineId)) byMachine.set(m.machineId, []);
			return sortNodes(
				[...byMachine.entries()].map(([id, list]) =>
					this.machineNode(id, list),
				),
				sort,
				(a, b) => Number(b.machineId === local) - Number(a.machineId === local),
			);
		}
		const byProject = groupBy(rows, (r) => r.project);
		return sortNodes(
			[...byProject.entries()].map(([project, list]) =>
				this.projectNode(projectNodeId(project), project, list, null),
			),
			sort,
			noProjectLast,
		);
	}

	/** `GET /tree`: top-level nodes with rollups (and `expand`ed branches). */
	tree(q: {
		group?: TreeGroup;
		filter?: string;
		sort?: TreeSort;
		cursor?: string;
		limit?: number;
		expand?: string;
	}): TreePage {
		const group = q.group ?? "machines";
		const top = page(
			this.treeNodes(group, q.filter, q.sort),
			q.cursor,
			q.limit ?? 50,
		);
		if (!q.expand) return top;
		const ids = new Set<string>();
		for (const id of q.expand.split(",").slice(0, 20)) {
			if (id !== "default") ids.add(id);
			else if (group === "machines") {
				// As the app's first-visit expansion (web/src/lib/store.ts):
				// this machine, or every machine when the pool is small.
				const machines = top.items.filter((n) => n.kind === "machine");
				const agents = machines.reduce(
					(s, n) => s + (n.rollup?.agents ?? 0),
					0,
				);
				const small = machines.length <= 3 || agents <= 30;
				for (const n of machines)
					if (small || n.machineId === this.machineId()) ids.add(n.id);
			}
		}
		const expanded: Record<string, Page<TreeNode>> = {};
		for (const id of [...ids].slice(0, 10)) {
			try {
				expanded[id] = page(
					this.childNodes(id, q.filter, q.sort),
					undefined,
					100,
				);
			} catch {}
		}
		return { ...top, expanded };
	}

	/** Every child of a node (no paging), sorted. */
	childNodes(nodeId: string, filter?: string, sort?: TreeSort): TreeNode[] {
		const { machineId, project } = parseNodeId(nodeId);
		const rows = this.matching(filterSelector(filter)).filter(
			(r) =>
				(machineId === undefined || r.machineId === machineId) &&
				(project === undefined || (r.project ?? "") === project),
		);
		const leaf = machineId !== undefined && project !== undefined;
		if (leaf)
			return this.sortRows(rows, AGENT_SORT[sort ?? "needs"]).map((r) =>
				this.agentNode(r),
			);
		if (machineId !== undefined) {
			// machine → projects
			const machine = rows[0]?.machine ?? null;
			return sortNodes(
				[...groupBy(rows, (r) => r.project).entries()].map(([p, list]) =>
					this.projectNode(
						`${machineNodeId(machineId)}/${projectNodeId(p)}`,
						p,
						list,
						{ machineId, machine },
					),
				),
				sort,
				noProjectLast,
			);
		}
		// project → machines
		return sortNodes(
			[...groupBy(rows, (r) => r.machineId).entries()].map(([mid, list]) => {
				const node = this.machineNode(mid, list);
				return {
					...node,
					id: `${projectNodeId(project ?? null)}/${machineNodeId(mid)}`,
					selector: project
						? `${node.selector} ${term("project", project)}`
						: idTerm(list),
					project: project || null,
					childCount: list.length,
				};
			}),
			sort,
		);
	}

	/** `GET /tree/:nodeId/children`. */
	children(
		nodeId: string,
		q: { filter?: string; sort?: TreeSort; cursor?: string; limit?: number },
	): Page<TreeNode> {
		return page(
			this.childNodes(nodeId, q.filter, q.sort),
			q.cursor,
			q.limit ?? 100,
		);
	}

	/** `GET /attention`: agents waiting on the user, approvals first, newest first. */
	attention(): AttentionList {
		const full = this.store.fullInboxes(LIMITS.inboxCap);
		// Agents anywhere in the pool; a remote one only while its machine answers.
		const remote = this.registry
			.remoteAgents()
			.filter(
				(a) =>
					a.status !== "gone" &&
					this.registry.needsYou(a.id) !== null &&
					this.reachable(a),
			);
		const items = [...this.registry.needingYou(), ...remote].flatMap((a) => {
			const agent = this.row(a, "normal", full);
			const needs = agent.needsYou;
			if (!needs) return [];
			const approval =
				needs.reason === "approval" ? this.approvalFor(a.id) : null;
			const local = !isRemote(a);
			const expired =
				needs.reason === "terminal" && local
					? this.expiredBefore(a, needs.since)
					: null;
			return [
				{
					id: `${agent.address}@${needs.since}`,
					kind: needs.reason,
					agent,
					title:
						needs.detail ??
						(needs.reason === "approval" ? "Approval" : "Asked you"),
					createdAt: needs.since,
					...(approval ? { approval } : {}),
					...(needs.reason === "terminal" && local
						? {
								terminal: expired
									? { why: "expired" as const, approval: expired }
									: { why: "not-sent" as const },
							}
						: {}),
				},
			];
		});
		// Approvals first (they expire), then questions; newest first within each.
		items.sort(
			(a, b) =>
				Number(b.kind === "approval") - Number(a.kind === "approval") ||
				b.createdAt - a.createdAt,
		);
		return { items, total: items.length };
	}

	/** `GET /recent`: the most recently active agents. */
	recent(limit = 10): { items: AgentRow[] } {
		return { items: this.sortRows(this.rows(), "recent").slice(0, limit) };
	}

	/**
	 * `GET /facets`: value counts among the agents the selector matches, each
	 * facet ignoring its own terms (so `machine=a` still shows machine b).
	 */
	facets(q: { selector?: string; facet?: FacetKey; q?: string; top?: number }) {
		const selector = parseSelector(q.selector ?? "*");
		const rows = this.rows();
		const total = this.matching(selector, rows).length;
		const top = q.top ?? 8;
		const needle = q.q?.toLowerCase() ?? "";
		const one = (key: FacetKey): Facet => {
			const counts = new Map<string, number>();
			for (const r of this.matching(withoutKey(selector, key), rows))
				for (const v of new Set(facetValues(r, key)))
					if (!needle || v.toLowerCase().includes(needle))
						counts.set(v, (counts.get(v) ?? 0) + 1);
			const sorted = [...counts.entries()].sort(
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
		if (q.facet) return { total, facet: q.facet, ...one(q.facet) };
		return {
			total,
			facets: Object.fromEntries(FACET_KEYS.map((k) => [k, one(k)])) as Record<
				FacetKey,
				Facet
			>,
		};
	}

	/** `GET /search`: machines, projects, agents and tags matching `q`, at most `max` each. */
	search(text: string, max = 5): SearchResponse {
		const needle = text.trim().toLowerCase();
		const empty: SearchResponse = {
			machines: [],
			projects: [],
			agents: [],
			tags: [],
		};
		if (!needle) return empty;
		const rows = this.rows();
		const has = (v: string | null | undefined) =>
			Boolean(v?.toLowerCase().includes(needle));

		const machines = [...groupBy(rows, (r) => r.machineId).entries()]
			.filter(([, list]) => has(list[0]?.machine))
			.map(([id, list]) => ({
				id: machineNodeId(id),
				machineId: id,
				name: list[0]?.machine ?? id,
				agents: list.length,
			}))
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, max);

		const projects = [...groupBy(rows, (r) => r.project).entries()]
			.filter(([p]) => has(p))
			.map(([p, list]) => ({
				id: projectNodeId(p),
				name: p ?? "",
				agents: list.length,
				machines: new Set(list.map((r) => r.machineId)).size,
			}))
			.sort((a, b) => b.agents - a.agents || a.name.localeCompare(b.name))
			.slice(0, max);

		const agents = this.sortRows(
			rows.filter(
				(r) =>
					has(r.name) ||
					has(r.id) ||
					has(r.branch) ||
					has(r.activity) ||
					has(r.model),
			),
			"attention",
		).slice(0, max);

		const tagCounts = new Map<string, number>();
		for (const r of rows)
			for (const t of r.tags)
				if (has(t)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
		const tags = [...tagCounts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, max)
			.map(([tag, count]) => ({
				tag,
				count,
				term: facetTerm("tag", tag),
			}));

		return { machines, projects, agents, tags };
	}
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
	const out = new Map<K, T[]>();
	for (const item of items) {
		const k = key(item);
		const list = out.get(k);
		if (list) list.push(item);
		else out.set(k, [item]);
	}
	return out;
}

/** "(no project)" sorts last. */
function noProjectLast(a: TreeNode, b: TreeNode) {
	return Number(a.project === null) - Number(b.project === null);
}

const AGENT_SORT: Record<TreeSort, AgentSort> = {
	needs: "attention",
	busy: "busy",
	recent: "recent",
	name: "name",
};

/** Groups in tree order: `first` (pinned placement), then `sort`, then by label. */
function sortNodes(
	nodes: TreeNode[],
	sort: TreeSort = "name",
	first: (a: TreeNode, b: TreeNode) => number = () => 0,
): TreeNode[] {
	const r = (n: TreeNode) => n.rollup ?? emptyRollup();
	const by: Record<TreeSort, (a: TreeNode, b: TreeNode) => number> = {
		needs: (a, b) => r(b).needsYou - r(a).needsYou || r(b).busy - r(a).busy,
		busy: (a, b) => r(b).busy - r(a).busy,
		recent: (a, b) => (r(b).lastActive ?? 0) - (r(a).lastActive ?? 0),
		name: () => 0,
	};
	return nodes.sort(
		(a, b) => first(a, b) || by[sort](a, b) || a.label.localeCompare(b.label),
	);
}

/**
 * The tree's filter box: a selector, or one plain word meaning `~word`
 * (text anywhere), so typing "auth" finds agents on auth branches.
 */
/** `AgentRow.subagents`: only when there are some. */
function subagentField(c: SubagentCounts | undefined | null) {
	return c && c.total > 0 ? { subagents: c } : {};
}

export function filterSelector(filter: string | undefined): string {
	const f = filter?.trim() ?? "";
	if (!f) return "*";
	return /[=~#*\s,]/.test(f) ? f : `~${f}`;
}

/** One selector term; selectors split on whitespace and commas. */
function term(key: string, value: string): string {
	return `${key}=${value.replace(/[\s,]+/g, "*")}`;
}

/** Names agents directly, for groups no selector key describes. */
function idTerm(rows: AgentRow[]): string {
	return rows.length ? `id=${rows.map((r) => r.id).join("|")}` : "id=";
}
