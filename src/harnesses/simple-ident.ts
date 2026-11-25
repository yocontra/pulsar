import { basename } from "node:path";
import type { HarnessIdent } from "./types.ts";

/** Process matching for the harnesses with no session discovery (see claude-ident.ts). */

const exe = (args: string) =>
	basename(args.split(/\s+/)[0] ?? "").toLowerCase();

/** omp command lines (pi's matcher defers to this one: omp ships pi's packages). */
export function isOmpProcess(args: string): boolean {
	return /(^|\/)omp(\s|$)/.test(args) || args.includes("@oh-my-pi/");
}

/**
 * The pulsar extension runs inside omp, not pi. `argv` is the host's
 * executable path and argv: omp built as one Bun binary runs as
 * `bun /$bunfs/root/omp-<platform>-<arch>`, with `omp` only in its path.
 */
export function isOmpHost(argv: string): boolean {
	return /oh-my-pi|(^|\/)omp(-[\w.-]+)?(\s|$)/.test(argv);
}

export const piIdent = {
	id: "pi",
	label: "pi",

	matchProcess(args: string) {
		if (isOmpProcess(args)) return false;
		return (
			args.includes("pi-coding-agent") ||
			/(^|\/)pi(\s|$)/.test(args.split(/\s+/).slice(0, 2).join(" "))
		);
	},

	// Push goes through the pulsar extension. pi is its default host.
	extension: {
		isHost: (argv: string) => !isOmpHost(argv),
		idleEvents: ["agent_settled"],
	},
} satisfies HarnessIdent;

export const ompIdent = {
	id: "omp",
	label: "omp",

	matchProcess: isOmpProcess,

	// Its model calls MCP tools as commands: `mcp__pulsar_send <to> <body>`.
	cliArgs: true,

	// Push goes through the pulsar extension; omp reports idle with `agent_end`.
	extension: {
		isHost: isOmpHost,
		idleEvents: ["agent_settled", "agent_end"],
	},
} satisfies HarnessIdent;

export const cursorIdent = {
	id: "cursor",
	label: "Cursor",

	matchProcess(args: string) {
		return (
			exe(args) === "cursor-agent" ||
			exe(args) === "cursor" ||
			args.startsWith("/Applications/Cursor.app/Contents/")
		);
	},
} satisfies HarnessIdent;

export const geminiIdent = {
	id: "gemini",
	label: "Gemini CLI",

	matchProcess(args: string) {
		return exe(args) === "gemini" || args.includes("@google/gemini-cli");
	},
} satisfies HarnessIdent;

export const vscodeIdent = {
	id: "vscode",
	label: "VS Code",

	matchProcess(args: string) {
		return (
			args.startsWith("/Applications/Visual Studio Code.app/Contents/") ||
			exe(args) === "code"
		);
	},
} satisfies HarnessIdent;
