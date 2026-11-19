/**
 * omp's `xd://` devices: omp mounts tools (MCP tools, `propose`, `bash`...)
 * as virtual files. `write xd://<device>` with a JSON args object runs the
 * device, `write xd://<device>` with `?` (or nothing) and `read xd://...`
 * return its docs. Here a device write becomes the call it stands for, so it
 * reads like the same tool called directly, never as a file write.
 *
 * MCP device names are minted `mcp__<server>_<tool>` with the server
 * sanitized (`apple-mail` → `apple_mail`), so the name alone can't say where
 * the server ends. The result's `details.xdev.inner` carries the real
 * `serverName` and `mcpToolName`; until it arrives (a running call, a call
 * waiting for approval) the call shows the device name unsplit, unless an
 * earlier result in the same transcript already told which split it is.
 */
import { summarizeCall } from "../transcripts/summary.ts";
import type { ParseState } from "../transcripts/types.ts";

const PREFIX = "xd://";
const HELP = /^\s*(\?|help)?\s*$/i;
/** `state.flags` key: minted device name → its MCP server and tool. */
const SPLITS = "ompXdSplits";

const rec = (v: unknown): Record<string, unknown> | null =>
	v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
const str = (v: unknown): string | null =>
	typeof v === "string" && v ? v : null;

/** The device a path names (`xd://propose` → "propose"); null for docs topics and other paths. */
function xdDevice(path: unknown): string | null {
	if (typeof path !== "string") return null;
	const p = path.trim();
	if (p.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return null;
	const name = p.slice(PREFIX.length);
	return name && !/[/?#:]/.test(name) ? name : null;
}

/** The device's JSON args object, without omp's habitual intent field; `{ content }` when not JSON. */
function deviceArgs(content: string): Record<string, unknown> {
	try {
		const parsed = rec(JSON.parse(content));
		if (parsed) {
			const { i: _intent, ...args } = parsed;
			return args;
		}
	} catch {}
	return { content };
}

function splits(state: ParseState): Map<string, string> {
	let map = state.flags[SPLITS] as Map<string, string> | undefined;
	if (!map) state.flags[SPLITS] = map = new Map();
	return map;
}

/** A device name as a tool name: MCP devices as `mcp__<server>__<tool>` when the split is known. */
function deviceTool(state: ParseState, device: string): string {
	if (!/^mcp__/i.test(device)) return device;
	// Already `mcp__<server>__<tool>`, or a split an earlier result taught.
	if (device.slice(5).includes("__")) return device;
	return splits(state).get(device.toLowerCase()) ?? device;
}

/**
 * The call a tool call stands for: `write xd://<device>` with args becomes
 * that device's call (an MCP call, `bash`, `propose`...); a docs write
 * becomes a docs read. Null when the call is not a device write.
 */
export function xdCall(
	state: ParseState,
	name: string,
	input: unknown,
): { name: string; input: unknown } | null {
	if (name.toLowerCase() !== "write") return null;
	const args = rec(input);
	const device = xdDevice(args?.path);
	if (!device) return null;
	const content = typeof args?.content === "string" ? args.content : "";
	if (HELP.test(content))
		return { name: "read", input: { path: `${PREFIX}${device}` } };
	return { name: deviceTool(state, device), input: deviceArgs(content) };
}

/**
 * Before a device write's result is paired with its call: name the call by
 * the server and tool the result reports, and show the args omp validated.
 */
export function xdResult(
	state: ParseState,
	callId: string,
	details: unknown,
): void {
	// Only a device write's result carries `xdev`.
	const xdev = rec(rec(details)?.xdev);
	const pending = xdev ? state.calls.get(callId) : undefined;
	if (!xdev || !pending) return;
	const inner = rec(xdev.inner);
	const server = str(inner?.serverName);
	const tool = str(inner?.mcpToolName);
	const device = str(xdev.tool);
	let name = pending.name;
	if (xdev.mode === "help" && device) name = "read";
	else if (server && tool) {
		name = `mcp__${server}__${tool}`;
		if (device) splits(state).set(device.toLowerCase(), name);
	}
	const input =
		name === "read" && device
			? { path: `${PREFIX}${device}` }
			: (rec(xdev.args) ?? pending.input);
	if (name === pending.name && input === pending.input) return;
	const tool0 = pending.event.tool;
	state.calls.set(callId, {
		...pending,
		name,
		input,
		event: {
			...pending.event,
			...(tool0
				? {
						tool: {
							...tool0,
							name,
							input,
							summary: summarizeCall(name, input, state.cwd),
						},
					}
				: {}),
		},
	});
}
