import { connect, type Socket } from "node:net";
import { checkedSocketPath } from "./paths.ts";
import { type Frame, readFrames, writeFrame } from "./rpc.ts";
import { PROTOCOL_VERSION, type Registration } from "./types.ts";

/**
 * `pulsar hook claude-permission`: Claude Code's `PermissionRequest` hook.
 *
 * Reads the hook input on stdin, asks the running daemon
 * (`approval.request`) and blocks until the app decides, the prompt is
 * answered in the terminal, or the daemon's timeout (shorter than the hook's)
 * passes. Prints Claude's decision JSON, or nothing: no output means no
 * decision, and Claude's own prompt (already on screen) carries on.
 *
 * A daemon restart (an upgrade, a crash) doesn't end the prompt in the app:
 * the hook connects again and asks the same prompt once more, with the time
 * already spent, until the daemon answers or the hook's time runs out.
 *
 * Never in Claude's way: no daemon, bad input or any error exits 0 silently
 * at once. It never starts a daemon. Imports stay tiny (startup time is paid
 * on every permission prompt).
 */

/**
 * The hook's own limit when its command doesn't say its timeout (installed
 * before `--timeout`): an hour, past the daemon's waits for such a hook.
 * Claude kills a hook with a shorter timeout (600 s) itself.
 */
const DEFAULT_HOOK_TIMEOUT_S = 3600;
/** The hook stops this long before Claude would kill it. */
const GIVE_UP_MARGIN_MS = 20_000;
const STDIN_MS = 5_000;
const MAX_INPUT = 1024 * 1024;
/** Waits between attempts to reach a restarted daemon. */
const RETRY_MS = [250, 500, 1000, 2000];
/** How often the hook checks that Claude (its parent) is still there. */
const PARENT_CHECK_MS = 10_000;

/** How long the hook may keep a prompt open, from its `--timeout`. */
export function giveUpMs(hookTimeoutS: number | null): number {
	const ms = (hookTimeoutS ?? DEFAULT_HOOK_TIMEOUT_S) * 1000;
	// Node timers hold at most 2^31-1 ms (~24.8 days).
	return Math.min(2 ** 31 - 1, Math.max(1000, ms - GIVE_UP_MARGIN_MS));
}

interface HookInput {
	session_id?: unknown;
	agent_id?: unknown;
	prompt_id?: unknown;
	hook_event_name?: unknown;
	tool_name?: unknown;
	tool_use_id?: unknown;
	tool_input?: unknown;
	permission_suggestions?: unknown;
	cwd?: unknown;
	transcript_path?: unknown;
}

function readStdin(): Promise<string> {
	return new Promise((resolve) => {
		let text = "";
		const done = () => resolve(text);
		const timer = setTimeout(done, STDIN_MS);
		timer.unref();
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c: string) => {
			text += c;
			if (text.length > MAX_INPUT) {
				text = "";
				done();
			}
		});
		process.stdin.on("end", () => {
			clearTimeout(timer);
			done();
		});
		process.stdin.on("error", done);
	});
}

