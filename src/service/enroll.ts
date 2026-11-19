import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { exec } from "../exec.ts";
import { driverForProcess } from "../harnesses/index.ts";
import { processSnapshot } from "../processes.ts";
import { RpcError } from "../rpc.ts";

/**
 * The last-resort presence check (src/service/presence.ts): used only for a
 * terminal, and only when this machine has neither a system prompt (Touch ID,
 * Windows Hello, polkit) nor a passkey in the app, e.g. a headless tagged
 * server reached over SSH before it has an owner.
 *
 * 1. `start(pid)`: the pid is only a hint for which terminal to use (Node
 *    can't read a Unix socket's peer credentials), so nothing about the
 *    caller is trusted. The daemon looks up that process's terminal and
 *    requires that the terminal device is owned by this user and that no
 *    process on it (`ps -t`) has an agent host (Claude Code, Codex, VS Code,
 *    Cursor, …) anywhere in its full ancestry, itself included. It then writes
 *    a random confirmation (10 characters, ~49 bits) straight to that
 *    terminal. The confirmation never travels over the socket.
 * 2. `confirm(ticket, word)`: the person typed what they saw (`presence.word`).
 *
 * One ticket is active at a time. New tickets and wrong answers back off
 * exponentially (nothing is wiped). Every ticket, wrong answer, refusal and
 * success is reported through `onEvent`.
 *
 * Not stopped (SECURITY.md): a same-user process that starts a detached
 * pseudo-terminal outside every agent's process tree and reads it back
 * (verified with `script`).
 */

type MaybeAsync<T> = T | Promise<T>;

/** What the gate asks of the system; async in the daemon (it never blocks on `ps`). */
export interface EnrollDeps {
	/** The controlling terminal of a process, e.g. "/dev/ttys003"; null for none. */
	ttyOf(pid: number): MaybeAsync<string | null>;
	/** The terminal device belongs to the user the daemon runs as. */
	ownedByUser(tty: string): MaybeAsync<boolean>;
	/** Every process whose controlling terminal is `tty`. */
	processesOn(tty: string): MaybeAsync<number[]>;
	/** The agent host anywhere above (or at) `pid`, walking to pid 1; null for none. */
	agentHost(pid: number): MaybeAsync<string | null>;
	/** Writes a line to a terminal device. */
	writeTty(tty: string, text: string): unknown;
	now(): number;
}

export type EnrollEvent =
	| { kind: "ticket"; tty: string }
	| { kind: "refused"; reason: string }
	| { kind: "wrong"; failures: number }
	| { kind: "confirmed" };

const TICKET_MS = 2 * 60_000;
const MAX_TRIES = 3;
/** Backoff window: counts reset after an hour without tickets or wrong answers. */
const WINDOW_MS = 60 * 60_000;
const TICKET_BACKOFF_MS = 15_000;
const WRONG_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 10;

/** Delay after the n-th event in the window: 0 for the first, then base, 2·base, 4·base… */
const backoff = (n: number, base: number) =>
	n <= 0 ? 0 : Math.min(base * 2 ** (n - 1), MAX_BACKOFF_MS);

async function ps(args: string[]): Promise<string> {
	const r = await exec("ps", args, { lane: "user", timeoutMs: 4000 });
	if (!r.ok) throw new Error(r.error ?? "ps failed");
	return r.stdout;
}

/** The harness at or above `pid`, walking every parent up to pid 1 (cycles end the walk). */
export function hostInAncestry(
	pid: number,
	table: Map<number, { pid: number; ppid: number; args: string }>,
): string | null {
	const seen = new Set<number>();
	let current = table.get(pid);
	while (current && current.pid > 1 && !seen.has(current.pid)) {
		seen.add(current.pid);
		const driver = driverForProcess(current.args);
		if (driver) return driver.label;
		current = table.get(current.ppid);
	}
	return null;
}

