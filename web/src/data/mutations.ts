/**
 * Writes. Where the outcome is certain enough, optimistic: the cache is
 * patched at once and restored (or marked failed, with Retry) when the
 * server refuses, the passkey prompt is cancelled, or `send` asks to
 * confirm again (a 409 resolves with `reconfirm`, it does not throw).
 * Where showing the outcome early would mislead (an approval, Stop), the
 * write shows a pending state until the daemon answers.
 */
import { type QueryClient, useMutation } from "@tanstack/react-query";
import { api, hasSessionToken, ProveCancelled } from "../api/client.ts";
import type {
	AgentRow,
	Approval,
	ApprovalDecision,
	DecideResponse,
	InteractionAnswer,
	PasskeyList,
	SendRequest,
	SendResult,
	StopResult,
	TranscriptEvent,
	UserSessionInfo,
} from "../api/types.ts";
import { noteSent } from "../lib/sent.ts";
import { keys } from "./keys.ts";
import { patchAgentRows } from "./live.ts";
import {
	isLocal,
	LOCAL_PREFIX,
	LOCAL_TTL_MS,
	reconcileLocal,
	type TranscriptData,
} from "./patch.ts";
import {
	localBaseline,
	localSend,
	setLocalBaseline,
	setLocalSend,
	setStopping,
} from "./pending.ts";
import { queryClient } from "./runtime.ts";

type Snapshot = [readonly unknown[], unknown][];

/** Remembers cache entries so a failed write can put them back. */
export function snapshot(
	client: QueryClient,
	match: (key: readonly unknown[]) => boolean,
): Snapshot {
	return client
		.getQueryCache()
		.getAll()
		.filter((q) => match(q.queryKey))
		.map((q) => [q.queryKey, q.state.data]);
}

export function restore(client: QueryClient, snap: Snapshot | undefined) {
	for (const [key, data] of snap ?? []) client.setQueryData(key, data);
}

/**
 * A client id for one send (see `SendRequest.clientId`): a retry with the
 * same id is sent once. crypto.getRandomValues works outside secure
 * contexts too (a tailnet `http://` origin).
 */
export function newClientId(now = Date.now()): string {
	const b = new Uint8Array(6);
	crypto.getRandomValues(b);
	const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
	return `c_${now.toString(36)}${hex}`;
}

/** The id of the optimistic line for a send with this client id. */
export const localId = (clientId: string) => `${LOCAL_PREFIX}${clientId}`;

/** A line for the transcript before the daemon echoes it (reconciled in patch.ts). */
export function localLine(
	text: string,
	clientId: string,
	now = Date.now(),
): TranscriptEvent {
	// Where the echo will land: proven, the operator's own turn; unproven,
	// the daemon frames it as the app's (a peer line). The bubble doesn't
	// change sides when the echo replaces it.
	const proven = hasSessionToken();
	return {
		id: localId(clientId),
		ts: now,
		role: proven ? "user" : "peer",
		kind: "text",
		text,
		from: "you",
		pulsar: { sender: proven ? "operator" : "app" },
	};
}

/**
 * Sends to one agent go out in order, one after the other. A send waits at
 * most QUEUE_WAIT_MS for the one before it: a request that hangs (requests
 * have no timeout) doesn't hold every later message.
 */
const queues = new Map<string, Promise<unknown>>();
export const QUEUE_WAIT_MS = 15_000;

function inOrder<T>(agentId: string | undefined, run: () => Promise<T>) {
	if (!agentId) return run();
	const prev = queues.get(agentId) ?? Promise.resolve();
	const waited = Promise.race([
		prev.catch(() => {}),
		new Promise((ok) => setTimeout(ok, QUEUE_WAIT_MS)),
	]);
	const next = waited.then(run);
	queues.set(agentId, next);
	void next
		.catch(() => {})
		.finally(() => {
			if (queues.get(agentId) === next) queues.delete(agentId);
		});
	return next;
}

export interface SendVars {
	req: SendRequest;
	/** The open session: the message shows in its transcript at once. */
	agentId?: string;
}

