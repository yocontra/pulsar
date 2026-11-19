import { randomUUID } from "node:crypto";
import type { PresenceProvider } from "../presence/native.ts";
import { promptText } from "../presence/native.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import type { Agent } from "../types.ts";
import type { Approvals } from "./approvals.ts";
import { type Caller, principalLabel } from "./caller.ts";
import type { EnrollGate } from "./enroll.ts";
import type { Registry } from "./registry.ts";

/**
 * Human-presence checks for sensitive commands (`pulsar mesh allow|deny|forget|owner`, `pulsar
 * passkeys remove`). Anyone may run them, agents included; the daemon then
 * asks the person, two ways at once, and the first answer wins:
 *
 * - the operating system's own prompt (Touch ID / password on macOS, Windows
 *   Hello, polkit), which the daemon runs itself as a child process;
 * - a "confirm" card in the Pulsar app (Needs You, and a push to the phone),
 *   answered with a passkey (user verification), verified by this daemon.
 *
 * Both name the exact action and who asked. The client never says how the
 * check went: the op runs in one call, and the daemon applies the change only
 * when its own check passes. One check at a time; prompts that end without a
 * yes (no, timeout, hang-up) back off, so an
 * agent can't keep prompting until a reflexive yes. Every request and outcome
 * is audited.
 */

export interface PresenceOptions {
	native: PresenceProvider | null;
	/**
	 * The last resort, for a terminal only, when there is neither a system
	 * prompt nor the app: a word written to the caller's own terminal (a
	 * headless tagged server reached over SSH, before it has an owner).
	 */
	terminal?: EnrollGate | null;
	approvals: Approvals;
	registry: Registry;
	store: Store;
	/** How long the person has to answer. */
	timeoutMs?: number;
	now?: () => number;
}

/** What the person is asked to confirm. */
export interface PresenceAction {
	/** The op, for the audit and the proof (`pool.allow`, `passkeys.remove`). */
	op: string;
	/** What happens, as the prompt shows it: "forget pulsar-meshnode". */
	text: string;
	target: string | null;
	/** The caller's pid: only a hint for which terminal the last-resort word goes to. */
	pid?: number;
	/** The command, for the last resort's "run it in your own terminal". */
	command?: string;
}

/** What `confirm` resolves with; spent once by the op it was for. */
export interface Confirmed {
	readonly op: string;
	readonly method: string;
}

const PRESENCE_TIMEOUT_MS = 3 * 60_000;
/** Denials in this window count toward the backoff. */
const WINDOW_MS = 60 * 60_000;
const BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 30 * 60_000;

type Raced =
	| { granted: boolean; method: string }
	| { none: "timeout" | "unavailable" | "cancelled" };

const proofs = new WeakMap<Confirmed, { used: boolean }>();

/**
 * True once for a `Confirmed` this module issued for `op`; spends it.
 * Service code that applies a sensitive change asks this, so a change can't
 * be applied without a check that passed (a plain object never passes).
 */
export function spendConfirmed(c: unknown, op: string): boolean {
	if (!c || typeof c !== "object") return false;
	const state = proofs.get(c as Confirmed);
	if (!state || state.used || (c as Confirmed).op !== op) return false;
	state.used = true;
	return true;
}

export class Presence {
	private busy = false;
	/** The running check's abort (the daemon stopping takes its prompt down). */
	private active: AbortController | null = null;
	private denials: number[] = [];
	private readonly o: PresenceOptions;
	private readonly now: () => number;

	constructor(o: PresenceOptions) {
		this.o = o;
		this.now = o.now ?? Date.now;
	}

	stop() {
		this.active?.abort();
	}

	get native(): PresenceProvider | null {
		return this.o.native;
	}

	/** Who asked, as the prompt names them (from the daemon's registry, never the request). */
	private requester(caller: Caller): { agent: Agent; label: string } {
		const p = caller.principal;
		if (p.kind === "agent") {
			const agent = this.o.registry.get(p.agentId);
			if (!agent) throw new RpcError("not_registered", "unknown agent");
			const label = promptText(`agent ${agent.name} (${agent.harness})`, 80);
			return { agent, label };
		}
		if (p.kind === "terminal")
			return { agent: this.o.registry.operator(), label: "a terminal" };
		throw new RpcError(
			"forbidden",
			"this check is for commands run on this machine",
		);
	}

