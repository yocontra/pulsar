/**
 * Mock queue strip (src/service/queue.ts): per-agent messages not yet in
 * the conversation. A send to an agent that won't take it now (inbox only,
 * held, machine offline, don't wake) lands here; `/__mock/queue` seeds
 * items (another agent's message, a turn in progress) or clears them.
 */
import type {
	Priority,
	QueueItem,
	QueueList,
	QueueState,
	Receipt,
	Wake,
} from "../../src/http/wire.ts";

export class QueueMockError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const queues = new Map<string, QueueItem[]>();

const WHY_HANDED =
	"It's with the session already and lands when the current turn ends. Stop the turn to have it land now.";

/** The queue state a send leaves a message in, or null when it goes straight in. */
export function stateForWake(
	wake: Wake,
	priority: Priority,
): QueueState | null {
	if (wake === "held") return "held";
	if (wake === "queued") return "offline";
	if (wake === "inbox-only" || priority === "fyi") return "next-turn";
	return null;
}

export interface SeedItem {
	messageId?: string;
	from?: { id: string; name: string };
	mine?: boolean;
	body: string;
	state: QueueState;
	priority?: Priority;
	createdAt?: number;
}

let n = 0;

/** Adds one message to an agent's queue. */
export function enqueue(agentId: string, seed: SeedItem): QueueItem {
	const mine = seed.mine ?? true;
	const handed = seed.state === "idle";
	const offline = seed.state === "offline";
	const noPush = seed.state === "next-turn" && seed.priority !== "fyi";
	const item: QueueItem = {
		messageId: seed.messageId ?? `mq_${Date.now().toString(36)}_${n++}`,
		agentId,
		from: seed.from ?? { id: "user:me@example.com", name: "You" },
		mine,
		body: seed.body,
		priority: seed.priority ?? "normal",
		createdAt: seed.createdAt ?? Date.now(),
		state: seed.state,
		detail: null,
		attempt: seed.state === "retrying" ? 2 : 1,
		dueAt: null,
		where: offline ? "outbox" : "home",
		canWithdraw: !handed,
		canPromote: !handed && !offline && !noPush,
		canEdit: mine && !handed,
		why: {
			...(handed ? { withdraw: WHY_HANDED } : {}),
			...(handed
				? { promote: WHY_HANDED }
				: offline
					? {
							promote:
								"Its machine is offline; it goes when the machine is back",
						}
					: noPush
						? {
								promote:
									"This agent can't take it now; it reads its inbox at its next turn",
							}
						: {}),
			...(!mine
				? { edit: "Only your own messages can be edited" }
				: handed
					? { edit: WHY_HANDED }
					: {}),
		},
	};
	const list = queues.get(agentId) ?? [];
	list.push(item);
	queues.set(agentId, list);
	return item;
}

export function queueList(agentId: string): QueueList {
	return { agentId, items: [...(queues.get(agentId) ?? [])] };
}

/** Clears every queue (`/__mock/queue {reset: true}`), or one agent's. */
export function queueReset(agentId?: string) {
	if (agentId) queues.delete(agentId);
	else queues.clear();
}

/**
 * Withdraw / send now / edit, with the daemon's rules. `checkOthers` runs
 * the Prove Human check for someone else's message (requireActing).
 */
export async function queueAct(
	agentId: string,
	messageId: string,
	action: "withdraw" | "promote" | "edit",
	body: unknown,
	checkOthers: () => Promise<void>,
): Promise<{ ok: true; receipt: Receipt | null }> {
	const list = queues.get(agentId) ?? [];
	const item = list.find((i) => i.messageId === messageId);
	if (!item)
		throw new QueueMockError(404, "not_found", `no message ${messageId}`);
	if (action === "edit") {
		if (!item.mine)
			throw new QueueMockError(
				403,
				"forbidden",
				"Only your own messages can be edited",
			);
		if (typeof body !== "string" || !body.trim())
			throw new QueueMockError(400, "bad_request", "`body` is empty");
	} else if (!item.mine) await checkOthers();
	const allowed =
		action === "withdraw"
			? item.canWithdraw
			: action === "promote"
				? item.canPromote
				: item.canEdit;
	if (!allowed) {
		const why = item.why[action] ?? "It is no longer waiting";
		throw new QueueMockError(
			action === "promote" && item.state === "offline" ? 503 : 409,
			action === "promote" && item.state === "offline"
				? "unreachable"
				: "conflict",
			why,
		);
	}
	const receipt = (state: Receipt["state"]): Receipt => ({
		messageId,
		agentId,
		agentName: agentId,
		state,
		via: action === "withdraw" ? "operator" : "extension",
		detail: action === "withdraw" ? "withdrawn by me@example.com" : null,
		updatedAt: Date.now(),
	});
	if (action === "edit") {
		item.body = (body as string).trim();
		return { ok: true, receipt: receipt("queued") };
	}
	queues.set(
		agentId,
		list.filter((i) => i !== item),
	);
	return {
		ok: true,
		receipt: receipt(action === "withdraw" ? "withdrawn" : "sent"),
	};
}
