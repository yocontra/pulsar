import { randomUUID } from "node:crypto";
import { canonicalJson, sha256hex } from "../canonical.ts";
import type {
	HarnessDriver,
	HookDecision,
	LocalAnswerCheck,
	PromptRef,
} from "../harnesses/types.ts";
import type {
	Approval,
	ApprovalDecision,
	ApprovalState,
	DecideResponse,
	InteractionAnswer,
	InteractionKind,
	InteractionPrompt,
	PasskeyInfo,
	SecurityNotice,
	UserSessionInfo,
} from "../http/wire.ts";
import { operatorName } from "../human-tag.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import type { Agent } from "../types.ts";
import { authorize } from "./authorize.ts";
import {
	type Caller,
	type Principal,
	principalLabel,
	requesterOf,
} from "./caller.ts";
import type { EventBus } from "./events.ts";
import {
	answerApproves,
	answerHash,
	answerLabel,
	cleanAnswer,
	cleanPrompt,
	needsDetail,
	redactAnswer,
} from "./interactions.ts";
import type {
	ApprovalBinding,
	Passkeys,
	RelyingParty,
	Signer,
} from "./passkeys.ts";
import { isAddress, type RemoteApprovals } from "./pool.ts";
import { type Confirmed, spendConfirmed } from "./presence.ts";
import type { Registry } from "./registry.ts";

/**
 * Permission prompts relayed from harness hooks, decided in the app; first
 * answer wins.
 *
 * A hook (`pulsar hook claude-permission`) asks `approval.request` over the
 * socket and blocks. The prompt is stored, the agent gets the needs-you
 * status, and every app tab hears about it at once. It ends exactly once,
 * by compare-and-set on `state = 'pending'`:
 *
 * - a passkey-signed decision from the app (the hook prints it);
 * - an answer on the agent's own screen: the hook's connection closes (the
 *   harness killed it), or the driver's probe sees the local prompt gone (the
 *   hook is released with no decision);
 * - the daemon's timeout, shorter than the hook's (the hook prints nothing
 *   and the local prompt decides).
 *
 * Every decision and refusal goes to the `audit` table.
 */

export type { HookDecision };

/** A harness's interactive-tool adapter (the driver's `interactions`). */
export type InteractionAdapter = NonNullable<HarnessDriver["interactions"]>;

/**
 * `interaction.ask` from the pi/omp extension: a host dialog (or omp's own
 * ask, approval or plan review) raced against the app. `ref` is the
 * extension's own id for it, so it can say the local dialog answered first.
 */
export interface InteractionRequest {
	ref: string;
	kind: InteractionKind;
	/** What asks: a tool name, or the dialog method (`ui.select`). */
	tool: string;
	/** Permission only: what is asked about (shown exactly). */
	input: Record<string, unknown>;
	prompt: InteractionPrompt | null;
	/** Permission only: what "Allow for session" covers; null offers Allow once only. */
	sessionRules: string[] | null;
	/** How long to wait for the app; the local dialog may time out first. */
	timeoutMs: number | null;
	/** Shown in the app, answered only on the agent's own screen (Codex). */
	readOnly?: boolean;
}

/** How an interaction ended in the app, as the extension hears it. */
export interface InteractionResult {
	decision: ApprovalDecision;
	answer: InteractionAnswer | null;
	note: string | null;
}

export interface ApprovalRequest {
	sessionId: string;
	promptId: string | null;
	tool: string;
	input: Record<string, unknown>;
	suggestions: unknown[];
	cwd: string | null;
	transcriptPath: string | null;
	/** Claude's timeout for the hook (its `--timeout`); null from hooks installed before it. */
	hookTimeoutS?: number | null;
	/**
	 * Set when the hook asks again after a daemon restart: how long ago Claude
	 * started it, so the deadline stays where it was.
	 */
	elapsedMs?: number;
}

export interface ApprovalsOptions {
	store: Store;
	registry: Registry;
	events: EventBus;
	passkeys: Passkeys;
	/** How long the daemon waits before letting the local prompt decide. */
	timeoutMs?: number;
	/** How often pending prompts are checked for a local answer. */
	pollMs?: number;
	/**
	 * Whether anyone could answer from the app: the app is served here and
	 * this node has enrolled a passkey (its prompts are approved only with
	 * its own credentials, through any pool node's app).
	 */
	answerable?: () => boolean;
	/** The app is served on this node (the mesh is on); without it, nobody sees the card. */
	appServed?: () => boolean;
	/** The local-answer probe for an agent; the harness driver's by default. */
	probe?: (agent: Agent, prompt: PromptRef) => LocalAnswerCheck | null;
	/** The harness's interactive-tool adapter for an agent (the driver's by default). */
	adapter?: (agent: Agent) => InteractionAdapter | null;
	now?: () => number;
}

/**
 * A permission prompt from a hook that doesn't say its timeout (installed
 * before `--timeout`): answered before Claude's old 600 s hook timeout.
 */
export const APPROVAL_TIMEOUT_MS = 540_000;
/**
 * Questions and plans from such a hook: the operator may be away from the
 * terminal. Under the hook's own 3600 s limit (src/hook.ts).
 */
export const INTERACTION_TIMEOUT_MS = 3_540_000;

/** The longest timer Node holds (~24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * How long the app may answer a hook's prompt: until a minute (a tenth, for
 * short timeouts) before Claude gives up on the hook, so the hook (which
 * gives up 20 s before Claude does) can still print the app's answer.
 * `fallback` when the hook didn't say its timeout.
 */