	private recentDenials(): number[] {
		const now = this.now();
		this.denials = this.denials.filter((t) => now - t < WINDOW_MS);
		return this.denials;
	}

	/** Wait before the next check: none after the first denial, then 15 s, 30 s, 60 s… */
	private backoffMs(): number {
		const recent = this.recentDenials();
		const last = recent.at(-1);
		if (last === undefined || recent.length < 2) return 0;
		const wait = Math.min(
			BACKOFF_MS * 2 ** (recent.length - 2),
			MAX_BACKOFF_MS,
		);
		return Math.max(0, last + wait - this.now());
	}

	private audit(
		caller: Caller,
		op: string,
		target: string | null,
		detail: unknown,
		ok = true,
	) {
		this.o.store.audit({
			at: this.now(),
			principal: principalLabel(caller.principal),
			op,
			target,
			detail: JSON.stringify(detail),
			ok,
		});
	}

	/**
	 * Why nobody can be asked, and what to do: each way to confirm and why it
	 * isn't there, then the fixes.
	 */
	private unavailable(
		text: string,
		caller: Caller,
		nativeState: "not here" | "couldn't be shown" | null,
		terminalRefusal?: string,
	): string {
		const native = this.o.native;
		const prompt = native
			? `the ${native.method} prompt ${nativeState === "couldn't be shown" ? "couldn't be shown" : "isn't available here"} (no GUI login session, e.g. over SSH, or no sensor or password set)`
			: `this machine has no system prompt Pulsar can show (${process.platform === "linux" ? "Linux needs Pulsar's polkit action, see docs/presence.md" : "none on this platform, or PULSAR_NATIVE_PRESENCE=off"})`;
		const app =
			"the app can't ask either (it is off on this machine, or this machine has no passkey yet)";
		const word =
			caller.principal.kind === "agent"
				? "and an agent's request never falls back to a typed word"
				: terminalRefusal
					? `and the last resort, a word typed at your terminal, isn't possible: ${terminalRefusal}`
					: "and the last resort, a word typed at your terminal, needs a real terminal";
		return [
			`Pulsar can't ask you to confirm "${text}": ${prompt}; ${app}; ${word}.`,
			"To fix it, do one of these:",
			"  - register a passkey for this machine: `pulsar mesh on --prove`, or Prove Human in this machine's app from any of your devices;",
			"  - or run the command yourself in a terminal on this machine (an SSH session works), not from an agent or an editor's terminal: Pulsar then writes a word there for you to type back.",
		].join("\n");
	}

	/**
	 * Asks the person to confirm `action`; resolves once they did, throws
	 * `denied`, `timeout` or `presence_unavailable` otherwise.
	 */
	async confirm(caller: Caller, action: PresenceAction): Promise<Confirmed> {
		const { agent, label } = this.requester(caller);
		if (this.busy)
			throw new RpcError(
				"rate_limited",
				"Another confirmation is waiting. Answer or cancel it first.",
			);
		const wait = this.backoffMs();
		if (wait > 0)
			throw new RpcError(
				"rate_limited",
				`Too many confirmations ended without a yes. Try again in ${Math.ceil(wait / 1000)} s.`,
			);
		this.busy = true;
		try {
			const ok = await this.check(caller, agent, label, action);
			this.denials = [];
			return ok;
		} catch (e) {
			// Every prompt that ended without a yes counts toward the backoff:
			// a no, a timeout, or the caller hanging up. Otherwise an agent
			// could ask, hang up and ask again without limit.
			const c = (e as RpcError).code;
			if (c === "denied" || c === "timeout" || c === "cancelled")
				this.denials.push(this.now());
			throw e;
		} finally {
			this.busy = false;
		}
	}

