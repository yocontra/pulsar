import { createInterface } from "node:readline/promises";
import { meshIsOn } from "../http/config.ts";
import type { SetupContext, Undo } from "./actions.ts";

/** What a setup step gets from `pulsar setup` (or `pulsar mesh on`). */
export interface StepContext {
	/** `--yes`: no questions; a fix that needs the user fails instead of waiting. */
	yes: boolean;
	log: (line: string) => void;
	/** Waits for Enter after a fix; false with `--yes`, without a terminal, or on `q`. */
	waitEnter: (prompt: string) => Promise<boolean>;
	/** Runs `fn` at the very end, after the summary and doctor (the mesh ends with the QR code). */
	atEnd: (fn: () => Promise<void> | void) => void;
	/** Records how to undo a change, so `pulsar setup --uninstall` takes it back. */
	recordUndo: (client: string, undo: Undo) => void;
	/** Where the stable copy lives and which node runs it (for hook commands). */
	paths: Pick<SetupContext, "node" | "cli">;
}

/**
 * One section of `pulsar setup` after the agent configs: it asks once
 * (`question`; `--yes` accepts), then runs. Add a step by appending to
 * `SETUP_STEPS`.
 */
export interface SetupStep {
	id: string;
	/** One line for the plan, e.g. "check Tailscale, install the background service". */
	describe: string;
	question: string;
	/**
	 * True when the step doesn't apply: the user turned it off (a flag or an
	 * env variable), or the client it is for isn't selected (`selected`: ids).
	 */
	skipped?: (flags: Record<string, unknown>, selected: string[]) => boolean;
	/** Resolves false when the step could not finish. */
	run: (ctx: StepContext) => Promise<boolean>;
}

/**
 * Claude Code permission prompts relayed to the app (approvals). Only in the
 * mesh: the app is where they are answered, so setup runs it only when the
 * mesh is on, and `pulsar mesh on` runs it too. `--no-approvals` skips it
 * and removes an earlier hook; `pulsar mesh off` and `--uninstall` remove it.
 */
export const claudeApprovalsStep: SetupStep = {
	id: "claude-approvals",
	describe:
		"Claude Code: add a PermissionRequest hook to ~/.claude/settings.json, so permission prompts also show in the app (answered with Face ID / Touch ID; the terminal prompt still works and the first answer wins)",
	question: "Relay Claude Code permission prompts to the Pulsar app?",
	skipped: (flags, selected) =>
		flags["no-approvals"] === true ||
		!selected.includes("claude") ||
		!meshIsOn(),
	run: async (ctx) => {
		const { installApprovalHook } = await import("../harnesses/claude.ts");
		const undo = installApprovalHook(ctx.paths);
		ctx.recordUndo("claude", undo);
		ctx.log(
			"  ✓ [claude-approvals] PermissionRequest hook in ~/.claude/settings.json",
		);
		const { localPasskeyCount, NO_LOCAL_PASSKEY } = await import(
			"./passkey-hint.ts"
		);
		// Unknown (no daemon yet) counts as none: setup offers a code at the end.
		if (!(await localPasskeyCount())) ctx.log(`  ! ${NO_LOCAL_PASSKEY}`);
		return true;
	},
};

/**
 * The steps `pulsar setup` runs, in order, after configuring the agents. The
 * mesh is not one of them: setup asks about it at the end (`pulsar mesh on`).
 */
export const SETUP_STEPS: SetupStep[] = [claudeApprovalsStep];

/** Asks a yes/no question at the terminal; Enter gives `byDefault`. */
export async function confirm(
	question: string,
	byDefault = true,
): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (
			await rl.question(`${question} ${byDefault ? "[Y/n]" : "[y/N]"} `)
		)
			.trim()
			.toLowerCase();
		return answer === "" ? byDefault : answer === "y" || answer === "yes";
	} catch {
		return false;
	} finally {
		rl.close();
	}
}

export function stepContext(
	yes: boolean,
	atEnd: StepContext["atEnd"],
	recordUndo: StepContext["recordUndo"],
	paths: StepContext["paths"],
): StepContext {
	return {
		yes,
		atEnd,
		recordUndo,
		paths,
		log: (line) => console.log(line),
		waitEnter: async (prompt) => {
			if (yes || !process.stdin.isTTY) return false;
			const rl = createInterface({
				input: process.stdin,
				output: process.stdout,
			});
			try {
				const a = await rl.question(`  ${prompt} (q to stop) `);
				return a.trim().toLowerCase() !== "q";
			} catch {
				return false;
			} finally {
				rl.close();
			}
		},
	};
}