export function approvalDeadlineMs(
	hookTimeoutS: number | null | undefined,
	fallback: number,
): number {
	if (!hookTimeoutS) return fallback;
	const ms = hookTimeoutS * 1000;
	return Math.min(MAX_TIMER_MS, Math.max(ms - 60_000, ms * 0.9));
}

/** The longest an extension or harness-server prompt waits for the app: a day. */
const MAX_ASK_MS = 86_400_000;

/** A prompt asked again with less than this left goes to the terminal at once. */
const MIN_LEFT_MS = 5_000;

type Row = Record<string, string | number | null>;

/** A terminal wait shows within a scan or two of the relayed prompt expiring. */
const TERMINAL_GAP_MS = 60_000;

interface Waiting {
	resolve: (d: InteractionResult | null) => void;
	timer: NodeJS.Timeout;
	check: LocalAnswerCheck | null;
	off: () => void;
}

const LABEL: Record<ApprovalDecision, string> = {
	"allow-once": "Allowed once",
	"allow-session": "Allowed for session",
	deny: "Denied",
	answer: "Answered",
};

/** The narrow part of Claude's suggestions: rules and directories, for this session only. */
/** Tools whose "allow for session" may be accept-edits mode. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function sessionGrant(
	suggestions: unknown[],
	tool = "",
): unknown[] | null {
	const out = suggestions.flatMap((s) => {
		const t = (s as { type?: unknown })?.type;
		return (t === "addRules" &&
			(s as { behavior?: unknown }).behavior === "allow") ||
			t === "addDirectories" ||
			// Edits: Claude offers "allow all edits during this session" as
			// accept-edits mode. Only on an edit prompt (a Bash prompt's
			// session grant must not switch on edit mode), and never a wider
			// mode (bypassPermissions).
			(t === "setMode" &&
				EDIT_TOOLS.has(tool) &&
				(s as { mode?: unknown }).mode === "acceptEdits")
			? [{ ...(s as object), destination: "session" }]
			: [];
	});
	return out.length ? out : null;
}

/** "Bash(git init *)", "directory /repo": what a session grant adds. */
export function grantRules(grant: unknown[] | null): string[] | null {
	if (!grant) return null;
	return grant.flatMap((g) => {
		const e = g as {
			type?: string;
			rules?: { toolName?: string; ruleContent?: string }[];
			directories?: string[];
			mode?: string;
		};
		if (e.type === "setMode") return [`all edits (${e.mode})`];
		if (e.type === "addDirectories")
			return (e.directories ?? []).map((d) => `directory ${d}`);
		return (e.rules ?? []).map((r) =>
			r.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r.toolName),
		);
	});
}

