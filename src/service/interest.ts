import type { Store } from "../store.ts";

/**
 * Agents the operator cares about now: ones they started from the app,
 * messaged from the app, or opened, in the last few hours. Finish and fail
 * notifications go only to these, so a pool of busy agents (and status
 * flaps) never floods the phone.
 *
 * Kept per node, by the id this node shows (a local id, or a pool address
 * `<machineId>/<localId>` for an agent on another machine), because the
 * node that served the app is the one that saw the operator act. Stored in
 * the database so a daemon restart keeps it.
 */

/** How long one action keeps an agent interesting. */
export const INTEREST_MS = 6 * 60 * 60_000;
/** Most agents remembered; the oldest go first. */
const MAX_ROWS = 2000;

export class Interest {
	private readonly store: Store;
	private readonly now: () => number;
	private readonly windowMs: number;
	/** Last write per id, so a stream of opens doesn't write on every call. */
	private recent = new Map<string, number>();

	constructor(opts: {
		store: Store;
		now?: () => number;
		windowMs?: number;
	}) {
		this.store = opts.store;
		this.now = opts.now ?? Date.now;
		this.windowMs = opts.windowMs ?? INTEREST_MS;
	}

	/** The operator started, messaged or opened `agentId` just now. */
	note(agentId: string) {
		if (!agentId || agentId.length > 400) return;
		const now = this.now();
		const last = this.recent.get(agentId);
		// Within a minute of the last write: nothing new to keep.
		if (last !== undefined && now - last < 60_000) return;
		this.recent.set(agentId, now);
		if (this.recent.size > MAX_ROWS) this.recent.clear();
		const db = this.store.db;
		db.prepare(
			`INSERT INTO agent_interest (agent_id, at) VALUES (?, ?)
			 ON CONFLICT(agent_id) DO UPDATE SET at = excluded.at`,
		).run(agentId, now);
		db.prepare("DELETE FROM agent_interest WHERE at < ?").run(
			now - this.windowMs,
		);
	}

	/** True when the operator acted on `agentId` within the window. */
	has(agentId: string): boolean {
		const r = this.store.db
			.prepare("SELECT at FROM agent_interest WHERE agent_id = ?")
			.get(agentId) as { at: number } | undefined;
		return r !== undefined && this.now() - Number(r.at) <= this.windowMs;
	}
}