/**
 * Optimistic send. Every real send carries a client id (the daemon sends a
 * repeated id once, so Retry never sends twice). With `agentId` and that
 * transcript loaded, the message shows at once as a `local:` line whose
 * state (pending.ts) goes sending → sent (accepted; the daemon's message id
 * is stamped on it) → replaced by the echo (patch.ts `reconcileLocal`, by
 * message id, whichever comes first). A failure keeps the line as failed
 * with Retry; a reconfirm or a cancelled Prove Human removes it. No line
 * for a send through a subagent's parent (the echo is a rewritten body) or
 * a transcript the harness doesn't share (no echo would come).
 */
export async function sendWithRollback(
	client: QueryClient,
	vars: SendVars,
	send: (r: SendRequest) => Promise<SendResult> = (r) => api.send(r),
): Promise<SendResult> {
	const req: SendRequest = vars.req.dryRun
		? vars.req
		: { ...vars.req, clientId: vars.req.clientId ?? newClientId() };
	const key = vars.agentId ? keys.transcript(vars.agentId) : null;
	const id = req.clientId && !req.dryRun ? localId(req.clientId) : null;
	const held = key ? client.getQueryData<TranscriptData>(key) : undefined;
	const showLine =
		key !== null &&
		id !== null &&
		!!req.body &&
		!req.viaParent &&
		held !== undefined &&
		held.available !== false;
	const patchLine = (
		fn: (e: TranscriptEvent) => TranscriptEvent | null,
	): void => {
		if (!key || !id) return;
		client.setQueryData<TranscriptData>(key, (d) => {
			if (!d) return d;
			let hit = false;
			const events: TranscriptEvent[] = [];
			for (const e of d.events) {
				if (e.id !== id) {
					events.push(e);
					continue;
				}
				hit = true;
				const n = fn(e);
				if (n) events.push(n);
			}
			return hit ? { ...d, events: reconcileLocal(events) } : d;
		});
	};
	const state = (s: "sending" | "sent" | "failed", error?: string) => {
		if (!showLine || !id) return;
		setLocalSend(id, {
			state: s,
			...(error ? { error } : {}),
			retry: () =>
				void sendWithRollback(client, { ...vars, req }, send).catch(() => {}),
			discard: () => {
				patchLine(() => null);
				setLocalSend(id, null);
			},
		});
	};
	if (showLine && key && id && req.body) {
		const body = req.body;
		// Retry: the failed line goes back to sending where it is.
		state("sending");
		// Lines already shown can't be this send's echo (the same text sent
		// before). A retry keeps the first attempt's: what came since may be
		// its echo (a lost response).
		if (!localBaseline(id))
			setLocalBaseline(
				id,
				new Set(
					(held?.events ?? []).filter((e) => !isLocal(e)).map((e) => e.id),
				),
			);
		client.setQueryData<TranscriptData>(key, (d) =>
			!d || d.events.some((e) => e.id === id)
				? d
				: { ...d, events: [...d.events, localLine(body, req.clientId!)] },
		);
	}
	const drop = () => {
		patchLine(() => null);
		if (id) {
			setLocalSend(id, null);
			setLocalBaseline(id, null);
		}
	};
	try {
		const r = await inOrder(showLine ? vars.agentId : undefined, () =>
			send(req),
		);
		if (r.reconfirm || r.drift) drop();
		// Sent from this tab: its bubble shows the delivery state (lib/sent.ts).
		else if (r.messageId) noteSent(r.messageId);
		if (!(r.reconfirm || r.drift) && showLine && id) {
			const mid = r.messageId;
			state("sent");
			// Stamped, the echo matches by id (also when it came first: the
			// reconcile in patchLine runs now).
			patchLine((e) =>
				mid ? { ...e, pulsar: { ...e.pulsar!, messageId: mid } } : e,
			);
			// The line is gone once the echo or the TTL takes it.
			setTimeout(() => {
				if (localSend(id)?.state === "sent") setLocalSend(id, null);
				setLocalBaseline(id, null);
			}, LOCAL_TTL_MS + 1000);
		}
		return r;
	} catch (e) {
		if (e instanceof ProveCancelled) drop();
		else
			state(
				"failed",
				e instanceof Error && e.message ? e.message : "Couldn't send",
			);
		throw e;
	}
}

/** Send with the app's client (for components outside React Query hooks). */
export const sendMessage = (vars: SendVars) =>
	sendWithRollback(queryClient, vars);

export function useSend() {
	return useMutation({ mutationFn: sendMessage }, queryClient);
}

