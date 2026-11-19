import { basename } from "node:path";
import { processSnapshot } from "../processes.ts";
import { opencodeGet, opencodeServiceRunning } from "./opencode-api.ts";
import type { HarnessIdent } from "./types.ts";

/** OpenCode process matching and per-call sessions (see claude-ident.ts for why apart). */

/** `_meta` key OpenCode uses to say which of its sessions made a tool call. */
const SESSION_KEY = "ai.opencode/sessionID";

export { opencodeServiceRunning } from "./opencode-api.ts";

/** The folder an OpenCode session works in, from its server. */
async function opencodeSessionDir(sessionId: string): Promise<string | null> {
	const table = await processSnapshot(2000, "user");
	if (!opencodeServiceRunning(table)) return null;
	type Info = { directory?: string; location?: { directory?: string } };
	const info = await opencodeGet<Info>(
		table,
		`/api/session/${encodeURIComponent(sessionId)}`,
		{ lane: "user", timeoutMs: 5000 },
	);
	return info?.location?.directory ?? info?.directory ?? null;
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
			return typeof id === "string" && id ? id : null;
		},
		cwd: opencodeSessionDir,
	},
} satisfies HarnessIdent;
