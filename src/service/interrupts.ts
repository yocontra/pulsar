import { randomBytes } from "node:crypto";
import { driverFor } from "../harnesses/index.ts";
import type { InterruptOutcome } from "../harnesses/types.ts";
import type { StopResult } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import type { Agent } from "../types.ts";
import { type Principal, principalLabel } from "./caller.ts";
import type { Registry } from "./registry.ts";
import type { Sessions } from "./sessions.ts";

/** How long an extension has to answer an interrupt. */
const EXTENSION_TIMEOUT_MS = 3000;

/**
 * Stop: interrupting an agent's current turn without ending its session.
 * Extension hosts (pi, omp) are asked through their pulsar extension; every
 * other harness through its driver. Callers authorize `stop` first. Each
 * attempt is written to the audit log.
 */
export class Interrupts {
	private readonly registry: Registry;
	private readonly sessions: Sessions;
	private readonly store: Store;
	private pending = new Map<
		string,
		{ agentId: string; resolve: (o: InterruptOutcome) => void }
	>();

	constructor(deps: { registry: Registry; sessions: Sessions; store: Store }) {
		this.registry = deps.registry;
		this.sessions = deps.sessions;
		this.store = deps.store;
	}

	/** Cheap: whether Stop is offered for this agent. */
	can(agent: Agent): boolean {
		if (agent.status === "gone") return false;
		if (this.sessions.extensionFor(agent.id)) return true;
		return driverFor(agent.harness)?.canInterrupt?.(agent) ?? false;
	}

	async stop(principal: Principal, agentId: string): Promise<StopResult> {
		const agent = this.registry.get(agentId);
		if (!agent || agent.status === "gone")
			throw new RpcError("not_found", `no agent ${agentId}`);
		let outcome: InterruptOutcome;
		try {
			outcome = await this.run(agent);
		} catch (e) {
			outcome = {
				result: "unsupported",
				via: "error",
				detail: (e as Error).message,
			};
		}
		this.store.audit({
			principal: principalLabel(principal),
			op: "stop",
			target: agent.id,
			detail: [outcome.result, outcome.via, outcome.detail]
				.filter(Boolean)
				.join(" · "),
			ok: outcome.result !== "unsupported",
		});
		return { agentId: agent.id, ...outcome };
	}

	private run(agent: Agent): Promise<InterruptOutcome> {
		const ext = this.sessions.extensionFor(agent.id);
		if (ext) {
			const requestId = randomBytes(8).toString("base64url");
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					this.pending.delete(requestId);
					resolve({
						result: "unsupported",
						via: "extension",
						detail: "the extension did not answer",
					});
				}, EXTENSION_TIMEOUT_MS);
				timer.unref?.();
				this.pending.set(requestId, {
					agentId: agent.id,
					resolve: (o) => {
						clearTimeout(timer);
						resolve(o);
					},
				});
				ext.emit("interrupt", { requestId });
			});
		}
		const driver = driverFor(agent.harness);
		if (!driver?.interrupt || !driver.canInterrupt?.(agent))
			return Promise.resolve({
				result: "unsupported",
				via: driver?.id ?? agent.harness,
				detail: "this harness cannot be interrupted from outside",
			});
		return driver.interrupt(agent);
	}

	/** `interrupt_result {requestId, result, detail?}` from an extension. */
	answer(agentId: string, p: Record<string, unknown>) {
		const id = String(p.requestId ?? "");
		const waiting = this.pending.get(id);
		// Only the agent that was asked may answer.
		if (!waiting || waiting.agentId !== agentId) return { ok: false };
		this.pending.delete(id);
		const r = p.result;
		waiting.resolve({
			result: r === "interrupted" || r === "not-running" ? r : "unsupported",
			via: "extension",
			...(typeof p.detail === "string" ? { detail: p.detail } : {}),
		});
		return { ok: true };
	}
}
