import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { type ExecResult, exec, type Lane } from "./exec.ts";

/**
 * Git (and `gh`) for actions the operator takes on an agent's worktree:
 * commit, push, `worktree add`, a PR. Unlike the read-only diff viewer
 * (src/changes/read.ts) these take git's locks and run hooks, but never
 * wait on a person: no terminal or GUI credential prompt, no editor, no
 * pager, ssh in batch mode. A missing credential or passphrase fails at
 * once with git's own message. Everything runs asynchronously
 * (src/exec.ts), argv only (never a shell), with a timeout; on timeout git
 * gets SIGTERM first so it removes its lock files.
 *
 *   const r = await runGit(agent.cwd, ["commit", "-m", message, "--", ...files]);
 *   if (!r.ok) throw new RpcError("git_failed", r.message);
 *
 * Writes to one worktree run one at a time (in this process). `mode: "read"`
 * is for reads next to a working agent (`ls-files`, `status`): no optional
 * locks, no queue. Paths after `--` are literal (GIT_LITERAL_PATHSPECS).
 */

export type GitErrorCode =
	/** `cwd` is not an absolute path inside a git worktree. */
	| "not_a_worktree"
	/** The command ran past its timeout (a hook, the network, a lock). */
	| "timeout"
	/** It wrote more than `maxBuffer`. */
	| "overflow"
	/** It could not start (`git` or `gh` not installed). */
	| "spawn"
	/** It exited non-zero: see `exitCode` and `stderr`. */
	| "failed";

export type GitResult =
	| { ok: true; stdout: string; stderr: string; root: string }
	| {
			ok: false;
			code: GitErrorCode;
			/** One line for the operator: git's own message when there is one. */
			message: string;
			exitCode: number | null;
			stdout: string;
			stderr: string;
	  };

export interface GitRunOptions {
	/** Default `write`: locks taken, one write per worktree at a time. */
	mode?: "write" | "read";
	/** Default 60 s for writes (hooks, the network), 10 s for reads. */
	timeoutMs?: number;
	/** Default `user`: an operator's action, not background work. */
	lane?: Lane;
	maxBuffer?: number;
	/** Extra environment (e.g. GIT_AUTHOR_NAME), on top of the safe one. */
	env?: Record<string, string>;
	/**
	 * The worktree root of `cwd` when the caller already has it (from
	 * `worktreeRoot` or an earlier result's `root`): skips the lookup, one
	 * git process fewer. Steps of one operation share it.
	 */
	root?: string;
}

/** Git options for every run: no pager, colors or fsmonitor hook; paths as UTF-8. */
export const GIT_SAFE_CONFIG = [
	"--no-pager",
	"-c",
	"core.quotepath=off",
	"-c",
	"color.ui=false",
	"-c",
	"core.fsmonitor=false",
];

/** Variables that would point git at another repo, index or object store. */
const REPO_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_PREFIX",
];

/** A program that prints nothing and fails: every askpass prompt says no. */
const NO_ASKPASS =
	process.platform === "darwin" ? "/usr/bin/false" : "/bin/false";

/**
 * The environment for git and gh in a worktree: the daemon's own, without
 * variables that redirect git, and with every prompt off. `sshCommand`: the
 * ssh command to run in batch mode (the operator's GIT_SSH_COMMAND or
 * core.sshCommand, else `ssh`).
 */
export function safeGitEnv(
	mode: "write" | "read" = "write",
	sshCommand = process.env.GIT_SSH_COMMAND || "ssh",
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const k of REPO_VARS) delete env[k];
	Object.assign(env, {
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: NO_ASKPASS,
		SSH_ASKPASS: NO_ASKPASS,
		SSH_ASKPASS_REQUIRE: "never",
		GCM_INTERACTIVE: "never",
		GIT_SSH_COMMAND: `${sshCommand} -o BatchMode=yes`,
		GIT_EDITOR: "true",
		GIT_SEQUENCE_EDITOR: "true",
		GIT_MERGE_AUTOEDIT: "no",
		GIT_PAGER: "cat",
		PAGER: "cat",
		GIT_LITERAL_PATHSPECS: "1",
		// gh: no prompts, no update check, plain output.
		GH_PROMPT_DISABLED: "1",
		GH_NO_UPDATE_NOTIFIER: "1",
		GH_SPINNER_DISABLED: "1",
		GH_PAGER: "cat",
		NO_COLOR: "1",
	});
	if (mode === "read") env.GIT_OPTIONAL_LOCKS = "0";
	else delete env.GIT_OPTIONAL_LOCKS;
	return env;
}

