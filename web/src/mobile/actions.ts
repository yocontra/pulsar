/**
 * Row and agent actions shared by swipe actions, long-press menus and page
 * toolbars. Menus are Ionic action sheets (loaded lazily).
 */
import type { AgentRow, TreeNode } from "../api/types.ts";
import { issueOf, showIssue } from "../features/issues/open.ts";
import { fileRoute } from "../lib/file-links.ts";
import { tagValue } from "../lib/format.ts";
import { branchLink, prLink, repoLink } from "../lib/links.ts";
import { navigate } from "../lib/router.ts";
import { agentNode, showToast, togglePin } from "../lib/store.ts";
import { canStop, isPinned, messageGroup } from "./nav-actions.ts";
import { harnessName } from "./rows.tsx";

export {
	canStop,
	isPinned,
	messageGroup,
	openApproval,
	openNeeds,
} from "./nav-actions.ts";

import { type ActionButton, showActions } from "./ui/actions.ts";

/**
 * Stop is not optimistic (the turn may be over, Face ID may be cancelled):
 * a toast says "Stopping…" at once, then what the daemon answered.
 */
export async function stopAgent(a: AgentRow) {
	// Stays up until the answer replaces it (a slow daemon, a passkey prompt).
	showToast(`Stopping ${a.name}'s turn…`, "ok", 0);
	try {
		const { stopAgentTurn } = await import("../data/index.ts");
		const r = await stopAgentTurn(a);
		if (r.result === "interrupted") showToast(`Stopped ${a.name}'s turn`);
		else if (r.result === "not-running")
			showToast(`${a.name} wasn't running a turn`);
		else
			showToast(
				`Couldn't stop ${a.name}${r.detail ? `: ${r.detail}` : ""}`,
				"warn",
			);
	} catch (e) {
		showToast(`Couldn't stop ${a.name}: ${(e as Error).message}`, "warn");
	}
}

/** Ask before stopping: an action sheet with a destructive button. */
export async function confirmStop(a: AgentRow) {
	await showActions({
		header: `Stop ${a.name}'s turn?`,
		subHeader: "The agent stops what it's doing now. Its session stays open.",
		buttons: [
			{
				text: "Stop Turn",
				role: "destructive",
				handler: () => void stopAgent(a),
			},
			{ text: "Cancel", role: "cancel" as const },
		],
	});
}

async function copy(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text);
		showToast(`Copied ${what}`);
	} catch {
		showToast(`Couldn't copy ${what}`, "warn");
	}
}

/**
 * Opens a repo, branch or PR page outside the app: a new browser tab, or
 * the system browser from the installed app. Called straight from the tap,
 * so no popup blocker steps in.
 */
function openExternal(url: string) {
	window.open(url, "_blank", "noopener,noreferrer");
}

/** What an agent action does, for its icon in the ••• menu (AgentPage). */
export type ActionId =
	| "files"
	| "pr"
	| "branch"
	| "repo"
	| "issue"
	| "pin"
	| "unpin"
	| "mode"
	| "copy"
	| "stop";
export type AgentButton = ActionButton & { kind: ActionId };

/** "Open Pull Request #n", "Open Branch", "Open Repository", for what's known. */
function linkButtons(a: AgentRow) {
	const pr = tagValue(a.tags, "pr");
	const links: [ActionId, string, string | null][] = [
		["pr", `Open Pull Request #${pr}`, prLink(a.repoUrl, pr)],
		["branch", "Open Branch", branchLink(a.repoUrl, a.branch)],
		["repo", "Open Repository", repoLink(a.repoUrl)],
	];
	return links
		.filter((l): l is [ActionId, string, string] => l[2] !== null)
		.map(([kind, text, url]) => ({
			kind,
			text,
			handler: () => openExternal(url),
		}));
}

/** Harnesses with modes Pulsar can switch (src/service/controls.ts MODES). */
const MODE_HARNESSES = new Set(["claude", "codex", "opencode", "omp"]);

/** Long-press menu for an agent. */
export async function agentMenu(a: AgentRow) {
	const inRepo =
		a.repoUrl || issueOf(a)
			? await import("../changes/data.ts")
					.then(({ inRepository }) => inRepository(a.id))
					.catch(() => false)
			: false;
	await showActions({
		header: a.name,
		subHeader: [harnessName(a.harness), a.machine, a.project]
			.filter(Boolean)
			.join(" · "),
		buttons: [
			{
				text: "Open Conversation",
				handler: () => navigate({ view: "agent", id: a.id }),
			},
			...agentButtons(a, !!inRepo),
			{ text: "Cancel", role: "cancel" as const },
		],
	});
}

/**
 * An agent's actions after "Open Conversation" (the agent page's ••• menu
 * lists these): files, links, issue, pin, copy, stop.
 */
export function agentButtons(a: AgentRow, inRepo: boolean): AgentButton[] {
	const node = agentNode(a.id);
	const pinned = node ? isPinned(node.id) : false;
	return [
		// The file viewer (features/files), for an agent with a folder.
		...(a.cwd && !a.id.includes("/sub:")
			? [
					{
						kind: "files" as const,
						text: "Files",
						handler: () => navigate(fileRoute(a.id, "")),
					},
				]
			: []),
		...(inRepo ? linkButtons(a) : []),
		...(inRepo && issueOf(a)
			? [
					{
						kind: "issue" as const,
						text: `Issue #${issueOf(a)}`,
						handler: () => showIssue(a.id),
					},
				]
			: []),
		...(node
			? [
					{
						kind: pinned ? ("unpin" as const) : ("pin" as const),
						text: pinned ? "Unpin" : "Pin",
						handler: () => togglePin(node),
					},
				]
			: []),
		// Plan mode and the like (features/slash), where the harness has modes.
		...(MODE_HARNESSES.has(a.harness) && !a.id.includes("/sub:")
			? [
					{
						kind: "mode" as const,
						text: "Mode…",
						handler: () =>
							void import("../features/slash/data.ts").then((m) =>
								m.chooseMode(a),
							),
					},
				]
			: []),
		{
			kind: "copy" as const,
			text: "Copy Name",
			handler: () => void copy(a.name, "name"),
		},
		...(canStop(a)
			? [
					{
						kind: "stop" as const,
						text: "Stop Turn…",
						role: "destructive" as const,
						handler: () => void confirmStop(a),
					},
				]
			: []),
	];
}

/** Long-press menu for a machine or project. */
export async function groupMenu(n: TreeNode) {
	const pinned = isPinned(n.id);
	await showActions({
		header: n.label,
		subHeader: n.kind === "machine" ? "Machine" : "Project",
		buttons: [
			{
				text: `Message Everyone on ${n.label}`,
				handler: () => messageGroup(n),
			},
			{ text: pinned ? "Unpin" : "Pin", handler: () => togglePin(n) },
			{ text: "Cancel", role: "cancel" as const },
		],
	});
}