	private async check(
		caller: Caller,
		agent: Agent,
		label: string,
		action: PresenceAction,
	): Promise<Confirmed> {
		const machine = this.o.registry.machine;
		const text = promptText(action.text, 200);
		const native = this.o.native;
		const nativeOk = native
			? await native.available().catch(() => false)
			: false;
		const appOk = this.o.approvals.canAnswer();
		const methods = [
			...(nativeOk && native ? [native.method] : []),
			...(appOk ? ["the Pulsar app"] : []),
		];
		if (
			methods.length === 0 &&
			caller.principal.kind === "terminal" &&
			this.o.terminal &&
			action.pid
		)
			return this.typedWord(caller, label, action, text);
		if (methods.length === 0) {
			this.audit(
				caller,
				"presence.unavailable",
				action.target,
				{ op: action.op, text },
				false,
			);
			throw new RpcError(
				"presence_unavailable",
				this.unavailable(text, caller, nativeOk ? null : "not here"),
			);
		}
		const timeoutMs = this.o.timeoutMs ?? PRESENCE_TIMEOUT_MS;
		const nonce = randomUUID();
		this.audit(caller, "presence.request", action.target, {
			op: action.op,
			text,
			requester: label,
			methods,
		});
		caller.emit("presence", {
			action: text,
			requester: label,
			methods,
			timeoutMs,
		});
		const ac = new AbortController();
		this.active = ac;
		const onClosed = () => ac.abort();
		caller.closed.addEventListener("abort", onClosed, { once: true });
		// A hang-up while `native.available()` ran: the listener came too late.
		if (caller.closed.aborted) ac.abort();
		const card = appOk
			? this.o.approvals.presenceCard(caller, agent, {
					title: `Confirm: ${text}`,
					message: `Asked by ${label} on ${machine}. Confirm only if you started this.`,
					input: {
						op: action.op,
						target: action.target,
						text,
						requester: label,
						machine,
						nonce,
					},
					timeoutMs,
				})
			: null;
		let outcome: Raced;
		try {
			outcome = await this.race(native && nativeOk ? native : null, card, {
				reason: `confirm a Pulsar change: ${text} (asked by ${label} on ${machine})`,
				signal: ac.signal,
				timeoutMs,
			});
		} finally {
			caller.closed.removeEventListener("abort", onClosed);
			ac.abort();
			this.active = null;
			try {
				if (card) this.o.approvals.cancelPresence(card.id);
			} catch {
				// The daemon stopped and closed the store; the card expired with it.
			}
		}
		// The system prompt couldn't be shown after all (a Mac over SSH with
		// no GUI login) and there is no card: a person at a real terminal
		// still gets the last resort.
		if (
			"none" in outcome &&
			outcome.none === "unavailable" &&
			!card &&
			caller.principal.kind === "terminal" &&
			this.o.terminal &&
			action.pid
		)
			return this.typedWord(caller, label, action, text);
		if ("none" in outcome) {
			this.audit(
				caller,
				`presence.${outcome.none}`,
				action.target,
				{ op: action.op },
				false,
			);
			if (outcome.none === "timeout")
				throw new RpcError("timeout", `Nobody confirmed "${text}" in time.`);
			if (outcome.none === "cancelled")
				throw new RpcError("cancelled", `"${text}" was cancelled.`);
			throw new RpcError(
				"presence_unavailable",
				this.unavailable(text, caller, "couldn't be shown"),
			);
		}
		this.audit(
			caller,
			outcome.granted ? "presence.granted" : "presence.denied",
			action.target,
			{
				op: action.op,
				method: outcome.method,
			},
			outcome.granted,
		);
		if (!outcome.granted) {
			throw new RpcError("denied", `Not confirmed: ${text}.`);
		}
		const proof: Confirmed = Object.freeze({
			op: action.op,
			method: outcome.method,
		});
		proofs.set(proof, { used: false });
		return proof;
	}

	/** Typed-word answers waiting for `presence.word`, by ticket. */
	private words = new Map<string, (word: string) => boolean>();