/**
 * The top folder of the worktree that holds `cwd` (real path), or null when
 * `cwd` is not absolute or not inside a git worktree (a bare repo, a plain
 * folder, missing).
 */
export async function worktreeRoot(cwd: string): Promise<string | null> {
	if (!isAbsolute(cwd)) return null;
	let dir: string;
	try {
		dir = await realpath(cwd);
	} catch {
		return null;
	}
	const r = await exec(
		"git",
		[
			...GIT_SAFE_CONFIG,
			"-C",
			dir,
			"rev-parse",
			"--is-inside-work-tree",
			"--show-toplevel",
		],
		{ env: safeGitEnv("read"), timeoutMs: 10_000, lane: "user" },
	);
	const [inside, top] = r.stdout.trim().split("\n");
	if (!r.ok || inside !== "true" || !top) return null;
	try {
		return await realpath(top);
	} catch {
		return null;
	}
}

/** Runs `git <args>` in the worktree that holds `cwd`. Never throws. */
export function runGit(
	cwd: string,
	args: string[],
	opts: GitRunOptions = {},
): Promise<GitResult> {
	return run("git", cwd, args, opts);
}

/** Runs `gh <args>` in the worktree that holds `cwd`, with the same safe env. Never throws. */
export function runGh(
	cwd: string,
	args: string[],
	opts: GitRunOptions = {},
): Promise<GitResult> {
	return run("gh", cwd, args, opts);
}

/** The write running (or last queued) per worktree root. */
const queues = new Map<string, Promise<unknown>>();

async function run(
	cmd: "git" | "gh",
	cwd: string,
	args: string[],
	opts: GitRunOptions,
): Promise<GitResult> {
	const mode = opts.mode ?? "write";
	const root = opts.root ?? (await worktreeRoot(cwd));
	if (!root)
		return {
			ok: false,
			code: "not_a_worktree",
			message: `${cwd} is not inside a git worktree`,
			exitCode: null,
			stdout: "",
			stderr: "",
		};
	const timeoutMs = opts.timeoutMs ?? (mode === "write" ? 60_000 : 10_000);
	const go = async (): Promise<GitResult> => {
		const ssh =
			process.env.GIT_SSH_COMMAND ||
			(mode === "write" ? await configured(root, "core.sshCommand") : null) ||
			"ssh";
		const r = await exec(
			cmd,
			cmd === "git" ? [...GIT_SAFE_CONFIG, "-C", root, ...args] : args,
			{
				cwd: root,
				env: { ...safeGitEnv(mode, ssh), ...opts.env },
				lane: opts.lane ?? "user",
				timeoutMs,
				maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
				// git removes its locks on SIGTERM; its hooks and ssh stop with it.
				killSignal: "SIGTERM",
				group: true,
			},
		);
		return result(cmd, root, r, timeoutMs);
	};
	if (mode === "read") return go();
	// One write per worktree at a time: a second waits for the first.
	const prev = queues.get(root) ?? Promise.resolve();
	const next = prev.then(go, go);
	queues.set(root, next);
	try {
		return await next;
	} finally {
		if (queues.get(root) === next) queues.delete(root);
	}
}

/** A git config value in the worktree, or null. */
async function configured(root: string, key: string): Promise<string | null> {
	const r = await exec(
		"git",
		[...GIT_SAFE_CONFIG, "-C", root, "config", "--get", key],
		{ env: safeGitEnv("read"), timeoutMs: 5000, lane: "user" },
	);
	return r.ok ? r.stdout.trim() || null : null;
}

function result(
	cmd: string,
	root: string,
	r: ExecResult,
	timeoutMs: number,
): GitResult {
	const stderr = r.stderr ?? "";
	if (r.ok) return { ok: true, stdout: r.stdout, stderr, root };
	const fail = (code: GitErrorCode, message: string): GitResult => ({
		ok: false,
		code,
		message,
		exitCode: r.code,
		stdout: r.stdout,
		stderr,
	});
	if (r.timedOut)
		return fail(
			"timeout",
			`${cmd} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`,
		);
	if (r.overflow) return fail("overflow", `${cmd} wrote too much output`);
	if (r.code === null && /ENOENT|not found/i.test(r.error ?? ""))
		return fail("spawn", `${cmd} is not installed on this machine`);
	// git's own last "fatal:"/"error:" line, else the last line it wrote.
	const lines = stderr
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const msg =
		[...lines].reverse().find((l) => /^(fatal|error|remote):/i.test(l)) ??
		lines.at(-1) ??
		r.error ??
		`${cmd} failed`;
	return fail("failed", msg.slice(0, 500));
}