function hhmm(at: number) {
	const d = new Date(at);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export class Approvals {
	/**
	 * Prompts of agents on other machines (federation). Their ids are pool
	 * addresses (`<machineId>/<id>`); the home node issues the passkey
	 * challenge, verifies the assertion and decides (relayed ceremony).
	 */
	remote: RemoteApprovals | null = null;
	private waiting = new Map<string, Waiting>();
	private poll: NodeJS.Timeout | null = null;
	private readonly o: Pick<
		ApprovalsOptions,
		"store" | "registry" | "events" | "passkeys" | "probe" | "adapter"
	>;
	private readonly timeoutMs: number;
	private readonly pollMs: number;
	private readonly now: () => number;
	private readonly answerable: () => boolean;
	private checking = false;
	/**
	 * The daemon is stopping: a hook's prompt ends without a decision and the
	 * hook asks the next daemon again (`approval.request` answers `retry`).
	 */
	stopping = false;
	/**
	 * Claude sessions whose hook didn't say its timeout: started before
	 * `pulsar setup` added `--timeout`, so the app has 540 s (doctor).
	 */
	private oldHooks = new Map<string, string>();

	constructor(opts: ApprovalsOptions) {
		this.o = opts;
		this.timeoutMs = opts.timeoutMs ?? APPROVAL_TIMEOUT_MS;
		this.pollMs = opts.pollMs ?? 500;
		this.now = opts.now ?? Date.now;
		this.answerable =
			opts.answerable ??
			(() =>
				// Only this node's own credentials can approve its prompts (the
				// home node verifies every assertion, relayed or not).
				(opts.appServed?.() ?? true) && this.o.passkeys.any());
	}

	/** Whether anyone could answer from the app now (else prompts stay local). */
	canAnswer(): boolean {
		return this.answerable();
	}

	/** Tells every open app tab about a passkey change. */
	notice(kind: SecurityNotice["kind"], message: string) {
		this.o.events.emit("security", {
			kind,
			message,
			node: this.o.registry.machine,
			at: this.now(),
		});
	}

	/** Records a new passkey: audit row and a notice in every tab. */
	passkeyAdded(p: Principal, info: PasskeyInfo) {
		this.audit(p, "passkeys.register", info.id, { label: info.label });
		this.notice(
			"passkey-added",
			`New passkey '${info.label}' added on ${this.o.registry.machine}`,
		);
	}

	/**
	 * Removes a passkey: the user from the app (with a passkey session), or
	 * anyone on this machine with a presence check that passed for it.
	 */
	removePasskey(p: Principal, id: string, confirmed?: Confirmed): boolean {
		try {
			authorize(p, "passkeys.remove");
			if (p.kind !== "human" && !spendConfirmed(confirmed, "passkeys.remove"))
				throw new RpcError(
					"forbidden",
					"removing a passkey needs you to confirm it (Touch ID or the app)",
				);
		} catch (e) {
			this.audit(p, "passkeys.remove", id, { refused: "principal" }, false);
			throw e;
		}
		const label = this.o.passkeys.list().find((k) => k.id === id)?.label;
		const removed = this.o.passkeys.remove(id);
		this.audit(p, "passkeys.remove", id, { removed, label }, removed);
		if (removed)
			this.notice(
				"passkey-removed",
				`Passkey '${label ?? id.slice(0, 8)}' removed on ${this.o.registry.machine}`,
			);
		return removed;
	}

	/** `GET /passkeys`, `pulsar passkeys`. */
	listPasskeys(p: Principal): PasskeyInfo[] {
		authorize(p, "passkeys.list");
		return this.o.passkeys.list();
	}

	/**
	 * Prompts from before a restart have no hook waiting any more. Runs from
	 * `PulsarService.start`, once this daemon owns the socket: a second
	 * process that lost the race must not touch the live daemon's prompts.
	 */
	expireStale() {
		const stale = (
			this.o.store.db
				.prepare("SELECT id FROM approvals WHERE state = 'pending'")
				.all() as Row[]
		)
			.map((r) => String(r.id))
			.filter((id) => !this.waiting.has(id));
		const expire = this.o.store.db.prepare(
			"UPDATE approvals SET state = 'expired', answered_by = 'restart', decided_at = ? WHERE id = ? AND state = 'pending'",
		);
		for (const id of stale) expire.run(this.now(), id);
	}

	get passkeys(): Passkeys {
		return this.o.passkeys;
	}

	stop() {
		this.stopping = true;
		for (const id of [...this.waiting.keys()])
			this.finish(id, "expired", { answeredBy: "stopped" }, null);
		if (this.poll) clearInterval(this.poll);
		this.poll = null;
	}

	/** Writes an audit row. */
	audit(
		principal: Principal,
		op: string,
		target: string | null,
		detail: unknown,
		ok = true,
	) {
		this.o.store.audit({
			at: this.now(),
			principal: principalLabel(principal),
			op,
			target,
			detail: detail === undefined ? null : JSON.stringify(detail),
			ok,
		});
	}

	/**
	 * `approval.request` from a hook: stores the prompt and resolves with the
	 * decision, or null when the local prompt should decide (timeout, answered
	 * there, daemon stopping). Interactive tools (the driver's `interactions`)
	 * are stored with their kind and typed prompt, and the app's answer goes
	 * back as the hook decision the driver builds.
	 */
	request(caller: Caller, req: ApprovalRequest): Promise<HookDecision | null> {
		const agent = this.caller(caller, "approval.request");
		if (req.hookTimeoutS) this.oldHooks.delete(req.sessionId);
		else {
			this.oldHooks.delete(req.sessionId);
			this.oldHooks.set(req.sessionId, agent.id);
			// Bounded: the oldest session goes first.
			if (this.oldHooks.size > 500)
				this.oldHooks.delete(this.oldHooks.keys().next().value!);
		}
		// Nobody could answer from the app: let the terminal prompt decide at once.
		if (!this.answerable()) return Promise.resolve(null);
		const adapter = this.o.adapter?.(agent) ?? null;
		let prompt: InteractionPrompt | null = null;
		try {
			prompt = adapter?.classify(req.tool, req.input) ?? null;
		} catch {}
		const inputHash = sha256hex(canonicalJson(req.input));
		const grant = prompt ? null : sessionGrant(req.suggestions, req.tool);
		const timeoutMs =
			(req.hookTimeoutS
				? approvalDeadlineMs(req.hookTimeoutS, this.timeoutMs)
				: prompt
					? INTERACTION_TIMEOUT_MS
					: this.timeoutMs) - Math.max(0, req.elapsedMs ?? 0);
		// Asked again after a restart with too little time left to answer.
		if (req.elapsedMs && timeoutMs < MIN_LEFT_MS) return Promise.resolve(null);
		return this.open(caller, agent, {
			id: this.newId(req.promptId, inputHash),
			kind: prompt?.kind ?? "permission",
			tool: req.tool,
			input: req.input,
			prompt,
			sessionId: req.sessionId,
			promptId: req.promptId,
			cwd: req.cwd,
			grant,
			sessionRules: null,
			source: "hook",
			timeoutMs,
			transcriptPath: req.transcriptPath,
		}).then((r) => {
			if (!r) return null;
			if (r.decision === "answer" && r.answer && prompt && adapter)
				return adapter.decide(prompt, req.input, r.answer);
			if (r.decision === "deny")
				return {
					behavior: "deny",
					message: r.note
						? `Denied from the Pulsar app: ${r.note}`
						: "Denied from the Pulsar app",
				};
			return r.decision === "allow-session" && grant
				? { behavior: "allow", updatedPermissions: grant }
				: { behavior: "allow" };
		});
	}

	/**
	 * `interaction.ask` from the pi/omp extension: resolves with the app's
	 * answer, or null when the local dialog should decide (it answered
	 * first, the daemon gave up, or nobody could answer from the app).
	 */
	ask(
		caller: Caller,
		req: InteractionRequest,
	): Promise<InteractionResult | null> {
		const agent = this.caller(caller, "interaction.ask");
		if (!this.answerable()) return Promise.resolve(null);
		// The passkey signs this hash: it must cover what the card shows (the
		// question, the plan), not only the (empty) tool input.
		const inputHash = sha256hex(
			canonicalJson(
				req.kind === "permission"
					? req.input
					: { input: req.input, prompt: req.prompt },
			),
		);
		return this.open(caller, agent, {
			id: this.extensionId(agent.id, req.ref),
			kind: req.kind,
			tool: req.tool,
			input: req.input,
			prompt: req.kind === "permission" ? null : req.prompt,
			sessionId: agent.sessionId,
			promptId: null,
			cwd: agent.cwd,
			grant: null,
			sessionRules: req.kind === "permission" ? req.sessionRules : null,
			source: req.readOnly ? "readonly" : "extension",
			// No limit of its own (the local dialog waits): a day.
			timeoutMs: Math.min(req.timeoutMs ?? MAX_ASK_MS, MAX_ASK_MS),
			transcriptPath: null,
			inputHash,
		});
	}

	/** `interaction.local {ref}`: the extension's local dialog answered first. */
	answeredLocally(caller: Caller, ref: string): boolean {
		const agent = this.caller(caller, "interaction.ask");
		return this.finish(
			this.extensionId(agent.id, ref),
			"answered-locally",
			{ answeredBy: "local" },
			null,
		);
	}

	/**
	 * A presence check's card (src/service/presence.ts): "confirm" with the
	 * exact action, on the requesting agent (or the operator, for a terminal).
	 * Only the daemon opens one, never a socket op: an agent's own
	 * `interaction.ask` confirm can't stand in for it, because the daemon acts
	 * only on the promise this returns. The passkey signs the hash of the
	 * action and the card text. Ends like any card: a passkey-signed answer in
	 * the app, the native prompt (`endPresence`), the caller going away, or the
	 * timeout.
	 */
	presenceCard(
		caller: Caller,
		agent: Agent,
		card: {
			title: string;
			message: string;
			input: Record<string, unknown>;
			timeoutMs: number;
		},
	): { id: string; result: Promise<InteractionResult | null> } {
		const prompt: InteractionPrompt = {
			kind: "confirm",
			title: card.title,
			message: card.message,
		};
		const id = `presence.${randomUUID()}`;
		const result = this.open(caller, agent, {
			id,
			kind: "confirm",
			tool: "Pulsar",
			input: card.input,
			prompt,
			sessionId: agent.sessionId,
			promptId: null,
			cwd: agent.cwd,
			grant: null,
			sessionRules: null,
			source: "presence",
			timeoutMs: card.timeoutMs,
			transcriptPath: null,
			inputHash: sha256hex(canonicalJson({ input: card.input, prompt })),
		});
		return { id, result };
	}

	/**
	 * The native prompt answered a presence card first (compare-and-set with
	 * the app). False when the app (or the timeout) ended it already.
	 */
	endPresence(id: string, confirmed: boolean, method: string): boolean {
		if (this.row(id)?.source !== "presence") return false;
		const answer: InteractionAnswer = { kind: "confirm", confirmed };
		return this.finish(
			id,
			confirmed ? "allowed" : "denied",
			{
				answeredBy: "native",
				decision: "answer",
				answer,
				by: "you",
				signer: {
					credentialId: "",
					device: this.o.registry.machine,
					method,
				},
			},
			{ decision: "answer", answer, note: null },
		);
	}

	/** How a card was decided ("passkey session", "Touch ID", …); null if not by the app or native. */
	decidedMethod(id: string): string | null {
		return (this.row(id)?.decided_method as string | null) ?? null;
	}

	/** Takes a presence card down once the check is over (no-op if it ended). */
	cancelPresence(id: string) {
		if (this.row(id)?.source !== "presence") return;
		this.finish(id, "expired", { answeredBy: "cancelled" }, null);
	}

	/** The registered agent behind a hook or extension call. */
	private caller(caller: Caller, op: string): Agent {
		authorize(caller.principal, "approval.request");
		if (caller.principal.kind !== "agent")
			throw new RpcError("forbidden", `only a harness asks (${op})`);
		const agent = this.o.registry.get(caller.principal.agentId);
		if (!agent) throw new RpcError("not_registered", "unknown agent");
		return agent;
	}

	/**
	 * The ref a relayed server prompt asks under: its own, else with a `-N`
	 * suffix once an earlier interaction under it has ended (expired by a
	 * restart, or answered in the app but the reply failed), so the prompt
	 * can be shown again. A ref still pending keeps its id, and `ask` refuses
	 * it: there are never two live cards for one prompt.
	 */
	relayRef(agentId: string, ref: string): string {
		const base = ref.replace(/[^\w-]/g, "").slice(0, 56);
		for (let n = 1; ; n++) {
			const candidate = n === 1 ? ref : `${base}-${n}`;
			const id = this.extensionId(agentId, candidate);
			if (this.waiting.has(id)) return candidate;
			const row = this.row(id);
			if (!row || row.state === "pending") return candidate;
		}
	}

	/** An extension interaction's id: the agent's, plus the extension's own ref. */
	private extensionId(agentId: string, ref: string): string {
		return `${agentId}.x.${ref.replace(/[^\w-]/g, "").slice(0, 64)}`;
	}

	/** Stores a prompt, tells the app, and waits for the first answer. */
	private open(
		caller: Caller,
		agent: Agent,
		rec: {
			id: string;
			kind: InteractionKind;
			tool: string;
			input: Record<string, unknown>;
			prompt: InteractionPrompt | null;
			sessionId: string | null;
			promptId: string | null;
			cwd: string | null;
			grant: unknown[] | null;
			sessionRules: string[] | null;
			source: "hook" | "extension" | "readonly" | "presence";
			timeoutMs: number;
			transcriptPath: string | null;
			inputHash?: string;
		},
	): Promise<InteractionResult | null> {
		const now = this.now();
		const inputHash = rec.inputHash ?? sha256hex(canonicalJson(rec.input));
		const id = rec.id;
		if (this.waiting.has(id) || this.row(id))
			throw new RpcError("bad_request", "this interaction was already asked");
		const expiresAt = now + rec.timeoutMs;
		// A session grant is stored as Claude's rules; an extension's rules as labels.
		const grantJson = rec.grant
			? JSON.stringify(rec.grant)
			: rec.sessionRules?.length
				? JSON.stringify({ labels: rec.sessionRules })
				: null;
		this.o.store.db
			.prepare(
				`INSERT INTO approvals (id, agent_id, tool, input, input_hash, state, created_at, expires_at,
				   harness, session_id, prompt_id, cwd, branch, session_grant, kind, prompt, source)
				 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				agent.id,
				rec.tool,
				JSON.stringify(rec.input),
				inputHash,
				now,
				expiresAt,
				agent.harness,
				rec.sessionId,
				rec.promptId,
				rec.cwd ?? agent.cwd,
				agent.branch,
				grantJson,
				rec.kind,
				rec.prompt ? JSON.stringify(rec.prompt) : null,
				rec.source,
			);
		this.audit(
			caller.principal,
			`${rec.source === "hook" ? "approval" : rec.source === "presence" ? "presence" : "interaction"}.request`,
			id,
			{
				tool: rec.tool,
				kind: rec.kind,
				inputHash,
				...(rec.source === "readonly" ? { readOnly: true } : {}),
			},
		);
		return new Promise<InteractionResult | null>((resolve) => {
			const timer = setTimeout(
				() => this.finish(id, "expired", { answeredBy: "timeout" }, null),
				rec.timeoutMs,
			);
			timer.unref();
			// The harness killed the hook (Escape or "No" in the terminal), or
			// the extension's connection went away.
			// A presence check's caller going away (Ctrl-C) just ends it.
			const onClose = () =>
				rec.source === "presence"
					? this.finish(id, "expired", { answeredBy: "cancelled" }, null)
					: this.finish(id, "answered-locally", { answeredBy: "local" }, null);
			caller.closed.addEventListener("abort", onClose, { once: true });
			let check: LocalAnswerCheck | null = null;
			if (rec.source === "hook")
				try {
					check =
						this.o.probe?.(agent, {
							tool: rec.tool,
							input: rec.input,
							createdAt: now,
							transcriptPath: rec.transcriptPath,
						}) ?? null;
				} catch {}
			this.waiting.set(id, {
				resolve,
				timer,
				check,
				off: () => caller.closed.removeEventListener("abort", onClose),
			});
			this.ensurePolling();
			this.refreshNeeds(agent.id);
			this.emit(id);
			if (caller.closed.aborted) onClose();
		});
	}

	/** Ids are per prompt: `prompt_id` names the user's turn, not the call. */
	private newId(promptId: string | null, inputHash: string): string {
		const base = promptId
			? `${promptId}.${inputHash.slice(0, 8)}`
			: randomUUID();
		const exists = this.o.store.db.prepare(
			"SELECT 1 FROM approvals WHERE id = ?",
		);
		if (!exists.get(base)) return base;
		for (let n = 2; ; n++) {
			const id = `${base}.${n}`;
			if (!exists.get(id)) return id;
		}
	}

	private ensurePolling() {
		if (this.poll || this.waiting.size === 0) return;
		this.poll = setInterval(() => void this.checkLocal(), this.pollMs);
		this.poll.unref();
	}

	/** Asks each pending prompt's probe whether the terminal answered it. */
	async checkLocal() {
		// One round at a time: a slow disk must not stack rounds up.
		if (this.checking) return;
		this.checking = true;
		try {
			for (const [id, w] of [...this.waiting]) {
				let answered = false;
				try {
					answered = (await w.check?.()) ?? false;
				} catch {}
				if (answered && this.waiting.has(id))
					this.finish(id, "answered-locally", { answeredBy: "local" }, null);
			}
		} finally {
			this.checking = false;
		}
		if (this.waiting.size === 0 && this.poll) {
			clearInterval(this.poll);
			this.poll = null;
		}
	}

	/**
	 * Ends a pending prompt once (compare-and-set). Releases the hook with
	 * `hook`, updates needs-you and tells the app. False when it had already
	 * ended.
	 */
	private finish(
		id: string,
		state: Exclude<ApprovalState, "pending">,
		f: {
			answeredBy: string;
			decision?: ApprovalDecision;
			note?: string | null;
			answer?: InteractionAnswer | null;
			by?: string;
			signer?: Signer;
		},
		result: InteractionResult | null,
	): boolean {
		const r = this.o.store.db
			.prepare(
				`UPDATE approvals SET state = ?, answered_by = ?, decision = ?, note = ?, answer = ?, decided_by = ?,
				   decided_device = ?, decided_method = ?, decided_at = ?
				 WHERE id = ? AND state = 'pending'`,
			)
			.run(
				state,
				f.answeredBy,
				f.decision ?? null,
				f.note ?? null,
				f.answer ? JSON.stringify(f.answer) : null,
				f.by ?? null,
				f.signer?.device ?? null,
				f.signer?.method ?? null,
				this.now(),
				id,
			);
		const w = this.waiting.get(id);
		this.waiting.delete(id);
		if (w) {
			clearTimeout(w.timer);
			w.off();
			w.resolve(result);
		}
		if (Number(r.changes) === 0) return false;
		const row = this.row(id);
		if (row) {
			this.refreshNeeds(String(row.agent_id));
			if (f.answeredBy !== "app")
				this.o.store.audit({
					at: this.now(),
					principal: `agent:${row.agent_id}`,
					op: `approval.${state}`,
					target: id,
					detail: JSON.stringify({ answeredBy: f.answeredBy }),
					ok: true,
				});
		}
		this.emit(id);
		return true;
	}

	/** Needs-you follows the agent's oldest pending prompt. */
	private refreshNeeds(agentId: string) {
		const next = this.pendingFor(agentId)[0];
		const current = this.o.registry.needsYou(agentId);
		if (!next) {
			if (current?.reason === "approval")
				this.o.registry.setNeedsYou(agentId, null);
			return;
		}
		const detail = needsDetail(
			next.kind ?? "permission",
			next.tool,
			next.prompt ?? null,
		);
		if (current?.reason === "approval" && current.detail === detail) return;
		this.o.registry.setNeedsYou(agentId, { reason: "approval", detail });
	}

	private emit(id: string) {
		const approval = this.get(id);
		if (approval) this.o.events.emit("approval", { approval });
	}

	private row(id: string): Row | null {
		return (
			(this.o.store.db
				.prepare("SELECT * FROM approvals WHERE id = ?")
				.get(id) as Row | undefined) ?? null
		);
	}

	private toWire(r: Row): Approval {
		let input: Record<string, unknown> = {};
		try {
			input = JSON.parse(String(r.input));
		} catch {}
		let grant: unknown = null;
		try {
			grant = r.session_grant ? JSON.parse(String(r.session_grant)) : null;
		} catch {}
		const kind = (r.kind as InteractionKind | null) ?? "permission";
		let prompt: InteractionPrompt | null = null;
		let answer: InteractionAnswer | null = null;
		try {
			prompt = r.prompt ? cleanPrompt(JSON.parse(String(r.prompt))) : null;
			answer = r.answer ? JSON.parse(String(r.answer)) : null;
		} catch {}
		const state = r.state as ApprovalState;
		const agent = this.o.registry.get(String(r.agent_id));
		const machine = agent?.machine ?? this.o.registry.machine;
		const a: Approval = {
			requestId: String(r.id),
			kind,
			...(r.source === "readonly" ? { readOnly: true as const } : {}),
			...(prompt ? { prompt } : {}),
			...(answer ? { answer } : {}),
			agentId: String(r.agent_id),
			machine,
			tool: String(r.tool),
			input,
			inputHash: String(r.input_hash),
			cwd: (r.cwd as string | null) ?? null,
			branch: (r.branch as string | null) ?? null,
			createdAt: Number(r.created_at),
			expiresAt: Number(r.expires_at),
			state,
			sessionRules: storedRules(grant),
		};
		const at = Number(r.decided_at ?? 0);
		if (state === "allowed" || state === "denied") {
			const d = r.decision as ApprovalDecision;
			const who = (r.decided_by as string | null) || "you";
			const method = r.decided_method ? ` · ${r.decided_method}` : "";
			const device = r.decided_device ? ` on ${r.decided_device}` : "";
			const what =
				d === "answer" && answer
					? answerLabel(answer, prompt)
					: (LABEL[d] ?? "Decided");
			a.outcome = `${what} by ${who}${method}${device} · ${hhmm(at)}`;
		} else if (state === "answered-locally")
			a.outcome = `Answered on ${machine} · ${hhmm(at)}`;
		else if (state === "expired" && r.source === "presence")
			a.outcome =
				r.answered_by === "timeout"
					? "Expired: nobody confirmed in time"
					: `Closed: the request ended · ${hhmm(at)}`;
		else if (
			state === "expired" &&
			(r.answered_by === "stopped" || r.answered_by === "restart")
		)
			a.outcome = `Closed: Pulsar restarted · ${hhmm(at)}`;
		else if (state === "expired")
			a.outcome =
				kind === "permission"
					? "Expired: the agent's own prompt decides"
					: "Expired: answer on the agent's own screen";
		return a;
	}

	get(id: string): Approval | null {
		const r = this.row(id);
		if (r) return this.toWire(r);
		if (isAddress(id) && this.remote) return this.remote.approval(id);
		return null;
	}

	/** An agent's pending prompts, and those decided in the last `recentMs` (federation). */
	recentFor(agentId: string, recentMs: number): Approval[] {
		const since = this.now() - recentMs;
		return (
			this.o.store.db
				.prepare(
					`SELECT id FROM approvals WHERE agent_id = ? AND (state = 'pending' OR decided_at >= ?)
					 ORDER BY created_at, rowid`,
				)
				.all(agentId, since) as Row[]
		).flatMap((r) => {
			const a = this.get(String(r.id));
			return a ? [a] : [];
		});
	}

	/**
	 * The relayed prompt a terminal wait (needs-you `terminal` since `since`)
	 * is left over from: the session's newest hook prompt, ended by the app's
	 * timeout just before the wait began. Anything else (answered, a newer
	 * prompt, a wait that began long after) is null: a card must never show
	 * a command other than the one on the terminal.
	 */
	expiredBefore(agent: Agent, since: number): Approval | null {
		// The hook may have asked under another id of the same process (a
		// session it switched from): its session, or a sibling by pid.
		const ids = [
			agent.id,
			...(agent.pid
				? this.o.registry
						.live()
						.filter((a) => a.pid === agent.pid && a.id !== agent.id)
						.map((a) => a.id)
				: []),
		].slice(0, 20);
		const r = this.o.store.db
			.prepare(
				`SELECT * FROM approvals WHERE source = 'hook'
				   AND (agent_id IN (${ids.map(() => "?").join(", ")}) OR (? IS NOT NULL AND session_id = ?))
				 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
			)
			.get(...ids, agent.sessionId, agent.sessionId) as Row | undefined;
		if (r?.state !== "expired" || r.answered_by !== "timeout") return null;
		const gap = since - Number(r.decided_at ?? 0);
		return gap >= -5_000 && gap <= TERMINAL_GAP_MS ? this.toWire(r) : null;
	}

	/** Live sessions whose hook predates `--timeout` (seen on their last prompt). */
	oldHookSessions(): { name: string; pid: number | null }[] {
		const out: { name: string; pid: number | null }[] = [];
		for (const [session, agentId] of this.oldHooks) {
			const live = this.o.registry
				.live()
				.find((a) => a.sessionId === session || a.id === agentId);
			if (!live) this.oldHooks.delete(session);
			else out.push({ name: live.name, pid: live.pid ?? null });
		}
		return out;
	}

	/** The agent's oldest pending prompt, here or (for a pool address) on its home node. */
	current(agentId: string): Approval | null {
		return this.pendingFor(agentId)[0] ?? null;
	}

	/** An agent's pending prompts, oldest first. */
	pendingFor(agentId: string): Approval[] {
		if (isAddress(agentId)) return this.remote?.pendingFor(agentId) ?? [];
		return (
			this.o.store.db
				.prepare(
					"SELECT * FROM approvals WHERE agent_id = ? AND state = 'pending' ORDER BY created_at, rowid",
				)
				.all(agentId) as Row[]
		).map((r) => this.toWire(r));
	}

	/** What a signature for `decision` on this prompt (with its deny note) must cover. */
	binding(
		a: Approval,
		decision: ApprovalDecision,
		note: string | null = null,
		answer: InteractionAnswer | null = null,
	): ApprovalBinding {
		return {
			requestId: a.requestId,
			inputHash: a.inputHash,
			agentId: a.agentId,
			decision,
			// The rules the card showed: any node computes this from the wire shape.
			grantHash:
				decision === "allow-session" && a.sessionRules
					? sha256hex(canonicalJson(a.sessionRules))
					: "",
			// An interaction's answer is signed in the note's place.
			noteHash:
				decision === "answer" && answer
					? answerHash(answer)
					: decision === "deny" && note
						? sha256hex(note)
						: "",
			expiresAt: a.expiresAt,
		};
	}

	private pendingOrThrow(id: string, decision: ApprovalDecision): Approval {
		const a = this.get(id);
		if (!a) throw new RpcError("not_found", "no such approval");
		if (a.state !== "pending")
			throw new RpcError("decided", a.outcome ?? "already decided", {
				approval: a,
			});
		if (a.readOnly)
			throw new RpcError(
				"bad_request",
				`answer this on ${a.machine}'s screen: ${a.tool} can't be answered from the app`,
			);
		const permission = (a.kind ?? "permission") === "permission";
		if (permission === (decision === "answer"))
			throw new RpcError(
				"bad_request",
				permission
					? "a permission prompt takes allow-once, allow-session or deny"
					: `this ${a.kind} takes decision "answer" with an answer`,
			);
		if (decision === "allow-session" && !a.sessionRules)
			throw new RpcError(
				"bad_request",
				"this prompt can't be allowed for the session; allow once instead",
			);
		return a;
	}

	/**
	 * `POST /approvals/:id/options`: passkey request options for this answer,
	 * or `register` when the pool has no passkey yet.
	 */
	async options(
		p: Principal,
		rp: RelyingParty,
		id: string,
		decision: ApprovalDecision,
		opts: {
			note?: string | null;
			answer?: unknown;
			requester?: string;
		} = {},
	) {
		authorize(p, "approve");
		const login = (p as { login: string }).login;
		const note = cleanNote(opts.note);
		const remote = isAddress(id) && !this.row(id) ? this.remote : null;
		const a = this.pendingOrThrow(id, decision);
		const answer = this.answerFor(a, decision, opts.answer);
		// Another machine's prompt: its home node issues the challenge, over
		// its own credentials, for this node's exact origin.
		if (remote) return remote.options(p, id, decision, note, answer);
		if (!this.o.passkeys.has(login, rp)) return { register: true as const };
		return {
			options: await this.o.passkeys.assertionOptions(
				login,
				rp,
				this.binding(a, decision, note, answer),
				opts.requester ?? requesterOf(p),
			),
		};
	}

	/** The checked answer for `decision: "answer"`, else null. Throws `bad_request`. */
	private answerFor(
		a: Approval,
		decision: ApprovalDecision,
		raw: unknown,
	): InteractionAnswer | null {
		if (decision !== "answer") return null;
		if (!a.prompt)
			throw new RpcError("bad_request", "this prompt can't take an answer");
		return cleanAnswer(raw, a.prompt);
	}

	/**
	 * Checks a passkey assertion for `decision` on prompt `id`. The home node
	 * runs this itself for a decision a peer forwards (federation).
	 */
	async verifyDecision(
		login: string,
		rp: RelyingParty,
		id: string,
		decision: ApprovalDecision,
		assertion: unknown,
		note: string | null = null,
		rawAnswer: unknown = undefined,
	): Promise<Signer> {
		const a = this.pendingOrThrow(id, decision);
		const answer = this.answerFor(a, decision, rawAnswer);
		return this.o.passkeys.verifyAssertion(
			login,
			rp,
			this.binding(a, decision, cleanNote(note), answer),
			assertion,
		);
	}

	/**
	 * A decision on a prompt on this machine that carries the request's
	 * passkey session in place of a per-answer signature. The session proved
	 * the operator (user verification) and is bound to the browser's node;
	 * the card's input hash (and listed rules) must match the prompt exactly,
	 * so the answer applies only to what the card showed.
	 */
	private verifySessionDecision(
		id: string,
		body: {
			decision: ApprovalDecision;
			session?: UserSessionInfo | null;
			inputHash?: unknown;
			sessionRules?: unknown;
		},
	): Signer {
		const s = body.session;
		if (!s)
			throw new RpcError(
				"session_required",
				"answering needs a passkey session or a passkey signature",
			);
		const a = this.pendingOrThrow(id, body.decision);
		if (typeof body.inputHash !== "string" || body.inputHash !== a.inputHash)
			throw new RpcError(
				"bad_assertion",
				"the prompt's input differs from the card that was answered",
			);
		if (
			body.decision === "allow-session" &&
			canonicalJson(body.sessionRules ?? null) !==
				canonicalJson(a.sessionRules ?? null)
		)
			throw new RpcError(
				"bad_assertion",
				"the rules differ from the ones the card listed",
			);
		return {
			credentialId: `session:${s.id}`,
			device: s.device,
			method: "passkey session",
		};
	}

	/**
	 * `POST /approvals/:id/decide`: only the user, and only with either a
	 * valid passkey assertion over this prompt and answer, or (a prompt on
	 * this machine, from the app's HTTP route) a live passkey session on the
	 * request plus the input hash, and for "allow-session" the rules, of the
	 * card the operator answered. First answer wins; a later one gets
	 * `won: false` and the outcome. A forwarded decision (federation) never
	 * passes `session`: another machine's word is never a session here.
	 */
	async decide(
		p: Principal,
		rp: RelyingParty,
		id: string,
		body: {
			decision: ApprovalDecision;
			note?: string;
			answer?: unknown;
			assertion?: unknown;
			session?: UserSessionInfo | null;
			inputHash?: unknown;
			sessionRules?: unknown;
		},
	): Promise<DecideResponse> {
		try {
			authorize(p, "approve");
		} catch (e) {
			this.audit(p, "approval.decide", id, { refused: "principal" }, false);
			throw e;
		}
		const login = (p as { login: string }).login;
		const before = this.get(id);
		if (!before) throw new RpcError("not_found", "no such approval");
		if (before.state !== "pending") return { won: false, approval: before };
		const remote = isAddress(id) && !this.row(id) ? this.remote : null;
		const note = cleanNote(body.note);
		if (remote) {
			// This machine's session says nothing on the prompt's home machine.
			if (body.assertion === undefined)
				throw new RpcError(
					"bad_assertion",
					"a prompt on another machine needs that machine's passkey signature",
				);
			const a = this.pendingOrThrow(id, body.decision);
			const answer = this.answerFor(a, body.decision, body.answer);
			// The browser signed the home node's challenge: the assertion goes
			// there untouched, and the home node verifies and decides.
			const r = await remote.decide(
				p,
				id,
				body.decision,
				note,
				body.assertion,
				answer,
			);
			this.audit(p, "approval.forward", id, {
				decision: body.decision,
				won: r.won,
			});
			return r;
		}
		let signer: Signer;
		try {
			signer =
				body.assertion === undefined
					? this.verifySessionDecision(id, body)
					: await this.verifyDecision(
							login,
							rp,
							id,
							body.decision,
							body.assertion,
							note,
							body.answer,
						);
		} catch (e) {
			if (e instanceof RpcError && e.code === "decided")
				return { won: false, approval: this.get(id)! };
			this.audit(
				p,
				"approval.decide",
				id,
				{ decision: body.decision, error: (e as Error).message },
				false,
			);
			throw e;
		}
		const answer =
			body.decision === "answer" && before.prompt
				? cleanAnswer(body.answer, before.prompt)
				: null;
		return this.settle(p, login, id, body.decision, note, answer, signer);
	}

	/** Ends a pending prompt with a verified app decision (first answer wins). */
	private settle(
		p: Principal,
		login: string,
		id: string,
		decision: ApprovalDecision,
		note: string | null,
		answer: InteractionAnswer | null,
		signer: Signer,
	): DecideResponse {
		const prompt = this.get(id)?.prompt ?? null;
		const allowed =
			decision === "answer"
				? answer !== null && answerApproves(answer, prompt)
				: decision !== "deny";
		const won = this.finish(
			id,
			allowed ? "allowed" : "denied",
			{
				answeredBy: "app",
				decision,
				note,
				// Stored and shown without secret fields; the agent gets the real one.
				answer: answer ? redactAnswer(answer, prompt) : null,
				// The operator's name from Tailscale, shown in the outcome.
				by: operatorName(p.kind === "human" ? p.name : null, login),
				signer,
			},
			{ decision, answer, note },
		);
		this.audit(p, "approval.decide", id, {
			decision,
			won,
			...(answer ? { answerHash: answerHash(answer) } : {}),
			device: signer.device,
			credential: signer.credentialId,
		});
		return { won, approval: this.get(id)! };
	}
}

/** The rules a stored session grant shows: Claude's rules, or an extension's labels. */
function storedRules(grant: unknown): string[] | null {
	if (Array.isArray(grant)) return grantRules(grant);
	const labels = (grant as { labels?: unknown } | null)?.labels;
	return Array.isArray(labels) ? labels.map(String) : null;
}

/** A deny note as it is signed and delivered: at most 2000 characters, none when empty. */
function cleanNote(note: string | null | undefined): string | null {
	return note?.slice(0, 2000) || null;
}