	/**
	 * The last resort (no system prompt, no app): the daemon writes a word to
	 * the caller's terminal (EnrollGate: refused without a terminal, or with
	 * one under an agent harness) and the person types it back. The CLI sends
	 * it with `presence.word` on a second connection.
	 */
	private async typedWord(
		caller: Caller,
		label: string,
		action: PresenceAction,
		text: string,
	): Promise<Confirmed> {
		const gate = this.o.terminal as EnrollGate;
		const method = "the word on your terminal";
		let ticket: string;
		try {
			ticket = (
				await gate.start(action.pid as number, text, action.command ?? "pulsar")
			).ticket;
		} catch (e) {
			this.audit(
				caller,
				"presence.unavailable",
				action.target,
				{
					op: action.op,
					text,
					error: (e as Error).message,
				},
				false,
			);
			throw new RpcError(
				"presence_unavailable",
				this.unavailable(text, caller, "not here", (e as Error).message),
			);
		}
		const timeoutMs = this.o.timeoutMs ?? PRESENCE_TIMEOUT_MS;
		this.audit(caller, "presence.request", action.target, {
			op: action.op,
			text,
			requester: label,
			methods: [method],
		});
		caller.emit("presence", {
			action: text,
			requester: label,
			methods: [method],
			ticket,
			timeoutMs,
		});
		let tries = 0;
		const outcome = await new Promise<
			"granted" | "denied" | "timeout" | "cancelled"
		>((resolve) => {
			// Every way out goes through `done`, so the timer and listener go too.
			const done = (o: "granted" | "denied" | "timeout" | "cancelled") => {
				clearTimeout(timer);
				caller.closed.removeEventListener("abort", onClosed);
				resolve(o);
			};
			const timer = setTimeout(() => done("timeout"), timeoutMs);
			const onClosed = () => done("cancelled");
			caller.closed.addEventListener("abort", onClosed, { once: true });
			this.words.set(ticket, (word) => {
				let ok = false;
				try {
					ok = gate.confirm(ticket, word);
				} catch (e) {
					if ((e as RpcError).code !== "rate_limited") done("denied");
					throw e;
				}
				if (ok) done("granted");
				else if (++tries >= 3) done("denied");
				return ok;
			});
			if (caller.closed.aborted) done("cancelled");
		}).finally(() => this.words.delete(ticket));
		const granted = outcome === "granted";
		this.audit(
			caller,
			`presence.${outcome}`,
			action.target,
			{ op: action.op, method },
			granted,
		);
		if (outcome === "denied") {
			throw new RpcError("denied", `Not confirmed: ${text}.`);
		}
		if (outcome === "timeout")
			throw new RpcError("timeout", `Nobody confirmed "${text}" in time.`);
		if (outcome === "cancelled")
			throw new RpcError("cancelled", `"${text}" was cancelled.`);
		const proof: Confirmed = Object.freeze({ op: action.op, method });
		proofs.set(proof, { used: false });
		return proof;
	}

	/** `presence.word {ticket, word}`: the word typed for a last-resort check. */
	word(caller: Caller, ticket: string, word: string): { ok: boolean } {
		if (caller.principal.kind !== "terminal")
			throw new RpcError("forbidden", "the word is typed at a terminal");
		const answer = this.words.get(ticket);
		if (!answer)
			throw new RpcError(
				"not_found",
				"no such confirmation; run the command again",
			);
		return { ok: answer(word) };
	}

	/**
	 * The race. With a card, the card is the one record: a native answer ends
	 * it by compare-and-set (`endPresence`), so exactly one answer counts.
	 */
	private race(
		native: PresenceProvider | null,
		card: {
			id: string;
			result: Promise<{ decision: string; answer: unknown } | null>;
		} | null,
		o: { reason: string; signal: AbortSignal; timeoutMs: number },
	): Promise<Raced> {
		return new Promise<Raced>((done) => {
			// A guard past the card's own expiry, for a prompt that never returns.
			const timer = setTimeout(
				() => done({ none: "timeout" }),
				o.timeoutMs + 1000,
			);
			timer.unref?.();
			const resolve = (r: Raced) => {
				clearTimeout(timer);
				done(r);
			};
			let nativeWon: string | null = null;
			if (card)
				card.result.then((r) => {
					const a = r?.answer as
						| { kind?: string; confirmed?: unknown }
						| null
						| undefined;
					if (r && r.decision === "answer" && a?.kind === "confirm")
						resolve({
							granted: a.confirmed === true,
							// The app: a passkey signature for this card, or (on this
							// machine) the browser's passkey session bound to it.
							method:
								nativeWon ??
								(this.o.approvals.decidedMethod(card.id) === "passkey session"
									? "passkey session"
									: "passkey in the app"),
						});
					else resolve({ none: o.signal.aborted ? "cancelled" : "timeout" });
				});
			if (!native) return;
			native
				.verify(o.reason, { signal: o.signal, timeoutMs: o.timeoutMs })
				.catch(() => "unavailable" as const)
				.then((n) => {
					if (n === "granted" || n === "denied") {
						if (!card)
							return resolve({
								granted: n === "granted",
								method: native.method,
							});
						// Lost the compare-and-set: the card's answer resolves the race.
						if (
							this.o.approvals.endPresence(
								card.id,
								n === "granted",
								native.method,
							)
						)
							nativeWon = native.method;
						return;
					}
					// No answer from the prompt: the card (if any) still decides.
					if (!card)
						resolve({
							none: o.signal.aborted
								? "cancelled"
								: n === "timeout"
									? "timeout"
									: "unavailable",
						});
				});
		});
	}
}
