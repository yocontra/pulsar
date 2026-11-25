/**
 * The file viewer (`#/file/<agent>?path=<path>&line=<n>`): read-only files of
 * an agent's folder. Desktop: the main pane, a folder tree beside the open
 * file. Phone: a pushed page per folder or file. Text is highlighted (no
 * highlighting past 256 KB), images are shown, other files are described.
 * "Copy path" copies the full path; "Open in Changes" shows when the file
 * has uncommitted changes.
 */
import { useQuery } from "@tanstack/react-query";
import {
	ChevronRightIcon,
	CopyIcon,
	FileDiffIcon,
	FileIcon,
	FolderIcon,
	XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import type { AgentRow, FileContent, FileEntry } from "../../api/types.ts";
import { useChangesPeek } from "../../changes/data.ts";
import { queryClient, useLiveEvent } from "../../data/hooks.ts";
import { useAgent } from "../../data/index.ts";
import { humanSize as formatBytes } from "../../lib/attachments.ts";
import { fileRoute } from "../../lib/file-links.ts";
import type { PageProps } from "../../lib/registry.tsx";
import { backBy, navigate, stack } from "../../lib/router.ts";
import { findAgent } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import { useGitStatus } from "../git/run.ts";
import { FileReader } from "./FileReader.tsx";
import { moveFileFocus } from "./file-keys.ts";
import "./files.css";

/**
 * Fallback re-read of the open folder and file (ms). `git` notices cover
 * what git sees (tracked and untracked files); ignored files (build output)
 * send none.
 */
const POLL_MS = 30_000;

/**
 * Keeps the open folder and file live: the agent's git status is watched
 * (its `git` subscription), and each `git` notice for the agent re-reads
 * what is shown.
 */
function useLiveFiles(agentId: string) {
	useGitStatus(agentId);
	useLiveEvent("git", (e) => {
		if (e.agentId !== agentId) return;
		void queryClient.invalidateQueries({
			predicate: (q) => q.queryKey[0] === "files" && q.queryKey[2] === agentId,
		});
	});
}

export const useTree = (agentId: string, path: string, enabled = true) =>
	useQuery(
		{
			queryKey: ["files", "tree", agentId, path],
			queryFn: ({ signal }) => api.fileTree(agentId, path, signal),
			enabled,
			staleTime: 5_000,
			refetchInterval: POLL_MS,
			retry: false,
		},
		queryClient,
	);

const useContent = (agentId: string, path: string, reveal: boolean) =>
	useQuery(
		{
			queryKey: ["files", "content", agentId, path, reveal],
			queryFn: ({ signal }) => api.fileContent(agentId, path, signal, reveal),
			enabled: !!path,
			staleTime: 5_000,
			refetchInterval: POLL_MS,
			// A shown secret is not kept once its page closes.
			...(reveal ? { gcTime: 0 } : {}),
			retry: false,
		},
		queryClient,
	);

/** What the route names: the agent, the path, and the line to show. */
export function useTarget({ arg, params }: PageProps) {
	const agentId = arg;
	const path = (params.path ?? "").replace(/^\/+|\/+$/g, "");
	const n = Number(params.line);
	const line = Number.isSafeInteger(n) && n > 0 ? n : undefined;
	const agent = useAgent(agentId || null).data as AgentRow | undefined;
	useLiveFiles(agentId);
	// Show for a secret-looking file: this file only, until the page changes.
	const [shown, setShown] = useState<string | null>(null);
	const key = `${agentId}\u0000${path}`;
	const content = useContent(agentId, path, shown === key);
	const reveal = () => setShown(key);
	// Leaving the file hides it again (the desktop page stays mounted).
	useEffect(() => () => setShown(null), [key]);
	// A path that is a folder: list it.
	const isDir =
		!path ||
		(content.data?.available === false && content.data.reason === "not_file");
	return { agentId, path, line, agent, content, isDir, reveal };
}

export const nameOf = (p: string) => p.split("/").pop() ?? p;

export function fullPath(agent: AgentRow | undefined, path: string): string {
	const cwd = agent?.cwd?.replace(/\/+$/, "");
	if (!cwd) return path;
	return path ? `${cwd}/${path}` : cwd;
}

/** Copies a path and says so. */
export async function copyPath(path: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(path);
		toast("Path copied", { tone: "success", description: path });
	} catch {
		toast("Couldn't copy the path", { tone: "error" });
	}
}

