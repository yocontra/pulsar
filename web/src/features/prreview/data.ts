/**
 * PR review reads and writes. Reads poll slowly while the page shows; each
 * write is its own acting op (Prove Human here; on another machine one
 * passkey check for exactly that write), then the review is read again.
 */
import { useQuery } from "@tanstack/react-query";
import { ApiError, api, ProveCancelled } from "../../api/client.ts";
import type {
	ChangedFile,
	GitCommentParams,
	GitReplyParams,
	GitResolveParams,
	GitReviewFile,
	GitReviewParams,
	GitReviewThread,
} from "../../api/types.ts";
import { queryClient } from "../../data/hooks.ts";
import { toast } from "../../lib/toast.ts";

const reviewKey = (id: string) => ["git", "review", id] as const;
const fileKey = (id: string, head: string | null, path: string) =>
	["git", "review", id, "file", head, path] as const;

/**
 * The review, read again on `git` notices (data/live.ts); comments and
 * threads change on GitHub, which sends no notice, so it also polls slowly.
 */
export function useReview(agentId: string) {
	return useQuery(
		{
			queryKey: reviewKey(agentId),
			queryFn: () => api.gitReview(agentId),
			refetchInterval: (q) => (q.state.error ? false : 30_000),
			staleTime: 10_000,
			retry: false,
		},
		queryClient,
	);
}

/** One file's patch; keyed by the PR's head, so new commits read again. */
export function useReviewFile(
	agentId: string,
	head: string | null,
	file: GitReviewFile,
	enabled = true,
) {
	return useQuery(
		{
			queryKey: fileKey(agentId, head, file.path),
			queryFn: () => api.gitReviewFile(agentId, file.path),
			enabled: enabled && !file.binary && !file.tooLarge,
			staleTime: Number.POSITIVE_INFINITY,
			retry: false,
		},
		queryClient,
	);
}

function refresh(agentId: string) {
	void queryClient.invalidateQueries({ queryKey: reviewKey(agentId) });
	void queryClient.invalidateQueries({ queryKey: ["git", "pr", agentId] });
}

type Writes = {
	comment: GitCommentParams;
	reply: GitReplyParams;
	resolve: GitResolveParams;
	review: GitReviewParams;
};

const DONE: Record<keyof Writes, (p: never) => string> = {
	comment: () => "Comment added",
	reply: () => "Reply added",
	resolve: (p: GitResolveParams) =>
		p.resolved ? "Thread resolved" : "Thread reopened",
	review: (p: GitReviewParams) =>
		p.event === "approve"
			? "Approved"
			: p.event === "request_changes"
				? "Changes requested"
				: "Review submitted",
};

/**
 * Runs one write; true when it went through. Errors show as a toast with
 * the server's words; a cancelled Prove Human is silent.
 */
export async function write<K extends keyof Writes>(
	agentId: string,
	what: K,
	params: Writes[K],
): Promise<boolean> {
	try {
		await api.gitAct(agentId, what, params);
		void toast(DONE[what](params as never), { tone: "success" });
		refresh(agentId);
		return true;
	} catch (e) {
		if (e instanceof ProveCancelled) return false;
		void toast("Action failed", {
			tone: "error",
			description:
				(e as Error)?.name === "NotAllowedError"
					? "The passkey check was cancelled."
					: (e as Error).message,
		});
		// The PR moved on: show what is there now.
		if (e instanceof ApiError && e.code === "git_refused") refresh(agentId);
		return false;
	}
}

/** The changes viewer's file list takes these rows. */
export function asChanged(f: GitReviewFile): ChangedFile {
	return {
		path: f.path,
		...(f.oldPath ? { oldPath: f.oldPath } : {}),
		status: f.status === "removed" ? "deleted" : f.status,
		staged: false,
		unstaged: false,
		binary: f.binary,
		added: f.tooLarge || f.binary ? null : f.added,
		removed: f.tooLarge || f.binary ? null : f.removed,
		key: f.path,
	};
}

/** Threads by file, and per file by `<side>:<line>`; outdated ones apart. */
export function threadIndex(threads: GitReviewThread[]) {
	const byFile = new Map<
		string,
		{ at: Map<string, GitReviewThread[]>; loose: GitReviewThread[] }
	>();
	for (const t of threads) {
		let f = byFile.get(t.path);
		if (!f) {
			f = { at: new Map(), loose: [] };
			byFile.set(t.path, f);
		}
		if (t.line === null) f.loose.push(t);
		else {
			const k = `${t.side}:${t.line}`;
			f.at.set(k, [...(f.at.get(k) ?? []), t]);
		}
	}
	return byFile;
}

export const openThreads = (threads: GitReviewThread[], path?: string) =>
	threads.filter((t) => !t.resolved && (path === undefined || t.path === path))
		.length;
