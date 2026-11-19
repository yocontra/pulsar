/**
 * Reads and the action runner for the git actions. One runner per agent
 * header: it walks the steps of an action (commit → push → PR), each its
 * own acting op with its own proof, and reports progress in place. On
 * another machine every step needs a passkey check; when the browser
 * refuses a prompt that no tap started (iOS), the runner pauses and the
 * operator taps to confirm the next step.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, ProveCancelled } from "../../api/client.ts";
import type {
	AgentRow,
	GitCommitParams,
	GitCommitResult,
	GitPrResult,
	GitPushResult,
	GitStatus,
} from "../../api/types.ts";
import { keys, queryClient } from "../../data/hooks.ts";
import { toast } from "../../lib/toast.ts";
import { type Step, working } from "./model.ts";

const gitKey = (id: string) => ["git", "status", id] as const;
const prKey = (id: string) => ["git", "pr", id] as const;

/** The worktree's git status: a slow poll while the header shows. */
export function useGitStatus(agentId: string) {
	return useQuery(
		{
			queryKey: gitKey(agentId),
			queryFn: () => api.gitStatus(agentId),
			refetchInterval: 15_000,
			staleTime: 5_000,
			retry: false,
		},
		queryClient,
	);
}

/** The PR card's details, only while it is open. */
export function usePrDetails(agentId: string, open: boolean) {
	return useQuery(
		{
			queryKey: prKey(agentId),
			queryFn: () => api.gitPr(agentId),
			enabled: open,
			refetchInterval: open ? 30_000 : false,
			staleTime: 10_000,
			retry: false,
		},
		queryClient,
	);
}

/** Re-read what a git action changed. */
export function refreshGit(agentId: string) {
	for (const key of [
		gitKey(agentId),
		prKey(agentId),
		keys.changesPeek(agentId),
		keys.changes(agentId, "worktree"),
		keys.changes(agentId, "base"),
	])
		void queryClient.invalidateQueries({ queryKey: key });
}

export const STEP_LABEL: Record<Step, string> = {
	commit: "Committing",
	push: "Pushing",
	pr: "Creating PR",
};
const STEP_NAME: Record<Step, string> = {
	commit: "commit",
	push: "push",
	pr: "PR",
};

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

export interface Confirm {
	title: string;
	body: string;
	ok: string;
	resolve: (ok: boolean) => void;
}

/** The commit dialog's answer: params for git.commit (without the confirms). */
export type CommitChoice = Pick<
	GitCommitParams,
	"files" | "message" | "newBranch" | "confirmDefault"
>;

const DONE_MS = 6000;

