/**
 * Builtins loaded on first use. `node:crypto` alone costs about 2 MB per
 * process (OpenSSL); the MCP server, hook and extension rarely need it.
 */
export const lazyCrypto = () =>
	process.getBuiltinModule("node:crypto") as typeof import("node:crypto");

/** A compiled Bun harness cannot execute a JavaScript CLI by running itself. */
export function pulsarRuntime(
	execPath = process.execPath,
	entry = process.argv[1],
) {
	return entry && /[\\/]\$bunfs[\\/]/.test(entry) ? "node" : execPath;
}

/**
 * V8 flags the daemon starts with under Node (none under Bun). A busy
 * daemon grows V8's young generation to 16 MB per semi-space and keeps it;
 * 2 MB costs a few more (sub-millisecond) scavenges and saves ~15 MB.
 * Flags go on the command line: V8 sizes the heap before any code runs.
 */
export function daemonRuntimeFlags(runtime = process.execPath): string[] {
	const bun =
		runtime === process.execPath
			? !!process.versions.bun
			: (runtime.split(/[\\/]/).pop() ?? "").startsWith("bun");
	return bun ? [] : ["--max-semi-space-size=2"];
}
