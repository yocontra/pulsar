import { exec } from "./exec.ts";
import type { Agent } from "./types.ts";

/**
 * tmux for agents that run in a tmux pane: find the pane, type into it,
 * read it. Everything is argv through src/exec.ts (never a shell), in the
 * `user` lane, with a short timeout. A pane is tmux's own id (`%12`),
 * which stays the same while the pane lives, whatever its session or
 * window is renamed to.
 *
 * Where an agent's pane comes from: `agent.meta.tmux` (set by whoever
 * started it in tmux, and shown to the app as `AgentRow.tmux`), else its
 * harness driver's `tmuxPane` (Claude Code's session record says it).
 *
 * This module imports no harness code (they import it); `paneOf` reaches
 * the drivers through a dynamic import.
 */

/** tmux's pane id: `%` and digits. */
const PANE = /^%\d{1,9}$/;

/** True for a tmux pane id (`%12`). */
export function isPane(s: unknown): s is string {
	return typeof s === "string" && PANE.test(s);
}

/** Key names `sendKeys` passes on: `Enter`, `Escape`, `C-c`, `Up`, `F5`... */
const KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,15}$/;

export interface TmuxOptions {
	/** A tmux server by socket name (`tmux -L <name>`); the default server otherwise. */
	socket?: string;
	timeoutMs?: number;
}

export type TmuxResult = { ok: true } | { ok: false; error: string };

function tmux(args: string[], opts: TmuxOptions = {}) {
	return exec("tmux", [...(opts.socket ? ["-L", opts.socket] : []), ...args], {
		lane: "user",
		timeoutMs: opts.timeoutMs ?? 3000,
	});
}

/**
 * The pane an agent runs in, or null: `agent.meta.tmux`, else what its
 * harness knows (Claude Code's session record).
 */
export async function paneOf(
	agent: Agent,
	opts: TmuxOptions = {},
): Promise<string | null> {
	if (isPane(agent.meta.tmux)) return agent.meta.tmux;
	const { driverFor } = await import("./harnesses/index.ts");
	const pane = await driverFor(agent.harness)?.tmuxPane?.(agent);
	if (isPane(pane)) return pane;
	if (!agent.pid) return null;
	const { processSnapshot } = await import("./processes.ts");
	const table = await processSnapshot(2000, "user");
	return paneOfPid(agent.pid, (p) => table.get(p)?.ppid, opts);
}

/** Hops up the process tree `paneOfPid` takes (harness, wrapper, shell...). */
const PANE_HOPS = 6;

/**
 * The pane whose process is `pid` or one of its near ancestors (a harness
 * started from the pane's shell), or null. Ownership comes from the tree:
 * a pane only counts when its own process is up the agent's chain, so a
 * pane that merely shows the same folder never matches.
 */
export async function paneOfPid(
	pid: number,
	parentOf: (pid: number) => number | undefined,
	opts: TmuxOptions = {},
): Promise<string | null> {
	const r = await tmux(
		["list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"],
		opts,
	);
	if (!r.ok) return null;
	const byPid = new Map<number, string>();
	for (const line of r.stdout.split("\n")) {
		const [id, p] = line.trim().split(" ");
		if (isPane(id) && Number(p) > 0) byPid.set(Number(p), id);
	}
	let p: number | undefined = pid;
	for (let hops = 0; p && p > 1 && hops < PANE_HOPS; hops++) {
		const pane = byPid.get(p);
		if (pane) return pane;
		p = parentOf(p);
	}
	return null;
}

