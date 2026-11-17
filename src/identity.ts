import { gitInfo } from "./git.ts";
import {
	driverFor,
	driverForProcess,
	extensionHostFor,
	findHarnessAncestor,
	harnessIds,
} from "./harnesses/index.ts";
import { autoTags, envTags } from "./tags.ts";
import type { Harness, Registration } from "./types.ts";

/** PULSAR_HARNESS when it names a known harness; anything else falls back to detection. */
function forcedHarness(): Harness | undefined {
	const value = process.env.PULSAR_HARNESS;
	if (!value) return undefined;
	const known = harnessIds();
	if (known.includes(value)) return value;
	// stderr only: stdout carries the MCP protocol.
	console.error(
		`pulsar: ignoring unknown PULSAR_HARNESS "${value}" (expected one of ${known.join(", ")})`,
	);
	return undefined;
}

/**
 * Works out who this MCP server (or extension) is serving: the harness, its
 * session id and folder. Runs once at start.
 */
export function detectRegistration(role: Registration["role"]): Registration {
	const cwd = process.cwd();
	const forced = forcedHarness();
	const argv = process.argv.join(" ");
	const ancestor =
		role === "extension"
			? {
					harness:
						forced ??
						driverForProcess(argv)?.id ??
						extensionHostFor(argv)?.id ??
						"unknown",
					pid: process.pid,
				}
			: findHarnessAncestor(process.pid);
	const harness: Harness =
		forced ?? ancestor?.harness ?? (role === "cli" ? "cli" : "unknown");
	const pid = ancestor?.pid ?? null;
	const meta: Record<string, string> = {};
	let sessionId: string | null = process.env.PULSAR_SESSION_ID ?? null;
	let name: string | undefined;
	let sessionCwd: string | null = cwd;

	const found = driverFor(harness)?.identify?.({
		pid,
		cwd,
		sessionId,
		env: process.env,
	});
	if (found?.sessionId !== undefined) sessionId = found.sessionId;
	if (found?.cwd !== undefined) sessionCwd = found.cwd;
	Object.assign(meta, found?.meta);
	if (process.env.PULSAR_NAME) name = process.env.PULSAR_NAME;

	const git = gitInfo(sessionCwd);
	return {
		harness,
		sessionId,
		pid,
		cwd: sessionCwd,
		project: git.project,
		branch: git.branch,
		tags: [...autoTags(harness, git), ...envTags()],
		...(name ? { name } : {}),
		meta,
		role,
	};
}
