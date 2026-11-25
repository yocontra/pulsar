/** Reads for the changes viewer (see docs/app.md, "Changes"). */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import type { ChangedFile, ChangesMode, ChangesSummary } from "../api/types.ts";
import { keys, queryClient, useLive } from "../data/hooks.ts";

/** Polling when the stream does not keep the summary live (ms). */
const POLL_MS = 4000;

/** Current edits are enough to open Changes. The history flag keeps it
 * accessible after the worktree becomes clean. */
export function canShowChanges(summary: ChangesSummary | undefined): boolean {
	return (
		!!summary?.available && (summary.total > 0 || summary.hasChanges === true)
	);
}

/** A bounded history scan can leave the viewer available for manual use. */
export function canOpenChanges(summary: ChangesSummary | undefined): boolean {
	return (
		canShowChanges(summary) ||
		(summary?.available === true && summary.changesHistoryIncomplete === true)
	);
}

/** The worktree summary; the stream keeps the newest mounted one live. */
export function useChanges(agentId: string, mode: ChangesMode) {
	return useLive(
		{
			queryKey: keys.changes(agentId, mode),
			queryFn: () => api.changes(agentId, mode),
			poll: POLL_MS,
		},
		{ keepPrevious: true },
	);
}

function peekOptions(agentId: string) {
	return {
		queryKey: keys.changesPeek(agentId),
		queryFn: () => api.changes(agentId, "worktree"),
		staleTime: 10_000,
		retry: false,
	};
}

export async function inRepository(agentId: string) {
	return (await queryClient.fetchQuery(peekOptions(agentId))).available;
}

/** The count beside a session: worktree mode, a slow poll, no stream topic. */
export function useChangesPeek(agentId: string) {
	return useQuery(
		{
			...peekOptions(agentId),
			enabled: !!agentId,
			refetchInterval: 15_000,
		},
		queryClient,
	);
}

/**
 * One file's diff, by the summary entry's key: a change to the file
 * refetches it, while the previous diff of the same file stays on screen.
 */
export function useChangeFile(
	agentId: string,
	mode: ChangesMode,
	file: ChangedFile | null,
	enabled = true,
) {
	return useQuery(
		{
			queryKey: keys.changeFile(
				agentId,
				mode,
				file?.path ?? "",
				file?.key ?? "",
			),
			queryFn: () => api.changeFile(agentId, mode, file!.path),
			enabled: enabled && !!file,
			staleTime: Number.POSITIVE_INFINITY,
			gcTime: 60_000,
			retry: false,
			placeholderData: (prev, prevQuery) =>
				prevQuery?.queryKey[3] === file?.path
					? keepPreviousData(prev)
					: undefined,
		},
		queryClient,
	);
}