/**
 * Stop is not optimistic: the agent may have finished the turn already, or
 * the passkey prompt may be cancelled. The row shows "Stopping…"
 * (pending.ts `useStopping`) until the daemon answers; an `interrupted`
 * answer marks it idle everywhere at once, before the stream says so.
 */
export async function stopConfirmed(
	client: QueryClient,
	agent: AgentRow,
	stop: (id: string) => Promise<StopResult> = (id) => api.stop(id),
	now = () => Date.now(),
): Promise<StopResult> {
	setStopping(agent.id, true);
	try {
		const r = await stop(agent.id);
		if (r.result === "interrupted") {
			const cur = client.getQueryData<AgentRow>(keys.agent(agent.id)) ?? agent;
			if (cur.state === "busy" || cur.state === "needs-you")
				patchAgentRows(client, {
					...cur,
					state: "idle",
					stateSince: now(),
					needsYou: null,
				});
		}
		return r;
	} finally {
		setStopping(agent.id, false);
		void client.invalidateQueries({ queryKey: keys.agent(agent.id) });
	}
}

/** Stop with the app's client (for components outside React Query hooks). */
export const stopAgentTurn = (agent: AgentRow) =>
	stopConfirmed(queryClient, agent);

export function useStop() {
	return useMutation({ mutationFn: stopAgentTurn }, queryClient);
}

export interface DecideVars {
	requestId: string;
	decision: ApprovalDecision;
	note?: string;
	/** With `decision: "answer"`: the interaction's answer. */
	answer?: InteractionAnswer;
	/** The card answered: a prompt on this machine goes with the session. */
	card?: Pick<Approval, "inputHash" | "sessionRules">;
	onStep?: (step: "prove" | "sign" | "send") => void;
}

/**
 * Approve, deny or answer with the passkey step (lazy). Not optimistic: the
 * first answer wins (another device or the agent's own terminal may answer
 * first), so the card shows "Allowing…" (its own phase) until the daemon
 * says what happened. The needs-you list is not touched before the stream
 * says the prompt ended: the card shows its outcome from there
 * (store.approvalItem), and removing the item early would unmount it.
 */
export async function decideConfirmed(
	client: QueryClient,
	vars: DecideVars,
	sign?: typeof import("../approval/passkey.ts").signAndDecide,
): Promise<DecideResponse> {
	const signAndDecide =
		sign ?? (await import("../approval/passkey.ts")).signAndDecide;
	try {
		const { requestId, decision, ...opts } = vars;
		const r = await signAndDecide(requestId, decision, opts);
		client.setQueryData(keys.approval(requestId), r.approval);
		return r;
	} finally {
		void client.invalidateQueries({ queryKey: keys.attention() });
	}
}

/** Decide with the app's client. */
export const decide = (
	vars: DecideVars,
	sign?: typeof import("../approval/passkey.ts").signAndDecide,
) => decideConfirmed(queryClient, vars, sign);

export function useDecide() {
	return useMutation(
		{ mutationFn: (vars: DecideVars) => decide(vars) },
		queryClient,
	);
}

/** Revoke a passkey session: it leaves the list at once, back on failure. */
export function useRevokeSession() {
	return useMutation(
		{
			mutationFn: async (id: string) => {
				const snap = snapshot(queryClient, (k) => k[0] === "sessions");
				queryClient.setQueryData<{ sessions: UserSessionInfo[] }>(
					keys.sessions(),
					(d) => d && { sessions: d.sessions.filter((s) => s.id !== id) },
				);
				try {
					return await api.revokeSession(id);
				} catch (e) {
					restore(queryClient, snap);
					throw e;
				} finally {
					void queryClient.invalidateQueries({ queryKey: keys.sessions() });
				}
			},
		},
		queryClient,
	);
}

/** Remove a passkey (with a session): it leaves the list at once, back on failure. */
export function useRemovePasskey() {
	return useMutation(
		{
			mutationFn: async (id: string) => {
				const snap = snapshot(queryClient, (k) => k[0] === "passkeys");
				queryClient.setQueryData<PasskeyList>(
					keys.passkeys(),
					(d) => d && { ...d, items: d.items.filter((p) => p.id !== id) },
				);
				try {
					return await api.removePasskey(id);
				} catch (e) {
					restore(queryClient, snap);
					throw e;
				} finally {
					void queryClient.invalidateQueries({ queryKey: keys.passkeys() });
				}
			},
		},
		queryClient,
	);
}
