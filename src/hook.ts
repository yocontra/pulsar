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
 * Never in Claude's way: no daemon, bad input or any error exits 0 silently
 * at once. It never starts a daemon. Imports stay tiny (startup time is paid
 * on every permission prompt).
 */

/**
 * Past the daemon's own timeouts (a minute under `--timeout`, at most
 * 3540 s; 540 s for a permission prompt from a hook without it), under
 * Claude's hook timeout (3600 s; 600 s in hooks installed before
 * interactions, which Claude then ends itself).
 */
const GIVE_UP_MS = 3_580_000;
const STDIN_MS = 5_000;
const MAX_INPUT = 1024 * 1024;

interface HookInput {
	session_id?: unknown;
	prompt_id?: unknown;
	hook_event_name?: unknown;
	tool_name?: unknown;
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

/** Returns what to print on stdout ("" for no decision). */
async function claudePermission(
	raw: string,
	sockPath?: string,
	hookTimeoutS: number | null = null,
): Promise<string> {
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
	const socket = await open(sock);
	if (!socket) return "";
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
	const call = (method: string, params: unknown) =>
		new Promise<unknown>((resolve) => {
			const id = nextId++;
			pending.set(id, (f) =>
				resolve(f && "result" in f ? f.result : undefined),
			);
			writeFrame(socket, { id, method, params });
		});
	try {
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
		const hello = await call("hello", {
			protocol: PROTOCOL_VERSION,
			version: "hook",
			registration,
		});
		if (!hello) return "";
		const r = (await call("approval.request", {
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
		})) as { decision?: unknown } | undefined;
		const decision = r?.decision;
		if (!decision || typeof decision !== "object") return "";
		return JSON.stringify({
			hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
		});
	} finally {
		socket.destroy();
	}
}

/** The CLI entry: `pulsar hook <name>`. Always exits 0. */
export async function runHook(
	name: string | undefined,
	args: readonly string[] = [],
) {
	const quit = () => process.exit(0);
	// Claude kills the hook when the terminal prompt is answered (Escape, No).
	for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, quit);
	setTimeout(quit, GIVE_UP_MS).unref();
	if (name !== "claude-permission") quit();
	try {
		const out = await claudePermission(
			await readStdin(),
			undefined,
			hookTimeoutArg(args),
		);
		if (out) process.stdout.write(`${out}\n`, quit);
		else quit();
	} catch {
		quit();
	}
}
