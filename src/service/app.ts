import { randomBytes } from "node:crypto";
import { FED_PROTOCOL } from "../federation/protocol.ts";
import type {
	AgentRow,
	AgentSort,
	DryRun,
	FacetKey,
	Feature,
	Hello,
	MachineCount,
	ReceiptRow,
	ReceiptsPage,
	SendDone,
	SendRequest,
	TreeGroup,
	TreeSort,
} from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import type { Agent, Priority, Receipt, ReceiptState } from "../types.ts";
import { VERSION } from "../version.ts";
import { authorize } from "./authorize.ts";
import { OPERATOR_ID, type Principal } from "./caller.ts";
import { LIMITS } from "./limits.ts";
import type { Mailbox } from "./mailbox.ts";
import { splitAddress, splitSubagentId } from "./pool.ts";
import type { Registry } from "./registry.ts";
import { forParentBody, type Subagents } from "./subagents.ts";
import { delivered, normalPriority } from "./util.ts";
import { type Views, wakeTotals } from "./views.ts";

export type UserSendInput = SendRequest;

/** How long a real send's `clientId` answers a retry with the first result. */
const CLIENT_ID_TTL_MS = 10 * 60_000;
const MAX_CLIENT_IDS = 2000;
export type DryRunResult = DryRun;
export type SendResult = SendDone;

/** What this daemon serves. */
const FEATURES: Feature[] = [
	"tree",
	"facets",
	"send",
	"events",
	"transcripts",
	"receipts",
	"approvals",
	"push",
	"stop",
	"ask",
	"subagents",
	"usage",
];

interface ResolveToken {
	login: string;
	key: string;
	ids: Set<string>;
	expiresAt: number;
}

const PREVIEW = 20;
const RECEIPTS_INLINE = 50;

/**
 * The app's operations for a tailnet user principal: pool views, dry-run
 * and real sends as the user, receipts. Each checks `authorize` itself.
 */
export class AppApi {
	private readonly registry: Registry;
	private readonly store: Store;
	private readonly mailbox: Mailbox;
	readonly views: Views;
	private readonly machine: () => { id: string; name: string };
	private readonly subagents: Subagents;
	private tokens = new Map<string, ResolveToken>();
	/** Real sends by `<login> <clientId>`, for idempotent retries. */
	private sent = new Map<string, { at: number; result: Promise<SendResult> }>();
	/** The operator sent from the app to these agents (notification interest). */
	onOperatorSend: (agentIds: string[]) => void = () => {};

	constructor(deps: {
		registry: Registry;
		store: Store;
		mailbox: Mailbox;
		views: Views;
		machine: () => { id: string; name: string };
		subagents: Subagents;
	}) {
		this.subagents = deps.subagents;
		this.registry = deps.registry;
		this.store = deps.store;
		this.mailbox = deps.mailbox;
		this.views = deps.views;
		this.machine = deps.machine;
	}

	/** `GET /hello`, less `appUrl` (the transport knows its own URL). */
	hello(p: Principal): Omit<Hello, "appUrl"> {
		authorize(p, "hello");
		const { id, name } = this.machine();
		return {
			version: VERSION,
			machineId: id,
			machine: name,
			fedProtocol: FED_PROTOCOL,
			features: FEATURES,
			...(p.kind === "human"
				? {
						you: {
							login: p.login,
							node: p.node,
							...(p.name ? { name: p.name } : {}),
						},
					}
				: {}),
			machines:
				1 +
				(this.registry.pool
					?.machines()
					.filter((m) => m.link === "tailnet" && m.agents > 0).length ?? 0),
			agents:
				this.registry.live().length +
				this.registry.remoteAgents().filter((a) => a.status !== "gone").length,
			firstRun: this.registry.all().length === 0,
		};
	}