/** The pid of the process tmux started in the pane (the shell or the harness), or null. */
export async function panePid(
	pane: string,
	opts: TmuxOptions = {},
): Promise<number | null> {
	if (!isPane(pane)) return null;
	const r = await tmux(
		["display-message", "-p", "-t", pane, "#{pane_pid}"],
		opts,
	);
	// tmux prints nothing (and exits 0) for a pane that doesn't exist.
	const pid = Number(r.stdout.trim());
	return r.ok && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Types into a pane. `text` is typed literally (no key names, nothing
 * starting with `-` taken as a flag); `keys` are tmux key names, each
 * pressed in turn (`["Enter"]`, `["Escape"]`, `["C-c"]`).
 */
export async function sendKeys(
	pane: string,
	input: { text: string } | { keys: string[] },
	opts: TmuxOptions = {},
): Promise<TmuxResult> {
	if (!isPane(pane)) return { ok: false, error: `not a tmux pane: ${pane}` };
	let args: string[];
	if ("text" in input) {
		if (!input.text) return { ok: true };
		// tmux reads an argument's trailing `;` as a command separator (and
		// drops it): those go as their key code instead.
		const body = input.text.replace(/;+$/, "");
		const semis = input.text.length - body.length;
		if (body) {
			const r = await tmux(["send-keys", "-t", pane, "-l", "--", body], opts);
			if (!r.ok) return { ok: false, error: r.error ?? "tmux failed" };
			if (!semis) return { ok: true };
		}
		args = ["send-keys", "-t", pane, "-H", ...Array(semis).fill("3b")];
	} else {
		const bad = input.keys.find((k) => !KEY.test(k));
		if (bad !== undefined || input.keys.length === 0)
			return { ok: false, error: `not a tmux key name: ${bad ?? "(none)"}` };
		args = ["send-keys", "-t", pane, "--", ...input.keys];
	}
	const r = await tmux(args, opts);
	return r.ok ? { ok: true } : { ok: false, error: r.error ?? "tmux failed" };
}

/**
 * What a pane shows now, as plain text (wrapped lines joined), with
 * `lines` of scrollback above it. Null when the pane is gone.
 */
export async function capture(
	pane: string,
	opts: TmuxOptions & { lines?: number; ansi?: boolean } = {},
): Promise<string | null> {
	if (!isPane(pane)) return null;
	const back = Math.max(0, Math.min(10_000, Math.floor(opts.lines ?? 0)));
	const r = await tmux(
		[
			"capture-pane",
			"-p",
			"-J",
			// With colours: a dim placeholder tells an empty input from a draft.
			...(opts.ansi ? ["-e"] : []),
			"-t",
			pane,
			"-S",
			`-${back}`,
		],
		opts,
	);
	return r.ok ? r.stdout : null;
}

/** tmux session names Pulsar makes: letters, digits, `-`, `_`. */
const SESSION = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Starts a detached tmux session (and the tmux server, if none runs) that
 * runs `argv` in `dir`; returns its pane id. `argv` goes to tmux as separate
 * arguments, so tmux runs it directly, never through a shell of its own.
 */
export async function newSession(
	name: string,
	dir: string,
	argv: string[],
	opts: TmuxOptions & { width?: number; height?: number } = {},
): Promise<{ ok: true; pane: string } | { ok: false; error: string }> {
	if (!SESSION.test(name))
		return { ok: false, error: `not a session name: ${name}` };
	if (argv.length === 0) return { ok: false, error: "no command" };
	const r = await tmux(
		[
			"new-session",
			"-d",
			"-s",
			name,
			"-c",
			dir,
			"-x",
			String(opts.width ?? 200),
			"-y",
			String(opts.height ?? 50),
			"-P",
			"-F",
			"#{pane_id}",
			"--",
			...argv,
		],
		{ ...opts, timeoutMs: opts.timeoutMs ?? 10_000 },
	);
	const pane = r.stdout.trim();
	if (!r.ok || !isPane(pane))
		return {
			ok: false,
			error: (r.stderr || r.error || "tmux failed").trim().slice(0, 300),
		};
	return { ok: true, pane };
}

/** Ends a tmux session and what runs in it. */
export async function killSession(
	name: string,
	opts: TmuxOptions = {},
): Promise<TmuxResult> {
	if (!SESSION.test(name))
		return { ok: false, error: `not a session name: ${name}` };
	const r = await tmux(["kill-session", "-t", `=${name}`], opts);
	return r.ok ? { ok: true } : { ok: false, error: r.error ?? "tmux failed" };
}