export function unavailableText(reason: string | undefined): string {
	switch (reason) {
		case "no_cwd":
			return "This agent has no folder.";
		case "refused":
			return "Files in .git aren't shown.";
		case "unsupported":
			return "That machine runs an older Pulsar. Update it to browse files.";
		case "unavailable":
			return "Couldn't read this folder. Try again.";
		default:
			return "This file isn't in the agent's folder.";
	}
}

// ------------------------------------------------------------------ pieces

/** The path as links: the agent's folder name, then each folder. */
export function Breadcrumb({
	agentId,
	agent,
	path,
	replace,
}: {
	agentId: string;
	agent: AgentRow | undefined;
	path: string;
	replace: boolean;
}) {
	const segs = path ? path.split("/") : [];
	const top =
		agent?.cwd?.split("/").filter(Boolean).pop() ??
		findAgent(agentId)?.name ??
		"Folder";
	return (
		<nav className="fv-crumbs" aria-label="Path">
			<button
				type="button"
				className="fv-crumb"
				onClick={() => navigate(fileRoute(agentId, ""), { replace })}
			>
				{top}
			</button>
			{segs.map((s, i) => {
				const to = segs.slice(0, i + 1).join("/");
				const last = i === segs.length - 1;
				return (
					<span key={to} className="fv-crumb-step">
						<ChevronRightIcon aria-hidden="true" />
						{last ? (
							<span className="fv-crumb is-current" aria-current="page">
								{s}
							</span>
						) : (
							<button
								type="button"
								className="fv-crumb"
								onClick={() => navigate(fileRoute(agentId, to), { replace })}
							>
								{s}
							</button>
						)}
					</span>
				);
			})}
		</nav>
	);
}

export function CloseFileViewer({ agentId }: { agentId: string }) {
	function close() {
		const pages = stack.value;
		const origin = pages.findLastIndex(
			(r) => r.view !== "page" || r.name !== "file" || r.arg !== agentId,
		);
		if (origin > 0) backBy(pages.length - 1 - origin);
		else navigate({ view: "agent", id: agentId }, { replace: true });
	}
	return (
		<button
			type="button"
			className="fv-btn fv-close"
			onClick={close}
			aria-label="Close file viewer"
			title="Close file viewer"
		>
			<XIcon aria-hidden="true" />
		</button>
	);
}

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
				<button
					type="button"
					className="fv-btn"
					onClick={() =>
						navigate({ view: "changes", id: agentId, file: repoPath })
					}
				>
					<FileDiffIcon aria-hidden="true" />
					Open in Changes
				</button>
			)}
			<button
				type="button"
				className="fv-btn"
				onClick={() => void copyPath(fullPath(agent, path))}
			>
				<CopyIcon aria-hidden="true" />
				Copy path
			</button>
		</div>
	);
}

/** One folder's entries; a click opens a folder or file. */
function FolderList({
	agentId,
	path,
	replace,
}: {
	agentId: string;
	path: string;
	replace: boolean;
}) {
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
			<ul
				className="fv-list"
				aria-label="Files"
				onKeyDown={(e) => moveFileFocus(e, ".fv-row")}
			>
				{t.entries.map((e) => (
					<li key={e.path}>
						<button
							type="button"
							className="fv-row"
							onClick={() => navigate(fileRoute(agentId, e.path), { replace })}
						>
							<EntryIcon e={e} />
							<span className="fv-row-name">{e.name}</span>
						</button>
					</li>
				))}
			</ul>
			{t.truncated && (
				<p className="fv-more">Showing the first {t.entries.length} entries.</p>
			)}
		</>
	);
}

