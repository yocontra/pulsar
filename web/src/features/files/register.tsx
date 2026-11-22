/**
 * The file viewer: its page (`#/file/<agent>?path=<path>`) and the desktop
 * session header's Files button. Metadata and lazy chunks only (this file
 * is in the first load). Path links in transcripts open it too
 * (session/file-ref.tsx).
 */
import { FolderTreeIcon } from "lucide-react";
import { fileRoute } from "../../lib/file-links.ts";
import { lazy } from "../../lib/lazy.tsx";
import {
	type PageProps,
	registerPage,
	registerSlot,
	type SlotProps,
} from "../../lib/registry.tsx";
import { navigate } from "../../lib/router.ts";

const FilesDesktop = lazy<PageProps>(() => import("./FilesPage.tsx"));
const FilesPhone = lazy<PageProps>(() =>
	import("./FilesPage.tsx").then((m) => ({ default: m.FilesPhone })),
);

registerPage({ name: "file", desktop: FilesDesktop, phone: FilesPhone });

registerSlot("session.header", {
	id: "files",
	component: ({ agent, mobile }: SlotProps["session.header"]) =>
		!mobile && agent.cwd && !agent.id.includes("/sub:") ? (
			<button
				type="button"
				className="d-btn ghost sm icon"
				aria-label="Files"
				title="Files"
				onMouseEnter={() => void FilesDesktop.preload()}
				onClick={() => navigate(fileRoute(agent.id, ""))}
			>
				<FolderTreeIcon />
			</button>
		) : null,
});