const defaultEnrollDeps: EnrollDeps = {
	async ttyOf(pid) {
		try {
			const t = (await ps(["-o", "tty=", "-p", String(pid)])).trim();
			if (!t || t === "?" || t === "??") return null;
			return t.startsWith("/dev/") ? t : `/dev/${t}`;
		} catch {
			return null;
		}
	},
	async ownedByUser(tty) {
		try {
			return (await stat(tty)).uid === process.getuid?.();
		} catch {
			return false;
		}
	},
	async processesOn(tty) {
		try {
			return (await ps(["-t", tty.replace(/^\/dev\//, ""), "-o", "pid="]))
				.split("\n")
				.map((l) => Number(l.trim()))
				.filter((n) => n > 0);
		} catch {
			return [];
		}
	},
	// One fresh table for the whole check (it asks for every process on the tty).
	agentHost: async (pid) =>
		hostInAncestry(pid, await processSnapshot(1000, "user")),
	async writeTty(tty, text) {
		await writeFile(tty, text, { flag: "a" });
	},
	now: Date.now,
};

interface Ticket {
	id: string;
	word: string;
	expiresAt: number;
	tries: number;
}

const refuse = (message: string) => new RpcError("not_a_terminal", message);

export class EnrollGate {
	private ticket: Ticket | null = null;
	private tickets: number[] = [];
	private failures: number[] = [];
	private readonly deps: EnrollDeps;
	/** Reported for every ticket, refusal, wrong answer and success. */
	onEvent: (e: EnrollEvent) => void = () => {};

	constructor(deps: EnrollDeps = defaultEnrollDeps) {
		this.deps = deps;
	}

	private recent(list: number[]): number[] {
		const now = this.deps.now();
		return list.filter((t) => now - t < WINDOW_MS);
	}

	private wait(list: number[], base: number): number {
		const recent = this.recent(list);
		const last = recent.at(-1);
		if (last === undefined) return 0;
		return Math.max(0, last + backoff(recent.length, base) - this.deps.now());
	}

	private refused(message: string): never {
		this.onEvent({ kind: "refused", reason: message });
		throw refuse(message);
	}

	/**
	 * Step 1: shows a confirmation on the hinted process's terminal; returns a
	 * ticket. `purpose` names what it confirms ("allow ci (pulsar mesh)"),
	 * `command` the command to run in a terminal.
	 */
	async start(
		pid: number,
		purpose = "change the pool",
		command = "pulsar mesh",
	): Promise<{ ticket: string; tty: string }> {
		// One check at a time: the backoff below must count every attempt.
		if (this.starting)
			throw new RpcError(
				"rate_limited",
				"A confirmation is already running. Try again in a moment.",
			);
		this.starting = true;
		try {
			return await this.check(pid, purpose, command);
		} finally {
			this.starting = false;
		}
	}

	private starting = false;

	private async check(
		pid: number,
		purpose: string,
		command: string,
	): Promise<{ ticket: string; tty: string }> {
		const OWN_TERMINAL = `Run \`${command}\` in your own terminal app (not from an agent, and not in an editor's terminal).`;
		const waitMs = this.wait(this.tickets, TICKET_BACKOFF_MS);
		if (waitMs > 0)
			throw new RpcError(
				"rate_limited",
				`Too many confirmation attempts. Try again in ${Math.ceil(waitMs / 1000)} s.`,
			);
		if (!Number.isInteger(pid) || pid <= 1) this.refused(OWN_TERMINAL);
		const tty = await this.deps.ttyOf(pid);
		if (!tty) this.refused(`That process has no terminal. ${OWN_TERMINAL}`);
		if (!(await this.deps.ownedByUser(tty)))
			this.refused(`${tty} isn't your terminal. ${OWN_TERMINAL}`);
		const procs = await this.deps.processesOn(tty);
		if (!procs.includes(pid))
			this.refused(`That process isn't on ${tty}. ${OWN_TERMINAL}`);
		for (const p of procs) {
			const host = await this.deps.agentHost(p);
			if (host)
				this.refused(
					`${tty} has a process under ${host}, where an agent could read or type into it. ${OWN_TERMINAL}`,
				);
		}
		let word = "";
		for (let i = 0; i < LENGTH; i++)
			word += ALPHABET[randomInt(0, ALPHABET.length)];
		const shown = `${word.slice(0, 5)}-${word.slice(5)}`;
		await this.deps.writeTty(tty, `\npulsar: to ${purpose}, type: ${shown}\n`);
		const now = this.deps.now();
		this.tickets = [...this.recent(this.tickets), now];
		// One ticket at a time: a new one ends the previous one.
		this.ticket = {
			id: randomBytes(16).toString("base64url"),
			word,
			expiresAt: now + TICKET_MS,
			tries: 0,
		};
		this.onEvent({ kind: "ticket", tty });
		return { ticket: this.ticket.id, tty };
	}

	/** Step 2: true once the typed confirmation matches (three tries, two minutes, backoff on wrong ones). */
	confirm(ticket: string, word: string): boolean {
		const t = this.ticket;
		if (!t || t.id !== ticket || t.expiresAt <= this.deps.now()) {
			if (t?.id === ticket) this.ticket = null;
			throw refuse("That confirmation expired. Run the command again.");
		}
		const waitMs = this.wait(this.failures, WRONG_BACKOFF_MS);
		if (waitMs > 0)
			throw new RpcError(
				"rate_limited",
				`Wait ${Math.ceil(waitMs / 1000)} s before trying again.`,
			);
		const a = Buffer.from(word.toUpperCase().replace(/[^A-Z0-9]/g, ""));
		const b = Buffer.from(t.word);
		if (a.length === b.length && timingSafeEqual(a, b)) {
			this.ticket = null;
			this.onEvent({ kind: "confirmed" });
			return true;
		}
		this.failures = [...this.recent(this.failures), this.deps.now()];
		if (++t.tries >= MAX_TRIES) this.ticket = null;
		this.onEvent({ kind: "wrong", failures: this.failures.length });
		return false;
	}
}