export const EntryIcon = ({ e }: { e: FileEntry }) =>
	e.kind === "dir" ? (
		<FolderIcon aria-hidden="true" className="fv-icon is-dir" />
	) : (
		<FileIcon aria-hidden="true" className="fv-icon" />
	);

/** An image file's bytes as a blob: URL (they need this tab's headers). */
function ImageView({ agentId, path }: { agentId: string; path: string }) {
	const [src, setSrc] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		setSrc(null);
		setFailed(false);
		const ac = new AbortController();
		let url: string | null = null;
		api
			.fileImage(agentId, path, ac.signal)
			.then((b) => {
				url = URL.createObjectURL(b);
				setSrc(url);
			})
			.catch((e) => {
				if ((e as Error).name !== "AbortError") setFailed(true);
			});
		return () => {
			ac.abort();
			if (url) URL.revokeObjectURL(url);
		};
	}, [agentId, path]);
	if (failed)
		return (
			<p className="fv-empty" role="alert">
				Couldn't load this image.
			</p>
		);
	if (!src)
		return (
			<div className="fv-loading" aria-busy="true">
				<span className="fv-sr">Loading image</span>
			</div>
		);
	return (
		<div className="fv-image">
			<img src={src} alt={nameOf(path)} />
		</div>
	);
}

/** The open file: text, image, or what it is. */
export function FileBody({
	agentId,
	path,
	line,
	content,
	isError,
	onReveal,
	secret,
}: {
	agentId: string;
	path: string;
	line: number | undefined;
	content: FileContent | undefined;
	isError: boolean;
	onReveal: () => void;
	/** The phone's own Show gate (Konsta), in place of the desktop's. */
	secret?: (onReveal: () => void) => ReactNode;
}) {
	if (isError)
		return (
			<p className="fv-empty" role="alert">
				Couldn't read this file.
			</p>
		);
	if (!content)
		return (
			<div className="fv-loading" aria-busy="true">
				<span className="fv-sr">Loading file</span>
			</div>
		);
	if (!content.available)
		return (
			<p className="fv-empty" role="status">
				{unavailableText(content.reason)}
			</p>
		);
	const size = formatBytes(content.size ?? 0);
	if (content.kind === "image")
		return <ImageView agentId={agentId} path={path} />;
	if (content.kind === "binary")
		return (
			<p className="fv-empty" role="status">
				Binary file ({size}). Not shown.
			</p>
		);
	if (content.kind === "sensitive" && secret) return secret(onReveal);
	if (content.kind === "sensitive")
		return (
			<div className="fv-secret" role="status">
				<p>
					<strong>This file may hold secrets</strong> (keys, tokens or
					passwords). Showing it puts them on this screen.
				</p>
				<button type="button" className="fv-btn" onClick={onReveal}>
					Show
				</button>
			</div>
		);
	if (content.kind === "too_large")
		return (
			<p className="fv-empty" role="status">
				This image is too large to show ({size}).
			</p>
		);
	return (
		<div className="fv-text">
			{content.truncated && (
				<p className="fv-note" role="status">
					Showing the first 1 MB of {size}.
				</p>
			)}
			<FileReader
				key={`${agentId}:${path}`}
				path={path}
				text={content.text ?? ""}
				size={content.size ?? 0}
				line={line}
			/>
		</div>
	);
}

/** The desktop's folder tree: folders open in place, files open on the right. */
/**
 * A folder's entries plus the step toward the open path when the listing
 * leaves it out (git ignores it, and an agent linked to it).
 */
