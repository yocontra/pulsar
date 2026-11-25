import { basename } from "node:path";
import { processSnapshot } from "../processes.ts";
import { opencodeGet, opencodeServiceRunning } from "./opencode-api.ts";
import type { HarnessIdent } from "./types.ts";

/** OpenCode process matching and per-call sessions (see claude-ident.ts for why apart). */

/** `_meta` key OpenCode uses to say which of its sessions made a tool call. */
const SESSION_KEY = "ai.opencode/sessionID";

export { opencodeServiceRunning } from "./opencode-api.ts";

export interface OpencodeSessionIdentity {
	id: string;
	cwd: string | null;
	parentId: string | null;
	title: string | null;
}

const SESSION_ID = /^[A-Za-z0-9._-]{1,100}$/;

/** Identity looked up through the existing local OpenCode service. */
export async function opencodeSessionIdentity(
	sessionId: string,
): Promise<OpencodeSessionIdentity | null> {
	if (!SESSION_ID.test(sessionId)) return null;
	const table = await processSnapshot(2000, "user");
	if (!opencodeServiceRunning(table)) return null;
	type Info = {
		id?: unknown;
		directory?: unknown;
		location?: { directory?: unknown };
		parentID?: unknown;
		title?: unknown;
	};
	const info = await opencodeGet<Info>(
		table,
		`/api/session/${encodeURIComponent(sessionId)}`,
		{ lane: "user", timeoutMs: 5000 },
	);
	if (info?.id !== sessionId) return null;
	const parentId = info.parentID;
	if (
		parentId != null &&
		(typeof parentId !== "string" ||
			!SESSION_ID.test(parentId) ||
			parentId === sessionId)
	)
		return null;
	const cwd = info.location?.directory ?? info.directory;
	return {
		id: sessionId,
		cwd: typeof cwd === "string" && cwd.startsWith("/") ? cwd : null,
		parentId: parentId ?? null,
		title:
			typeof info.title === "string" ? info.title.slice(0, 80) || null : null,
	};
}

export const opencodeIdent = {
	id: "opencode",
	label: "OpenCode",

	matchProcess(args) {
		const exe = basename(args.split(/\s+/)[0] ?? "").toLowerCase();
		return exe === "opencode" || exe.startsWith("opencode-");
	},

	async identify({ sessionId, env }) {
		return { sessionId: sessionId ?? env.OPENCODE_SESSION_ID ?? null };
	},

	// One MCP process serves every OpenCode session and names it in `_meta`.
	toolSessions: {
		sessionId(meta) {
			const id = meta?.[SESSION_KEY];
			return typeof id === "string" && SESSION_ID.test(id) ? id : null;
		},
		cwd: async (id) => (await opencodeSessionIdentity(id))?.cwd ?? null,
	},
} satisfies HarnessIdent;
