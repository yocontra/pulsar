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
import type { AgentRow, GitStatus } from "../../api/types.ts";
import { keys, queryClient } from "../../data/hooks.ts";
import { toast } from "../../lib/toast.ts";
import { type Step, working } from "./model.ts";
import {
	type CommitChoice,
	type Failure,
	type Phase,
	runSteps,
} from "./steps.ts";

const gitKey = (id: string) => ["git", "status", id] as const;
const prKey = (id: string) => ["git", "pr", id] as const;

/** The worktree's git status: a slow poll while the header shows. */
export function useGitStatus(agentId: string) {
	return useQuery(
		{
			queryKey: gitKey(agentId),
			queryFn: () => api.gitStatus(agentId),
			// Stops on an error (the agent left; an older daemon): no failing poll.
			refetchInterval: (q) => (q.state.error ? false : 15_000),
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
			refetchInterval: (q) => (open && !q.state.error ? 30_000 : false),
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

export interface Confirm {
	title: string;
	body: string;
	ok: string;
	resolve: (ok: boolean) => void;
}

export type { CommitChoice, Phase };

const DONE_MS = 6000;

function classify(e: unknown): Failure {
	if (e instanceof ProveCancelled) return "cancelled";
	if (e instanceof ApiError && e.code === "confirm_busy") return "confirm_busy";
	if (e instanceof ApiError && e.code === "confirm_default")
		return "confirm_default";
	if ((e as Error)?.name === "NotAllowedError") return "not_allowed";
	return "other";
}

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

	const cancelPaused = useRef<(() => void) | null>(null);

	/** Runs steps in order; the commit's params come from the dialog. */
	async function run(steps: Step[], commit?: CommitChoice) {
		const end = await runSteps(steps, commit, {
			remote: agent.id.includes("/"),
			working: working(agent),
			status,
			act: (step, params) => api.gitAct(agent.id, step, params),
			classify,
			askBusy: (what) =>
				ask({
					title: `${agent.name} is working`,
					body: `It may be changing files right now. ${what} anyway?`,
					ok: `${what} anyway`,
				}),
			askDefault: (branch) =>
				ask({
					title: "Run on the default branch?",
					body: `This pushes straight to ${branch}.`,
					ok: `Push to ${branch}`,
				}),
			waitTap: (p) => {
				setPhase(p);
				return new Promise<boolean>((r) => {
					resume.current = () => r(true);
					cancelPaused.current = () => r(false);
				}).finally(() => {
					resume.current = null;
					cancelPaused.current = null;
				});
			},
			needsTap: needsTap(),
			progress: setPhase,
			refresh: () => refreshGit(agent.id),
			live: () => live.current,
			failed: (e, f) =>
				void toast("Action failed", {
					tone: "error",
					description:
						f === "not_allowed"
							? "The passkey check was cancelled."
							: (e as Error).message,
				}),
		});
		if (live.current) setPhase(end);
	}

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
