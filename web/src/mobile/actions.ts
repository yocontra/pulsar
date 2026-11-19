/**
 * Row and agent actions shared by swipe actions, long-press menus and page
 * toolbars. Menus are Ionic action sheets (loaded lazily).
 */
import type { AgentRow, TreeNode } from "../api/types.ts";
import { tagValue } from "../lib/format.ts";
import { branchLink, prLink, repoLink } from "../lib/links.ts";
import { navigate } from "../lib/router.ts";
import { agentNode, showToast, togglePin } from "../lib/store.ts";
import { loadIonicLazy } from "./lazyIonic.ts";
import { canStop, isPinned, messageGroup } from "./nav-actions.ts";
import { harnessName } from "./rows.tsx";

export {
	canStop,
	isPinned,
	messageGroup,
	openApproval,
	openNeeds,
} from "./nav-actions.ts";

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
	const { actionSheetController } = await loadIonicLazy();
	const sheet = await actionSheetController.create({
		header: `Stop ${a.name}'s turn?`,
		subHeader: "The agent stops what it's doing now. Its session stays open.",
		buttons: [
			{
				text: "Stop Turn",
				role: "destructive",
				handler: () => void stopAgent(a),
			},
			{ text: "Cancel", role: "cancel" },
		],
	});
	await sheet.present();
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

/** "Open Pull Request #n", "Open Branch", "Open Repository", for what's known. */
function linkButtons(a: AgentRow) {
	const pr = tagValue(a.tags, "pr");
	const links: [string, string | null][] = [
		[`Open Pull Request #${pr}`, prLink(a.repoUrl, pr)],
		["Open Branch", branchLink(a.repoUrl, a.branch)],
		["Open Repository", repoLink(a.repoUrl)],
	];
	return links
		.filter((l): l is [string, string] => l[1] !== null)
		.map(([text, url]) => ({ text, handler: () => openExternal(url) }));
}

/** Long-press menu for an agent. */
export async function agentMenu(a: AgentRow) {
	const { actionSheetController } = await loadIonicLazy();
	const node = agentNode(a.id);
	const pinned = node ? isPinned(node.id) : false;
	const buttons = [
		{
			text: "Open Conversation",
			handler: () => navigate({ view: "agent", id: a.id }),
		},
		...linkButtons(a),
		...(node
			? [{ text: pinned ? "Unpin" : "Pin", handler: () => togglePin(node) }]
			: []),
		{ text: "Copy Name", handler: () => void copy(a.name, "name") },
		...(canStop(a)
			? [
					{
						text: "Stop Turn…",
						role: "destructive",
						handler: () => void confirmStop(a),
					},
				]
			: []),
		{ text: "Cancel", role: "cancel" },
	];
	const sheet = await actionSheetController.create({
		header: a.name,
		subHeader: [harnessName(a.harness), a.machine, a.project]
			.filter(Boolean)
			.join(" · "),
		buttons,
	});
	await sheet.present();
}

/** Long-press menu for a machine or project. */
export async function groupMenu(n: TreeNode) {
	const { actionSheetController } = await loadIonicLazy();
	const pinned = isPinned(n.id);
	const sheet = await actionSheetController.create({
		header: n.label,
		subHeader: n.kind === "machine" ? "Machine" : "Project",
		buttons: [
			{
				text: `Message Everyone on ${n.label}`,
				handler: () => messageGroup(n),
			},
			{ text: pinned ? "Unpin" : "Pin", handler: () => togglePin(n) },
			{ text: "Cancel", role: "cancel" },
		],
	});
	await sheet.present();
}