export function useGitRunner(agent: AgentRow, status: GitStatus | undefined) {
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const [confirm, setConfirm] = useState<Confirm | null>(null);
	/** Steps to run after the commit dialog (open while set). */
	const [commitThen, setCommitThen] = useState<Step[] | null>(null);
	const resume = useRef<(() => void) | null>(null);
	const live = useRef(true);
	useEffect(
		() => () => {
			live.current = false;
		},
		[],
	);
	useEffect(() => {
		if (phase.kind !== "done") return;
		const t = setTimeout(() => setPhase({ kind: "idle" }), DONE_MS);
		return () => clearTimeout(t);
	}, [phase]);

	const ask = (c: Omit<Confirm, "resolve">) =>
		new Promise<boolean>((resolve) =>
			setConfirm({
				...c,
				resolve: (ok) => {
					setConfirm(null);
					resolve(ok);
				},
			}),
		);

	const askBusy = (what: string) =>
		ask({
			title: `${agent.name} is working`,
			body: `It may be changing files right now. ${what} anyway?`,
			ok: `${what} anyway`,
		});

	const askDefault = (branch: string) =>
		ask({
			title: "Run on the default branch?",
			body: `This pushes straight to ${branch}.`,
			ok: `Push to ${branch}`,
		});

	/** Runs steps in order; the commit's params come from the dialog. */
	async function run(steps: Step[], commit?: CommitChoice) {
		const remote = agent.id.includes("/");
		const flags = { busy: false, onDefault: !!commit?.confirmDefault };
		if (working(agent)) {
			const verb =
				steps[0] === "commit" ? "Commit" : steps[0] === "push" ? "Push" : "";
			if (verb && !(await askBusy(verb))) return;
			flags.busy = !!verb;
		}
		if (
			steps[0] === "push" &&
			status?.onDefault &&
			!(await askDefault(status.branch ?? "the default branch"))
		)
			return;
		if (steps[0] === "push" && status?.onDefault) flags.onDefault = true;
		let todo = [...steps];
		let last: Phase = { kind: "idle" };
		for (let i = 0; i < todo.length; i++) {
			const step = todo[i]!;
			const params =
				step === "commit"
					? {
							files: commit!.files,
							message: commit!.message,
							...(commit!.newBranch ? { newBranch: commit!.newBranch } : {}),
							...(flags.busy ? { confirmBusy: true } : {}),
							...(commit!.confirmDefault ? { confirmDefault: true } : {}),
						}
					: step === "push"
						? {
								...(flags.busy ? { confirmBusy: true } : {}),
								...(flags.onDefault ? { confirmDefault: true } : {}),
							}
						: {};
			setPhase({
				kind: "running",
				step,
				index: i,
				total: todo.length,
				since: Date.now(),
			});
			let result: unknown;
			try {
				result = await api.gitAct(agent.id, step, params);
			} catch (e) {
				if (!live.current) return;
				refreshGit(agent.id);
				if (e instanceof ProveCancelled) {
					setPhase({ kind: "idle" });
					return;
				}
				// A race with the status we showed: confirm now, then retry.
				if (e instanceof ApiError && e.code === "confirm_busy") {
					if (!(await askBusy(step === "commit" ? "Commit" : "Push")))
						return setPhase({ kind: "idle" });
					flags.busy = true;
					i--;
					continue;
				}
				if (e instanceof ApiError && e.code === "confirm_default") {
					if (!(await askDefault(status?.branch ?? "the default branch")))
						return setPhase({ kind: "idle" });
					flags.onDefault = true;
					if (commit) commit = { ...commit, confirmDefault: true };
					i--;
					continue;
				}
				// The browser refused a passkey prompt no tap started: wait for one.
				if (remote && i > 0 && (e as Error).name === "NotAllowedError") {
					setPhase({ kind: "paused", step, index: i, total: todo.length });
					const go = await new Promise<boolean>((r) => {
						resume.current = () => r(true);
						cancelPaused.current = () => r(false);
					});
					resume.current = null;
					if (!go) return setPhase({ kind: "idle" });
					i--;
					continue;
				}
				setPhase({ kind: "idle" });
				void toast("Action failed", {
					tone: "error",
					description:
						(e as Error).name === "NotAllowedError"
							? "The passkey check was cancelled."
							: (e as Error).message,
				});
				return;
			}
			if (!live.current) return;
			refreshGit(agent.id);
			if (step === "commit") {
				const c = result as GitCommitResult;
				last = { kind: "done", text: `Committed ${c.sha}` };
				// Committed on the default branch: no PR from it.
				if (c.branch && c.branch === status?.defaultBranch)
					todo = todo.filter((s) => s !== "pr");
			} else if (step === "push") {
				const p = result as GitPushResult;
				last = {
					kind: "done",
					text: p.pushed ? `Pushed to ${p.upstream}` : "Already up to date",
				};
			} else {
				const p = result as GitPrResult;
				last = {
					kind: "done",
					text: p.created
						? `Created PR #${p.pr.number}`
						: `PR #${p.pr.number} is open`,
					href: p.pr.url,
				};
			}
			// Another machine: each step after the first is its own passkey
			// check; give the operator the tap that starts it.
			if (remote && i + 1 < todo.length && needsTap()) {
				setPhase({
					kind: "paused",
					step: todo[i + 1]!,
					index: i + 1,
					total: todo.length,
				});
				const go = await new Promise<boolean>((r) => {
					resume.current = () => r(true);
					cancelPaused.current = () => r(false);
				});
				resume.current = null;
				if (!go) return setPhase(last);
			}
		}
		setPhase(last);
	}
	const cancelPaused = useRef<(() => void) | null>(null);

	return {
		phase,
		confirm,
		commitThen,
		/** Starts an action: the commit dialog first when it commits. */
		start(steps: Step[]) {
			if (phase.kind === "running" || phase.kind === "paused") return;
			if (steps[0] === "commit") setCommitThen(steps.slice(1));
			else void run(steps);
		},
		/** The commit dialog's Commit. */
		commit(choice: CommitChoice) {
			const then = commitThen ?? [];
			setCommitThen(null);
			void run(["commit", ...then], choice);
		},
		closeCommit() {
			setCommitThen(null);
		},
		/** The paused step's tap. */
		resume() {
			resume.current?.();
		},
		cancel() {
			cancelPaused.current?.();
		},
		stepName: STEP_NAME,
	};
}

/**
 * iOS and Safari want a tap for each passkey prompt; other browsers run
 * the next step at once (and still pause if the prompt is refused).
 */
function needsTap(): boolean {
	const ua = navigator.userAgent;
	return (
		/iPhone|iPad|iPod/.test(ua) ||
		(/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua))
	);
}

export type GitRunner = ReturnType<typeof useGitRunner>;