function open(path: string): Promise<Socket | null> {
	return new Promise((resolve) => {
		const s = connect(path);
		s.once("connect", () => resolve(s));
		s.once("error", () => resolve(null));
	});
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * `--timeout <s>`: Claude's timeout for this hook, as `pulsar setup` wrote it
 * into the hook command. Claude doesn't pass it in the hook input, and a
 * running session keeps the hook it started with, so the command line is the
 * only true source (today's settings may say otherwise). Null when absent.
 */
export function hookTimeoutArg(args: readonly string[]): number | null {
	const i = args.indexOf("--timeout");
	const n = i >= 0 ? Number(args[i + 1]) : Number.NaN;
	return Number.isInteger(n) && n > 0 ? n : null;
}

/** How one attempt ended: the daemon's answer (maybe none), or the daemon went away. */
type Attempt =
	| { kind: "answer"; decision: unknown }
	| { kind: "lost"; connected: boolean };

/**
 * One connection: `hello`, then `approval.request`. "lost" when the daemon
 * can't be reached, closes the connection before it answers (a restart, a
 * crash), or says it is stopping (`retry`): the prompt should be asked again.
 */
async function attempt(
	sock: string,
	registration: Registration,
	params: Record<string, unknown>,
	retrying: boolean,
): Promise<Attempt> {
	const socket = await open(sock);
	if (!socket) return { kind: "lost", connected: false };
	const lost = { kind: "lost", connected: true } as const;
	socket.on("error", () => {});
	let nextId = 1;
	const pending = new Map<number, (f: Frame | null) => void>();
	readFrames(socket, (f) => {
		if ("id" in f && !("method" in f)) {
			pending.get(f.id)?.(f);
			pending.delete(f.id);
		}
	});
	socket.on("close", () => {
		for (const p of pending.values()) p(null);
		pending.clear();
	});
	/** The reply frame, or null once the connection closed. */
	const call = (method: string, params: unknown) =>
		new Promise<Frame | null>((resolve) => {
			const id = nextId++;
			pending.set(id, resolve);
			writeFrame(socket, { id, method, params });
		});
	try {
		const hello = await call("hello", {
			protocol: PROTOCOL_VERSION,
			version: "hook",
			registration,
		});
		if (!hello) return lost;
		// Refused (another protocol, not allowed): no decision. On a retry, a
		// daemon still stopping may refuse: wait for the next one.
		if (!("result" in hello))
			return retrying ? lost : { kind: "answer", decision: null };
		const r = await call("approval.request", params);
		if (!r) return lost;
		if (!("result" in r)) return { kind: "answer", decision: null };
		const result = r.result as { decision?: unknown; retry?: unknown } | null;
		if (result?.retry === true) return lost;
		return { kind: "answer", decision: result?.decision ?? null };
	} finally {
		socket.destroy();
	}
}

/** Returns what to print on stdout ("" for no decision). */
export async function claudePermission(
	raw: string,
	sockPath?: string,
	hookTimeoutS: number | null = null,
	now: () => number = Date.now,
): Promise<string> {
	const started = now();
	let input: HookInput;
	try {
		input = JSON.parse(raw) as HookInput;
	} catch {
		return "";
	}
	const sessionId = str(input.session_id);
	const tool = str(input.tool_name);
	const toolInput = input.tool_input;
	if (
		!sessionId ||
		!tool ||
		(input.hook_event_name !== undefined &&
			input.hook_event_name !== "PermissionRequest") ||
		!toolInput ||
		typeof toolInput !== "object"
	)
		return "";
	let sock: string;
	try {
		sock = sockPath ?? (await checkedSocketPath());
	} catch {
		return "";
	}
	const cwd = str(input.cwd);
	const registration: Registration = {
		role: "cli",
		harness: "claude",
		sessionId,
		// Claude runs hooks as its own children.
		pid: process.ppid,
		cwd,
		project: null,
		branch: null,
		tags: [],
	};
	const request = {
		sessionId,
		promptId: str(input.prompt_id),
		tool,
		input: toolInput,
		suggestions: Array.isArray(input.permission_suggestions)
			? input.permission_suggestions
			: [],
		cwd,
		transcriptPath: str(input.transcript_path),
		// The daemon waits for the app as long as Claude waits for this hook.
		...(hookTimeoutS ? { hookTimeoutS } : {}),
	};
	const deadline = started + giveUpMs(hookTimeoutS);
	for (let tries = 0; ; tries++) {
		const elapsedMs = now() - started;
		const r = await attempt(
			sock,
			registration,
			// Asked again after a restart: the daemon's deadline keeps the time spent.
			tries ? { ...request, elapsedMs } : request,
			tries > 0,
		);
		if (r.kind === "answer") {
			const decision = r.decision;
			if (!decision || typeof decision !== "object") return "";
			return JSON.stringify({
				hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
			});
		}
		// No daemon on the first try: nothing relays prompts; get out of the way.
		if (tries === 0 && !r.connected) return "";
		const wait = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)]!;
		if (now() + wait >= deadline) return "";
		await new Promise((r) => setTimeout(r, wait));
	}
}

const CLAUDE_CHILD_EVENTS = new Set([
	"SubagentStart",
	"PreToolUse",
	"PostToolUse",
	"SubagentStop",
]);

