import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ANTIGRAVITY_HOOK_GROUP = "pulsar-native-wake";
export const ANTIGRAVITY_HOOK_MARKER = " hook antigravity-session";
export const ANTIGRAVITY_HOOK_EVENTS = [
	"SessionStart",
	"PreInvocation",
] as const;
const MAX_CONFIG_BYTES = 256 * 1024;

export function antigravityHookPath() {
	return join(homedir(), ".gemini", "config", "hooks.json");
}

const shellQuote = (text: string) =>
	/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;

export function antigravityHookCommand(node: string, cli: string) {
	return `exec ${shellQuote(node)} ${shellQuote(cli)}${ANTIGRAVITY_HOOK_MARKER}`;
}

type HookConfig = { revision: string; installed: boolean; stamp: string };

export async function antigravityHookConfig(
	path = antigravityHookPath(),
	command = antigravityHookCommand(
		process.execPath,
		resolve(process.argv[1] ?? ""),
	),
	previous?: HookConfig | null,
): Promise<HookConfig | null> {
	try {
		const canonical = await realpath(path);
		const before = await stat(canonical, { bigint: true });
		if (!before.isFile() || before.size > MAX_CONFIG_BYTES) return null;
		const stamp = `${canonical}\0${before.dev}:${before.ino}:${before.ctimeNs}`;
		if (previous?.stamp === stamp) return previous;
		const file = await open(
			canonical,
			constants.O_RDONLY | constants.O_NONBLOCK,
		);
		try {
			const bytes = Buffer.alloc(Number(before.size) + 1);
			const { bytesRead } = await file.read(bytes);
			const after = await file.stat({ bigint: true });
			if (
				!after.isFile() ||
				before.dev !== after.dev ||
				before.ino !== after.ino ||
				BigInt(bytesRead) !== after.size ||
				before.ctimeNs !== after.ctimeNs
			)
				return null;
			const data = bytes.subarray(0, bytesRead);
			const revision = createHash("sha256")
				.update(stamp)
				.update("\0")
				.update(data)
				.digest("hex");
			let installed = false;
			try {
				const group = JSON.parse(data.toString())[ANTIGRAVITY_HOOK_GROUP];
				installed = ANTIGRAVITY_HOOK_EVENTS.every(
					(event) =>
						Array.isArray(group?.[event]) &&
						group[event].some(
							(row: { type?: unknown; command?: unknown } | null) =>
								row?.type === "command" && row.command === command,
						),
				);
			} catch {
				// Record malformed revisions for invalidation, but never trust them.
			}
			return { revision, installed, stamp };
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}