function withOnPath(
	entries: FileEntry[],
	folder: string,
	current: string,
	currentIsDir: boolean,
): FileEntry[] {
	const lead = folder ? `${folder}/` : "";
	if (!current?.startsWith(lead)) return entries;
	const rest = current.slice(lead.length);
	const name = rest.split("/")[0];
	if (!name || entries.some((e) => e.name === name)) return entries;
	const kind = rest.includes("/") || currentIsDir ? "dir" : "file";
	return [...entries, { name, path: lead + name, kind }];
}

function TreeFolder({
	agentId,
	path,
	current,
	currentIsDir,
	depth,
}: {
	agentId: string;
	path: string;
	current: string;
	currentIsDir: boolean;
	depth: number;
}) {
	const q = useTree(agentId, path);
	const t = q.data;
	if (!t?.available) return null;
	return (
		<ul className="fv-tree" aria-label={depth ? undefined : "Folder tree"}>
			{withOnPath(t.entries, path, current, currentIsDir).map((e) => (
				<TreeRow
					key={e.path}
					agentId={agentId}
					e={e}
					current={current}
					currentIsDir={currentIsDir}
					depth={depth}
				/>
			))}
		</ul>
	);
}

function TreeRow({
	agentId,
	e,
	current,
	currentIsDir,
	depth,
}: {
	agentId: string;
	e: FileEntry;
	current: string;
	currentIsDir: boolean;
	depth: number;
}) {
	const onPath = current === e.path || current.startsWith(`${e.path}/`);
	const [open, setOpen] = useState(onPath);
	useEffect(() => {
		if (onPath) setOpen(true);
	}, [onPath]);
	const dir = e.kind === "dir";
	return (
		<li>
			<button
				type="button"
				className={`fv-node${current === e.path ? " is-current" : ""}`}
				aria-expanded={dir ? open : undefined}
				aria-current={current === e.path ? "page" : undefined}
				style={{ paddingInlineStart: 8 + depth * 14 }}
				onClick={() => {
					if (dir) setOpen(!open);
					else navigate(fileRoute(agentId, e.path), { replace: true });
				}}
			>
				{dir ? (
					<ChevronRightIcon
						aria-hidden="true"
						className={`fv-chev${open ? " is-open" : ""}`}
					/>
				) : (
					<span className="fv-chev-gap" />
				)}
				<EntryIcon e={e} />
				<span className="fv-row-name">{e.name}</span>
			</button>
			{dir && open && (
				<TreeFolder
					agentId={agentId}
					path={e.path}
					current={current}
					currentIsDir={currentIsDir}
					depth={depth + 1}
				/>
			)}
		</li>
	);
}

// ------------------------------------------------------------------ pages

/** The desktop's main pane; the shell's Esc goes back. */
export function FilesDesktop(props: PageProps) {
	const { agentId, path, line, agent, content, isDir, reveal } =
		useTarget(props);
	return (
		<main className="fv fv-desktop" aria-label="Files">
			<header className="fv-head">
				<Breadcrumb agentId={agentId} agent={agent} path={path} replace />
				<Actions
					agentId={agentId}
					agent={agent}
					path={path}
					content={isDir ? undefined : content.data}
				/>
				<CloseFileViewer agentId={agentId} />
			</header>
			<div className="fv-split">
				<aside
					className="fv-side"
					onKeyDown={(e) => moveFileFocus(e, ".fv-node", true)}
				>
					<TreeFolder
						agentId={agentId}
						path=""
						current={path}
						currentIsDir={isDir}
						depth={0}
					/>
				</aside>
				<section className="fv-main" aria-label={isDir ? "Folder" : "File"}>
					{isDir ? (
						<FolderList agentId={agentId} path={path} replace />
					) : (
						<FileBody
							agentId={agentId}
							path={path}
							line={line}
							content={content.data}
							isError={content.isError}
							onReveal={reveal}
						/>
					)}
				</section>
			</div>
		</main>
	);
}

export default FilesDesktop;