	/** `GET /agents/:id`: one live agent's row. */
	agent(p: Principal, id: string): AgentRow {
		authorize(p, "agents");
		// The operator: shown while a presence check from a terminal waits on
		// it, and still readable once answered (the open view refreshes).
		const agent =
			this.registry.find(id) ??
			(id === OPERATOR_ID ? this.registry.operator() : undefined);
		if (!agent || agent.status === "gone")
			throw new RpcError("not_found", `no agent ${id}`);
		return this.views.row(agent);
	}

	tree(
		p: Principal,
		q: {
			group?: TreeGroup;
			filter?: string;
			sort?: TreeSort;
			cursor?: string;
			limit?: number;
			expand?: string;
		},
	) {
		authorize(p, "tree");
		return this.views.tree(q);
	}

	children(
		p: Principal,
		nodeId: string,
		q: { filter?: string; sort?: TreeSort; cursor?: string; limit?: number },
	) {
		authorize(p, "tree");
		return this.views.children(nodeId, q);
	}

	attention(p: Principal) {
		authorize(p, "attention");
		return this.views.attention();
	}

	recent(p: Principal, limit?: number) {
		authorize(p, "recent");
		return this.views.recent(limit);
	}

	agents(
		p: Principal,
		q: { selector?: string; sort?: AgentSort; cursor?: string; limit?: number },
	) {
		authorize(p, "agents");
		return this.views.agents(q);
	}

	facets(
		p: Principal,
		q: { selector?: string; facet?: FacetKey; q?: string; top?: number },
	) {
		authorize(p, "facets");
		return this.views.facets(q);
	}

	search(p: Principal, q: string) {
		authorize(p, "search");
		return this.views.search(q);
	}

	/**
	 * A send from the human operator: tagged `[human operator - <name>]` with
	 * a passkey session, else framed "not verified as your operator".
	 * `dryRun` predicts receipts and returns a resolve token; a real send over
	 * `LIMITS.confirmAbove` recipients needs one, and is refused (409) when the
	 * match drifted by more than `LIMITS.maxDrift` since the dry run.
	 */
	async send(
		p: Principal,
		input: UserSendInput,
	): Promise<DryRunResult | SendResult> {
		authorize(p, "send");
		if (input.clientId && !input.dryRun && p.kind === "human") {
			// Checked before the resolve token: a retry reuses a token the first
			// attempt already took. In flight or done, the same send answers.
			const key = `${p.login} ${input.clientId}`;
			const now = Date.now();
			for (const [k, v] of this.sent)
				if (now - v.at > CLIENT_ID_TTL_MS) this.sent.delete(k);
				else break;
			const held = this.sent.get(key);
			if (held) return held.result;
			const result = this.sendOnce(p, input) as Promise<SendResult>;
			this.sent.set(key, { at: now, result });
			while (this.sent.size > MAX_CLIENT_IDS) {
				const first = this.sent.keys().next().value;
				if (first === undefined) break;
				this.sent.delete(first);
			}
			// A refused send is not remembered: a retry tries again.
			result.catch(() => {
				if (this.sent.get(key)?.result === result) this.sent.delete(key);
			});
			return result;
		}
		return this.sendOnce(p, input);
	}

