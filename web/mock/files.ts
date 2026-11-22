/**
 * Mock file viewer reads (`GET /agents/:id/files/tree` and `/files/content`):
 * one small folder for every agent, with text (one file has uncommitted
 * changes in the apparish-auth worktree, web/mock/changes.ts), an image, a
 * binary file and a nested output folder. Same shapes and reasons as
 * src/service/files.ts.
 */
import type { FileContent, FileEntry, FileTree } from "../../src/http/wire.ts";
import { SCREENSHOT } from "./images.ts";

const REFRESH_TS = `import { Mutex } from "../util/mutex.ts";
import type { Session } from "./session.ts";

const lock = new Mutex();

/** Refreshes the session's token once, however many callers race. */
export async function refresh(session: Session): Promise<Session> {
	return lock.run(async () => {
		if (!session.expired()) return session;
		return doRefresh(session);
	});
}
`;

const SESSION_TS = `export interface Session {
	token: string;
	expiresAt: number;
	expired(): boolean;
}

export function getSession(): Session {
	return current;
}
`;

const FILES: Record<string, string | Uint8Array> = {
	"README.md": "# demo\n\nA small app for the file viewer.\n",
	"package.json": '{\n  "name": "demo",\n  "private": true\n}\n',
	"src/auth/refresh.ts": REFRESH_TS,
	"src/auth/session.ts": SESSION_TS,
	"src/util/mutex.ts": "export class Mutex {}\n",
	"out/qa/report.html":
		"<!doctype html>\n<h1>QA report</h1>\n<p>All checks passed.</p>\n",
	"docs/shot.png": SCREENSHOT,
	"bin/tool": new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 1]),
	".env.local": "API_TOKEN=mock-not-a-real-token\n",
};

const isDir = (p: string) =>
	p === "" || Object.keys(FILES).some((f) => f.startsWith(`${p}/`));

const badPath = (p: string) =>
	p.startsWith("/") ||
	p.split("/").some((s) => s === "" || s === "." || s === "..");

export function mockTree(agent: string, path: string): FileTree {
	const dir = path.replace(/\/+$/, "");
	if ((dir && badPath(dir)) || !isDir(dir))
		return {
			agent,
			path: dir,
			available: false,
			reason: "not_found",
			entries: [],
		};
	const lead = dir ? `${dir}/` : "";
	const seen = new Map<string, FileEntry>();
	for (const f of Object.keys(FILES)) {
		if (!f.startsWith(lead)) continue;
		const rest = f.slice(lead.length);
		const name = rest.split("/")[0]!;
		const kind = rest.includes("/") ? "dir" : "file";
		seen.set(name, { name, path: lead + name, kind });
	}
	const entries = [...seen.values()].sort(
		(a, b) =>
			(a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1) ||
			a.name.localeCompare(b.name),
	);
	return { agent, path: dir, available: true, entries };
}

/** Same rule as the daemon's for `.env` files (src/service/files.ts). */
const looksSecret = (p: string) =>
	/^\.env(\..+)?$/.test(p.split("/").pop() ?? "") &&
	!/\.(example|sample|template)$/.test(p);

export function mockContent(
	agent: string,
	path: string,
	reveal = false,
): FileContent {
	const none = (reason: string): FileContent => ({
		agent,
		path,
		available: false,
		reason,
	});
	if (badPath(path)) return none("not_found");
	if (path.split("/").includes(".git")) return none("refused");
	const data = FILES[path];
	if (data === undefined) return none(isDir(path) ? "not_file" : "not_found");
	const base = {
		agent,
		path,
		available: true,
		size:
			typeof data === "string"
				? new TextEncoder().encode(data).length
				: data.length,
		repoPath: path,
	};
	if (!reveal && looksSecret(path)) return { ...base, kind: "sensitive" };
	if (typeof data === "string") return { ...base, kind: "text", text: data };
	if (path.endsWith(".png"))
		return { ...base, kind: "image", mediaType: "image/png" };
	return { ...base, kind: "binary" };
}

/** An image file's bytes; null when the path is not an image. */
export function mockImage(path: string): Uint8Array | null {
	const data = FILES[path];
	return data instanceof Uint8Array && path.endsWith(".png") ? data : null;
}
