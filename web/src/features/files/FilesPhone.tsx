/**
 * The phone's file viewer: one pushed page per folder or file
 * (`#/file/<agent>?path=<path>`), on the phone's PageShell. A folder is a
 * Konsta inset list; a file shows under Copy path / Open in Changes; a
 * secret-looking file waits behind Show. The pieces it shares with the
 * desktop live in FilesPage.tsx.
 */

import { Block, Button, List, ListItem } from "konsta/react";
import { CopyIcon, FileDiffIcon } from "lucide-react";
import type { AgentRow, FileContent } from "../../api/types.ts";
import { useChangesPeek } from "../../changes/data.ts";
import { fileRoute } from "../../lib/file-links.ts";
import type { PageProps } from "../../lib/registry.tsx";
import { navigate } from "../../lib/router.ts";
import { PageShell } from "../../mobile/ui/PageShell.tsx";
import {
	Breadcrumb,
	copyPath,
	EntryIcon,
	FileBody,
	fullPath,
	nameOf,
	unavailableText,
	useTarget,
	useTree,
} from "./FilesPage.tsx";

/** Copy path, and Open in Changes when the file has uncommitted changes. */
function Actions({
	agentId,
	agent,
	path,
	content,
}: {
	agentId: string;
	agent: AgentRow | undefined;
	path: string;
	content: FileContent | undefined;
}) {
	const changes = useChangesPeek(agentId).data;
	const repoPath = content?.available ? content.repoPath : null;
	const changed =
		!!repoPath &&
		!!changes?.available &&
		changes.files.some((f) => f.path === repoPath);
	return (
		<div className="fv-actions">
			{changed && (
				<Button
					tonal
					rounded
					small
					inline
					className="p-tonal fv-kbtn"
					onClick={() =>
						navigate({ view: "changes", id: agentId, file: repoPath })
					}
				>
					<FileDiffIcon aria-hidden="true" />
					Open in Changes
				</Button>
			)}
			<Button
				tonal
				rounded
				small
				inline
				className="p-tonal fv-kbtn"
				onClick={() => void copyPath(fullPath(agent, path))}
			>
				<CopyIcon aria-hidden="true" />
				Copy path
			</Button>
		</div>
	);
}

/** One folder's entries as an inset list; a row opens a folder or file. */
function FolderList({ agentId, path }: { agentId: string; path: string }) {
	const q = useTree(agentId, path);
	const t = q.data;
	if (q.isError)
		return (
			<p className="fv-empty" role="alert">
				Couldn't read this folder.
			</p>
		);
	if (!t)
		return (
			<div className="fv-loading" aria-busy="true">
				<span className="fv-sr">Loading folder</span>
			</div>
		);
	if (!t.available)
		return (
			<p className="fv-empty" role="status">
				{t.reason === "not_found"
					? "This folder isn't in the agent's folder."
					: unavailableText(t.reason)}
			</p>
		);
	if (!t.entries.length)
		return (
			<p className="fv-empty" role="status">
				This folder is empty.
			</p>
		);
	return (
		<>
			<List strong inset className="fv-klist" role="group" aria-label="Files">
				{t.entries.map((e) => (
					<ListItem
						key={e.path}
						link
						linkComponent="button"
						linkProps={{ type: "button" }}
						media={<EntryIcon e={e} />}
						title={e.name}
						onClick={() => navigate(fileRoute(agentId, e.path))}
					/>
				))}
			</List>
			{t.truncated && (
				<p className="fv-more">Showing the first {t.entries.length} entries.</p>
			)}
		</>
	);
}

/** Show for a file that may hold secrets: read only on this tap. */
const SecretGate = (onReveal: () => void) => (
	<Block strong inset className="fv-secret" role="status">
		<p>
			<strong>This file may hold secrets</strong> (keys, tokens or passwords).
			Showing it puts them on this screen.
		</p>
		<Button tonal rounded inline className="p-tonal fv-kbtn" onClick={onReveal}>
			Show
		</Button>
	</Block>
);

export default function FilesPhone(props: PageProps) {
	const { agentId, path, line, agent, content, isDir, reveal } =
		useTarget(props);
	const title = path
		? nameOf(path)
		: (agent?.cwd?.split("/").filter(Boolean).pop() ?? "Files");
	return (
		<PageShell
			title={title}
			route={fileRoute(agentId, path)}
			large={false}
			className="p-kit"
			testId="files-page"
		>
			<div className="fv fv-phone">
				<div className="fv-head">
					<Breadcrumb
						agentId={agentId}
						agent={agent}
						path={path}
						replace={false}
					/>
					<Actions
						agentId={agentId}
						agent={agent}
						path={path}
						content={isDir ? undefined : content.data}
					/>
				</div>
				{isDir ? (
					<FolderList agentId={agentId} path={path} />
				) : (
					<FileBody
						agentId={agentId}
						path={path}
						line={line}
						content={content.data}
						isError={content.isError}
						onReveal={reveal}
						secret={SecretGate}
					/>
				)}
			</div>
		</PageShell>
	);
}