	private async sendOnce(
		p: Principal,
		input: UserSendInput,
	): Promise<DryRunResult | SendResult> {
		if (p.kind !== "human")
			throw new RpcError("forbidden", "only the tailnet user sends this way");
		const sender = this.registry.user(
			p.login,
			p.node,
			p.verified === true,
			p.name,
		);
		const ids = input.ids?.length ? [...new Set(input.ids)] : null;
		const to = input.to?.trim() ?? "";
		if (!ids && !to)
			throw new RpcError("bad_request", "give `to` (a selector) or `ids`");
		if (ids && to)
			throw new RpcError("bad_request", "give `to` or `ids`, not both");
		if (ids && ids.length > LIMITS.maxSendIds)
			throw new RpcError(
				"too_large",
				`at most ${LIMITS.maxSendIds} ids in one send`,
			);
		const key = ids ? `ids:${[...ids].sort().join(",")}` : `to:${to}`;
		const priority = normalPriority(input.priority ?? "normal");
		let body = input.body ?? "";
		let targets: Agent[];
		if (ids?.some((id) => splitSubagentId(id))) {
			const r = await this.subagentTargets(p, ids, body, input.viaParent);
			targets = r.targets;
			body = r.body;
		} else targets = this.resolve(ids, to, sender);

		if (input.dryRun) return this.dryRun(p.login, key, targets, priority);
		if (targets.length === 0)
			throw new RpcError(
				"no_recipients",
				ids ? "none of those agents is live" : `no live agent matches "${to}"`,
			);
		this.onOperatorSend(targets.map((t) => t.id));
		if (input.resolveToken) {
			const token = this.takeToken(input.resolveToken);
			if (!token || token.login !== p.login || token.key !== key)
				throw new RpcError(
					"stale_token",
					"the resolve token expired or belongs to another send; confirm again",
					this.dryRun(p.login, key, targets, priority),
				);
			const now = new Set(targets.map((t) => t.id));
			let diff = 0;
			for (const id of now) if (!token.ids.has(id)) diff++;
			for (const id of token.ids) if (!now.has(id)) diff++;
			if (diff / Math.max(token.ids.size, 1) > LIMITS.maxDrift)
				throw new RpcError(
					"drift",
					`the recipients changed since the dry run (${token.ids.size} → ${targets.length}); confirm again`,
					this.dryRun(p.login, key, targets, priority),
				);
		} else if (targets.length > LIMITS.confirmAbove) {
			throw new RpcError(
				"confirm",
				`a send to ${targets.length} agents needs a dry run first; confirm with its resolveToken`,
				this.dryRun(p.login, key, targets, priority),
			);
		}

		const label = ids
			? ids.length <= 10
				? `id=${ids.join("|")}`
				: `ids:${ids.length}`
			: to;
		const r = await this.mailbox.send(
			sender,
			{
				to: label,
				body,
				priority,
				replyTo: null,
				expectReply: Boolean(input.expectReply),
			},
			targets,
		);
		const totals: Partial<Record<ReceiptState, number>> = {};
		for (const rc of r.receipts) totals[rc.state] = (totals[rc.state] ?? 0) + 1;
		return {
			dryRun: false,
			message: r.message,
			count: r.receipts.length,
			totals,
			receipts: this.receiptRows(r.receipts.slice(0, RECEIPTS_INLINE), []),
		};
	}

	/**
	 * A send naming subagents: a subagent whose harness takes messages
	 * directly gets it in its own session; one that can't is refused unless
	 * `viaParent` (one subagent only), which sends to its parent with the
	 * subagent named in the body. Never claims a delivery that can't happen.
	 */
	private async subagentTargets(
		p: Principal,
		ids: string[],
		body: string,
		viaParent: boolean | undefined,
	): Promise<{ targets: Agent[]; body: string }> {
		const targets: Agent[] = [];
		for (const id of ids) {
			if (!splitSubagentId(id)) {
				const agent = this.registry.find(id);
				if (agent && agent.status !== "gone") targets.push(agent);
				continue;
			}
			const row = await this.subagents.get(id, p);
			const direct = this.subagents.deliveryTarget(row);
			if (direct) {
				targets.push(direct);
				continue;
			}
			if (row.messaging.mode === "direct" && row.state === "done")
				throw new RpcError("gone", `subagent ${row.name} has finished`);
			if (!viaParent || ids.length !== 1)
				throw new RpcError("subagent_unreachable", row.messaging.note, {
					parentId: row.parentId,
					note: row.messaging.note,
				});
			const parent = this.registry.find(row.parentId);
			if (!parent || parent.status === "gone")
				throw new RpcError("no_recipients", "the parent agent is not live");
			return { targets: [parent], body: forParentBody(row, body) };
		}
		return { targets, body };
	}

