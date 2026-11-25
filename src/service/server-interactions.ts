import type { HarnessDriver, ServerPrompt } from "../harnesses/types.ts";
import type { Agent } from "../types.ts";
import type { Approvals, InteractionResult } from "./approvals.ts";
import type { Registry } from "./registry.ts";

type Source = NonNullable<HarnessDriver["serverInteractions"]>;

/**
 * How long a card for a server prompt stays answerable: the harness waits
 * on its prompt with no limit of its own, so a day; a prompt still waiting
 * then opens a new card.
 */
export const SERVER_PROMPT_TIMEOUT_MS = 86_400_000;

/**
 * Relays prompts a harness keeps on its own server (OpenCode) into
 * interactions: a new pending prompt opens one (like an extension's
 * `interaction.ask`); the app's answer is sent back through the harness's
 * API; a prompt that leaves the list was answered on the agent's own
 * screen. Polls only while someone could answer from the app.
 */
export class ServerInteractions {
	/** Per open prompt: aborted when it leaves the harness's list (answered there). */
	private open = new Map<string, AbortController>();
	private readonly o: {
		registry: Registry;
		approvals: Approvals;
		timeoutMs?: number;
	};

	constructor(o: {
		registry: Registry;
		approvals: Approvals;
		/** How long a card waits (tests shorten it). */
		timeoutMs?: number;
	}) {
		this.o = o;
	}

	/** One poll of one harness; never throws. */
	async poll(harness: string, source: Source): Promise<void> {
		if (!this.o.approvals.canAnswer()) return;
		let pending: ServerPrompt[];
		try {
			pending = await source.pending(
				this.o.registry
					.all()
					.filter((a) => a.harness === harness && a.meta.acp !== "1"),
			);
		} catch {
			return; // unreadable now: keep what is open
		}
		const seen = new Set<string>();
		for (const p of pending) {
			const key = `${harness}:${p.key}`;
			seen.add(key);
			if (this.open.has(key)) continue;
			const gone = new AbortController();
			this.open.set(key, gone);
			// Forgets the prompt, so a later poll relays it again if it still waits.
			const drop = () => {
				if (this.open.get(key) === gone) this.open.delete(key);
			};
			let asked: Promise<InteractionResult | null>;
			let agent: Agent;
			try {
				agent = this.agentFor(harness, p);
				asked = this.o.approvals.ask(
					{
						principal: { kind: "agent", agentId: agent.id },
						closed: gone.signal,
						emit() {},
					},
					{
						ref: this.o.approvals.relayRef(agent.id, p.key),
						kind: p.kind,
						tool: p.tool,
						input: p.input,
						prompt: p.prompt,
						sessionRules: p.sessionRules,
						timeoutMs: this.o.timeoutMs ?? SERVER_PROMPT_TIMEOUT_MS,
						...(p.readOnly ? { readOnly: true } : {}),
					},
				);
			} catch {
				// Refused (asked twice) or the agent is gone: try again next poll.
				drop();
				continue;
			}
			void asked
				.then(async (r) => {
					// The card's time ran out while the harness still waits: the
					// next poll opens a new one, so it stays answerable.
					if (!r) return drop();
					const ok = await source.reply(p, r).catch(() => false);
					if (ok) return;
					// The app showed it answered, but the harness still waits:
					// say so in every tab, record it, and show the prompt again
					// on the next poll.
					this.o.approvals.notice(
						"reply-failed",
						`Your answer to ${agent.name} (${p.tool}) did not reach ${harness} on ${this.o.registry.machine}. Answer it there or in the new card.`,
					);
					this.o.approvals.audit(
						{ kind: "agent", agentId: agent.id },
						"interaction.reply-failed",
						key,
						{ decision: r.decision },
						false,
					);
					drop();
				})
				.catch(drop);
		}
		for (const [key, gone] of this.open)
			if (key.startsWith(`${harness}:`) && !seen.has(key)) {
				this.open.delete(key);
				// Answered in the harness (or by the app, already settled): ends
				// a still-pending interaction as answered locally.
				gone.abort();
			}
	}

	/** The session's agent; listed now when no scanner or connection did. */
	private agentFor(harness: string, p: ServerPrompt): Agent {
		const id = this.o.registry.agentId(harness, p.sessionId, null);
		return (
			this.o.registry.get(id) ??
			this.o.registry.upsert({
				harness,
				sessionId: p.sessionId,
				pid: null,
				cwd: null,
				project: null,
				branch: null,
				tags: [`harness:${harness}`],
				meta: {},
				registered: false,
				status: "busy",
			})
		);
	}

	stop() {
		for (const gone of this.open.values()) gone.abort();
		this.open.clear();
	}
}
