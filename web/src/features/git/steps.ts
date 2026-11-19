/**
 * The git actions' step loop, free of React and the API so it can be
 * tested: commit → push → PR, each its own acting op with its own params.
 * The hook in run.ts gives it the API call, the confirms and the pauses.
 */
import type {
	GitCommitParams,
	GitCommitResult,
	GitPrResult,
	GitPushResult,
} from "../../api/types.ts";
import { httpsOnly, type Step } from "./model.ts";

export type Phase =
	| { kind: "idle" }
	| {
			kind: "running";
			step: Step;
			index: number;
			total: number;
			since: number;
	  }
	/** Another machine: the next step waits for a tap (a fresh passkey prompt). */
	| { kind: "paused"; step: Step; index: number; total: number }
	| { kind: "done"; text: string; href?: string };

/** The commit dialog's answer: params for git.commit (without the confirms). */
export type CommitChoice = Pick<
	GitCommitParams,
	"files" | "message" | "newBranch" | "confirmDefault"
>;

/** How the loop reads a failed step. */
export type Failure =
	/** The operator cancelled Prove Human: stop quietly. */
	| "cancelled"
	/** The agent started working, or the branch is the default one: confirm, retry. */
	| "confirm_busy"
	| "confirm_default"
	/** The browser refused a passkey prompt (no tap started it, or cancelled). */
	| "not_allowed"
	| "other";

export interface StepDeps {
	/** The agent is on another machine: each step is its own passkey check. */
	remote: boolean;
	/** The agent is mid-turn now. */
	working: boolean;
	status:
		| {
				onDefault: boolean;
				branch: string | null;
				defaultBranch: string | null;
		  }
		| undefined;
	act: (step: Step, params: object) => Promise<unknown>;
	classify: (e: unknown) => Failure;
	askBusy: (what: "Commit" | "Push") => Promise<boolean>;
	askDefault: (branch: string) => Promise<boolean>;
	/** Shows the paused step and resolves on its tap (true) or Stop (false). */
	waitTap: (p: Extract<Phase, { kind: "paused" }>) => Promise<boolean>;
	/** This browser wants a tap before each passkey prompt (iOS, Safari). */
	needsTap: boolean;
	progress: (p: Phase) => void;
	/** After each step, success or not: re-read what changed. */
	refresh: () => void;
	/** False once the header is gone: stop without touching state. */
	live: () => boolean;
	/** A failure that ends the run (the toast). */
	failed: (e: unknown, f: Failure) => void;
	now?: () => number;
}

function paramsFor(
	step: Step,
	commit: CommitChoice | undefined,
	flags: { busy: boolean; onDefault: boolean },
): object {
	if (step === "commit")
		return {
			files: commit!.files,
			message: commit!.message,
			...(commit!.newBranch ? { newBranch: commit!.newBranch } : {}),
			...(flags.busy ? { confirmBusy: true } : {}),
			...(commit!.confirmDefault || flags.onDefault
				? { confirmDefault: true }
				: {}),
		};
	if (step === "push")
		return {
			...(flags.busy ? { confirmBusy: true } : {}),
			...(flags.onDefault ? { confirmDefault: true } : {}),
		};
	return {};
}

/** Runs the steps in order; returns the phase it ended on. */
export async function runSteps(
	steps: Step[],
	commit: CommitChoice | undefined,
	d: StepDeps,
): Promise<Phase> {
	const now = d.now ?? Date.now;
	const flags = { busy: false, onDefault: !!commit?.confirmDefault };
	const idle: Phase = { kind: "idle" };
	const first = steps[0];
	if (d.working && (first === "commit" || first === "push")) {
		if (!(await d.askBusy(first === "commit" ? "Commit" : "Push"))) return idle;
		flags.busy = true;
	}
	if (first === "push" && d.status?.onDefault) {
		if (!(await d.askDefault(d.status.branch ?? "the default branch")))
			return idle;
		flags.onDefault = true;
	}
	let todo = [...steps];
	let last: Phase = idle;
	for (let i = 0; i < todo.length; i++) {
		const step = todo[i]!;
		d.progress({
			kind: "running",
			step,
			index: i,
			total: todo.length,
			since: now(),
		});
		let result: unknown;
		try {
			result = await d.act(step, paramsFor(step, commit, flags));
		} catch (e) {
			if (!d.live()) return last;
			d.refresh();
			const f = d.classify(e);
			if (f === "cancelled") return idle;
			// A race with the status shown: confirm now, then retry the step.
			if (f === "confirm_busy" && step !== "pr") {
				if (!(await d.askBusy(step === "commit" ? "Commit" : "Push")))
					return idle;
				flags.busy = true;
				i--;
				continue;
			}
			if (f === "confirm_default" && step !== "pr") {
				if (!(await d.askDefault(d.status?.branch ?? "the default branch")))
					return idle;
				flags.onDefault = true;
				i--;
				continue;
			}
			// A later step's passkey prompt refused: wait for the operator's tap.
			if (d.remote && i > 0 && f === "not_allowed") {
				const go = await d.waitTap({
					kind: "paused",
					step,
					index: i,
					total: todo.length,
				});
				if (!go) return last;
				i--;
				continue;
			}
			// The notice says what failed; the button is back for a retry.
			d.failed(e, f);
			return idle;
		}
		if (!d.live()) return last;
		d.refresh();
		if (step === "commit") {
			const c = result as GitCommitResult;
			last = { kind: "done", text: `Committed ${c.sha}` };
			// Committed on the default branch: no PR from it.
			if (c.branch && c.branch === d.status?.defaultBranch)
				todo = todo.filter((s) => s !== "pr");
		} else if (step === "push") {
			const p = result as GitPushResult;
			last = {
				kind: "done",
				text: p.pushed ? `Pushed to ${p.upstream}` : "Already up to date",
			};
		} else {
			const p = result as GitPrResult;
			const href = httpsOnly(p.pr.url);
			last = {
				kind: "done",
				text: p.created
					? `Created PR #${p.pr.number}`
					: `PR #${p.pr.number} is open`,
				...(href ? { href } : {}),
			};
		}
		// Another machine: each later step is its own passkey check, and
		// this browser wants a tap to start one.
		if (d.remote && d.needsTap && i + 1 < todo.length) {
			const go = await d.waitTap({
				kind: "paused",
				step: todo[i + 1]!,
				index: i + 1,
				total: todo.length,
			});
			if (!go) return last;
		}
	}
	return last;
}
