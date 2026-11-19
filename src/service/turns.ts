import { open } from "node:fs/promises";
import { driverFor } from "../harnesses/index.ts";
import type { TurnKind } from "../http/wire.ts";
import type { ResolvedTranscript } from "../transcripts/tailer.ts";
import type { Agent } from "../types.ts";
import type { EventBus } from "./events.ts";
import type { Interest } from "./interest.ts";
import type { Registry } from "./registry.ts";

/**
 * Finish and fail notifications, from `agent:status`.
 *
 * A local agent's turn ended when it went busy → idle (the registry has
 * already held the idle for its settle time) and stayed idle for a further
 * grace period. It "failed" when the harness ended the turn with an error
 * (src/transcripts/turn-outcome.ts), else it "finished". A new agent's first
 * status, busy → unknown (status lost, not a finished turn) and busy → gone
 * are not turns.
 *
 * Every node decides this for its own agents and shares the last turn in its
 * agent feed (`FedAgent.turn`); other nodes announce a remote agent's new
 * turn as the same `agent:turn` event, with its pool address. Each node then
 * notifies (`notify`: the app's SSE stream and Web Push) only for agents the
 * operator recently acted on through it (`Interest`), since only that node
 * saw it. So a finish on one machine reaches a phone subscribed on another.
 */

export type { TurnKind };

/** One agent's last ended turn, as its home node decided it. */
export interface TurnRecord {
	kind: TurnKind;
	/** When the agent went idle (home node's clock, ms). */
	at: number;
}

/** Idle this long after the settle time before a turn counts as ended. */
export const GRACE_MS = 5000;
/** How much of the log's end is read to find how the turn ended. */
const TAIL_BYTES = 256 * 1024;
/** Notified turns remembered for de-duplication. */
const SEEN_MAX = 500;

export interface TurnsOptions {
	events: EventBus;
	registry: Registry;
	interest: Interest;
	resolve: (
		agent: Agent,
	) => ResolvedTranscript | null | Promise<ResolvedTranscript | null>;
	graceMs?: number;
}

export class Turns {
	private readonly o: TurnsOptions;
	private readonly graceMs: number;
	private pending = new Map<string, ReturnType<typeof setTimeout>>();
	private last = new Map<string, TurnRecord>();
	private seen = new Set<string>();
	private off: (() => void) | null = null;

	constructor(opts: TurnsOptions) {
		this.o = opts;
		this.graceMs = opts.graceMs ?? GRACE_MS;
	}

	start() {
		if (this.off) return;
		const offStatus = this.o.events.on("agent:status", (s) => {
			if (s.to === "busy" || s.to === "gone") {
				this.cancel(s.agentId);
				if (s.to === "gone") this.last.delete(s.agentId);
				return;
			}
			if (s.from !== "busy" || s.to !== "idle") return;
			this.cancel(s.agentId);
			const t = setTimeout(() => {
				this.pending.delete(s.agentId);
				void this.settle(s.agentId, s.at);
			}, this.graceMs);
			t.unref?.();
			this.pending.set(s.agentId, t);
		});
		const offTurn = this.o.events.on("agent:turn", (t) => {
			const key = `${t.agentId}@${t.at}`;
			if (this.seen.has(key) || !this.o.interest.has(t.agentId)) return;
			this.seen.add(key);
			if (this.seen.size > SEEN_MAX) {
				const first = this.seen.values().next().value;
				if (first !== undefined) this.seen.delete(first);
			}
			this.o.events.emit("notify", {
				kind: t.kind,
				agentId: t.agentId,
				at: t.at,
			});
		});
		this.off = () => {
			offStatus();
			offTurn();
		};
	}

	stop() {
		this.off?.();
		this.off = null;
		for (const t of this.pending.values()) clearTimeout(t);
		this.pending.clear();
	}

	/** A local agent's last ended turn (its feed record). */
	lastTurn(agentId: string): TurnRecord | undefined {
		return this.last.get(agentId);
	}

	private cancel(agentId: string) {
		const t = this.pending.get(agentId);
		if (t === undefined) return;
		clearTimeout(t);
		this.pending.delete(agentId);
	}

	private async settle(agentId: string, at: number) {
		const agent = this.o.registry.get(agentId);
		if (!agent || agent.status === "busy" || agent.status === "gone") return;
		const kind: TurnKind = (await this.failed(agent)) ? "failed" : "finished";
		// Stopped, busy again or gone while the log was read: not this turn.
		const now = this.o.registry.get(agentId)?.status;
		if (!this.off || !now || now === "busy" || now === "gone") return;
		this.last.set(agentId, { kind, at });
		this.o.events.emit("agent:turn", { agentId, kind, at });
	}

	/** True when the agent's log says the harness ended the turn with an error. */
	private async failed(agent: Agent): Promise<boolean> {
		try {
			const t = await this.o.resolve(agent);
			const read =
				t?.turnFailed ?? driverFor(agent.harness)?.transcript?.turnFailed;
			if (!t || !read || t.source.kind !== "file") return false;
			return read(await tailOf(t.source.path));
		} catch {
			return false;
		}
	}
}

/** The last `TAIL_BYTES` of a file, from its first whole line. */
async function tailOf(path: string): Promise<string> {
	const fh = await open(path, "r");
	try {
		const { size } = await fh.stat();
		const start = Math.max(0, size - TAIL_BYTES);
		const buf = Buffer.alloc(size - start);
		await fh.read(buf, 0, buf.length, start);
		const text = buf.toString("utf8");
		return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	} finally {
		await fh.close();
	}
}