	private resolve(ids: string[] | null, to: string, sender: Agent): Agent[] {
		if (!ids) return this.registry.resolvePool(to, sender);
		return ids.flatMap((id) => {
			const agent = this.registry.find(id);
			return agent && agent.status !== "gone" ? [agent] : [];
		});
	}

	private dryRun(
		login: string,
		key: string,
		targets: Agent[],
		priority: Priority,
	): DryRunResult {
		const full = this.store.fullInboxes(LIMITS.inboxCap);
		const rows = targets.map((a) => this.views.row(a, priority, full));
		const expiresAt = Date.now() + LIMITS.resolveTokenMs;
		const resolveToken = randomBytes(16).toString("base64url");
		this.pruneTokens();
		this.tokens.set(resolveToken, {
			login,
			key,
			ids: new Set(targets.map((t) => t.id)),
			expiresAt,
		});
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
		return {
			dryRun: true,
			count: rows.length,
			machines: byMachine.size,
			breakdown: [...byMachine.values()].sort((a, b) => b.count - a.count),
			totals: wakeTotals(rows),
			resolveToken,
			expiresAt,
			preview: rows.slice(0, PREVIEW),
		};
	}

	/** One use per token. */
	private takeToken(id: string): ResolveToken | null {
		const token = this.tokens.get(id);
		this.tokens.delete(id);
		return token && token.expiresAt > Date.now() ? token : null;
	}

	private pruneTokens() {
		const now = Date.now();
		for (const [id, t] of this.tokens)
			if (t.expiresAt <= now) this.tokens.delete(id);
		// Oldest first (Map order); a flood of dry runs only drops old tokens.
		while (this.tokens.size >= LIMITS.maxResolveTokens) {
			const first = this.tokens.keys().next().value;
			if (first === undefined) break;
			this.tokens.delete(first);
		}
	}

	/**
	 * Receipts with where each recipient runs (a remote recipient's id is its
	 * pool address) and, once it answered, the text of its latest reply.
	 */
	private receiptRows(
		receipts: Receipt[],
		replies: { fromId: string; body: string }[],
	): ReceiptRow[] {
		const { id, name } = this.machine();
		const reply = new Map(replies.map((m) => [m.fromId, m.body]));
		return receipts.map((r) => {
			const text = reply.get(r.agentId);
			const remote = splitAddress(r.agentId);
			const machine = remote
				? (this.registry.pool?.machine(remote.machineId)?.name ??
					remote.machineId)
				: name;
			const harness = this.registry.find(r.agentId)?.harness;
			return {
				...r,
				machineId: remote?.machineId ?? id,
				machine,
				...(harness ? { harness } : {}),
				...(text !== undefined ? { reply: text } : {}),
			};
		});
	}

	/** `GET /messages/:id/receipts`: a page of one of the user's sends, with replies. */
	receipts(
		p: Principal,
		messageId: string,
		q: { state?: ReceiptState; offset?: number; limit?: number },
	): Omit<ReceiptsPage, "nextCursor"> {
		authorize(p, "receipts");
		const message = this.store.getMessage(messageId);
		// Only the user's own sends; anything else reads as missing.
		if (
			!message ||
			(p.kind === "human" && message.fromId !== `user:${p.login}`)
		)
			throw new RpcError("not_found", `no message ${messageId}`);
		const totals = this.store.receiptTotals(messageId);
		const total = q.state
			? (totals[q.state] ?? 0)
			: Object.values(totals).reduce((a, b) => a + (b ?? 0), 0);
		const replies = this.store
			.repliesTo(messageId)
			.map((m) => delivered(m, this.registry.from(m.fromId, m.fromName)));
		return {
			message,
			totals,
			items: this.receiptRows(
				this.store.receiptPage(
					messageId,
					q.state ?? null,
					q.offset ?? 0,
					q.limit ?? 100,
				),
				replies,
			),
			total,
			replies,
		};
	}
}