/** The next Claude callback can take queued messages for only its exact child id. */
export async function claudeSubagentHook(
	raw: string,
	output: (context: string) => Promise<void>,
	sockPath?: string,
	pid = process.ppid,
) {
	let input: HookInput;
	try {
		input = JSON.parse(raw) as HookInput;
	} catch {
		return;
	}
	const sessionId = str(input?.session_id);
	const key = str(input?.agent_id);
	const event = str(input?.hook_event_name);
	if (!sessionId || !key || !event || !CLAUDE_CHILD_EVENTS.has(event)) return;
	const toolName = str(input.tool_name);
	const pulseTool =
		event === "PreToolUse" && !!toolName?.startsWith("mcp__pulsar__");
	const deny = () =>
		output(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason:
						"Pulsar could not verify this subagent for that tool. Ask the parent to make this call.",
				},
			}),
		);
	const path = sockPath ?? (await checkedSocketPath().catch(() => null));
	const socket = path ? await open(path) : null;
	if (!socket) {
		if (pulseTool) await deny();
		return;
	}
	socket.setTimeout(700, () => socket.destroy());
	socket.on("error", () => {});
	let seq = 0;
	const pending = new Map<number, (frame: Frame | null) => void>();
	socket.on("close", () => {
		for (const done of pending.values()) done(null);
		pending.clear();
	});
	readFrames(socket, (frame) => {
		if (!("id" in frame) || "method" in frame) return;
		pending.get(frame.id)?.(frame);
		pending.delete(frame.id);
	});
	const request = (method: string, params: unknown) =>
		new Promise<Frame | null>((resolve) => {
			if (socket.destroyed) return resolve(null);
			const id = ++seq;
			pending.set(id, resolve);
			writeFrame(socket, { id, method, params });
		});
	try {
		const hello = await request("hello", {
			protocol: PROTOCOL_VERSION,
			version: "hook",
			registration: {
				role: "cli",
				harness: "claude",
				sessionId,
				pid,
				cwd: str(input.cwd),
				project: null,
				branch: null,
				tags: [],
			} satisfies Registration,
		});
		if (!hello || !("result" in hello)) {
			if (pulseTool) await deny();
			return;
		}
		const reply = await request("claude.subagent.collect", {
			sessionId,
			pid,
			key,
			event,
			...(pulseTool && { toolName, callId: str(input.tool_use_id) }),
		});
		const result =
			reply && "result" in reply
				? (reply.result as { context?: unknown; sourceProof?: unknown } | null)
				: null;
		const context = str(result?.context);
		const proof = str(result?.sourceProof);
		if (
			pulseTool &&
			(!proof ||
				!input.tool_input ||
				typeof input.tool_input !== "object" ||
				Array.isArray(input.tool_input))
		) {
			await deny();
			return;
		}
		if ((!context && !proof) || event === "SubagentStop") return;
		await output(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: event,
					...(context && { additionalContext: context }),
					...(proof && {
						updatedInput: {
							...(input.tool_input as Record<string, unknown>),
							sourceProof: proof,
						},
					}),
				},
			}),
		);
		if (context) await request("claude.subagent.confirm", {});
	} finally {
		socket.destroy();
	}
}

/** The CLI entry: `pulsar hook <name>`. Always exits 0. */
export async function runHook(
	name: string | undefined,
	args: readonly string[] = [],
) {
	if (name === "antigravity-session") {
		const { antigravitySessionHook } = await import(
			"./harnesses/antigravity-session-hook.ts"
		);
		await antigravitySessionHook(
			await readStdin(),
			(result) =>
				new Promise<void>((resolve, reject) => {
					process.stdout.write(`${JSON.stringify(result)}\n`, (err) =>
						err ? reject(err) : resolve(),
					);
				}),
		);
		process.exit(0);
	}
	const quit = () => process.exit(0);
	// Claude kills the hook when the terminal prompt is answered (Escape, No).
	for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, quit);
	const hookTimeoutS = hookTimeoutArg(args);
	setTimeout(quit, giveUpMs(hookTimeoutS)).unref();
	// Claude went away (its terminal closed): nobody can use the decision.
	const parent = process.ppid;
	setInterval(() => {
		if (process.ppid !== parent) quit();
	}, PARENT_CHECK_MS).unref();
	if (name !== "claude-permission" && name !== "claude-subagent") quit();
	try {
		if (name === "claude-subagent") {
			await claudeSubagentHook(
				await readStdin(),
				(context) =>
					new Promise<void>((resolve, reject) => {
						process.stdout.write(`${context}\n`, (error) =>
							error ? reject(error) : resolve(),
						);
					}),
			);
			return quit();
		}
		const out = await claudePermission(
			await readStdin(),
			undefined,
			hookTimeoutS,
		);
		if (out) process.stdout.write(`${out}\n`, quit);
		else quit();
	} catch {
		quit();
	}
}
