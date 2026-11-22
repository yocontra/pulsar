/**
 * File paths an agent writes as markdown links (`[compare](/Users/…/x.html)`,
 * `[x](./src/a.ts)`, `file:///…`). They are not web pages: a plain link would
 * resolve against the app's origin and navigate the app to a bogus URL. They
 * render as a file reference instead: a click opens the file in the Changes
 * view when the agent changed it, else copies the path.
 */
import { createContext, type ReactNode, useContext } from "react";
import type { ChangesSummary } from "../api/types.ts";
import { keys } from "../data/keys.ts";
import { queryClient } from "../data/runtime.ts";
import { navigate } from "../lib/router.ts";
import { toast } from "../lib/toast.ts";

/** The agent whose transcript is on screen (its folder resolves relative paths). */
export const FileRefAgent = createContext<{
	id?: string;
	cwd?: string | null;
} | null>(null);

/** Whether a link target is a file path (absolute, relative or file:), not a web URL. */
export function isFileHref(href: string): boolean {
	if (/^file:/i.test(href)) return true;
	// A scheme (https:, mailto:, javascript:…) or a protocol-relative URL is not a path.
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return false;
	return href !== "" && !href.startsWith("#") && !href.startsWith("?");
}

/** The path a file link names: file: URLs decoded, a `#L10` or `?x` suffix dropped. */
export function filePath(href: string): string {
	if (/^file:/i.test(href)) {
		try {
			return decodeURIComponent(new URL(href).pathname);
		} catch {
			return href.replace(/^file:\/*/i, "/");
		}
	}
	const bare = href.replace(/[?#].*$/, "");
	try {
		return decodeURIComponent(bare);
	} catch {
		return bare;
	}
}

/** An absolute path: relative ones resolve against the agent's folder. */
export function resolvePath(path: string, cwd: string | null | undefined) {
	if (path.startsWith("/") || path.startsWith("~") || !cwd) return path;
	const parts = cwd.replace(/\/+$/, "").split("/");
	for (const p of path.split("/")) {
		if (p === "" || p === ".") continue;
		if (p === "..") parts.length > 1 && parts.pop();
		else parts.push(p);
	}
	return parts.join("/") || "/";
}

/** The path relative to the agent's worktree when the Changes view lists it. */
export function changedFile(
	path: string,
	summary: Pick<ChangesSummary, "root" | "files"> | undefined,
): string | null {
	const root = summary?.root?.replace(/\/+$/, "");
	if (!root || !path.startsWith(`${root}/`)) return null;
	const rel = path.slice(root.length + 1);
	return summary!.files.some((f) => f.path === rel) ? rel : null;
}

function summaryOf(agentId: string): ChangesSummary | undefined {
	return (
		queryClient.getQueryData<ChangesSummary>(keys.changesPeek(agentId)) ??
		queryClient.getQueryData<ChangesSummary>(keys.changes(agentId, "worktree"))
	);
}

export function FileRef({
	path,
	children,
}: {
	path: string;
	children?: ReactNode;
}) {
	const agent = useContext(FileRefAgent);
	const abs = resolvePath(path, agent?.cwd);
	const id = agent?.id;
	const rel = id ? changedFile(abs, summaryOf(id)) : null;
	return (
		<button
			type="button"
			className="file-ref"
			title={rel ? `Open ${rel} in Changes` : `Copy ${abs}`}
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				if (id && rel) {
					navigate({ view: "changes", id, file: rel });
					return;
				}
				void navigator.clipboard
					?.writeText(abs)
					.then(() => toast("Path copied", { tone: "success" }))
					.catch(() => toast("Couldn't copy the path", { tone: "error" }));
			}}
		>
			{children}
		</button>
	);
}
