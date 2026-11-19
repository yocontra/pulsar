/**
 * The last screen this device showed (hello, the machine tree and its open
 * branches, needs-you, recently active), kept in localStorage so a revisit
 * paints rows at once, before the network answers (stale-while-revalidate:
 * the live reads replace it as they land). Small and per device: never
 * transcripts, never approval payloads (tool input), never the passkey
 * session; dropped on a wrong-account answer. It only paints: actions
 * always go to the daemon.
 */
import type { AgentRow, AttentionItem, Hello, TreeNode } from "../api/types.ts";

export interface SnapshotBranch {
	ids: string[];
	nextCursor: string | null;
	total: number;
}

export interface Snapshot {
	v: 1;
	at: number;
	sort: string;
	hello: Hello;
	attention: AttentionItem[];
	recent: AgentRow[];
	nodes: TreeNode[];
	/** By branch id ("" is the top level). */
	branches: Record<string, SnapshotBranch>;
}

const KEY = "pulsar.snapshot";
/** Older than this, a snapshot is not worth painting. */
const MAX_AGE_MS = 7 * 24 * 3600_000;
const MAX_BYTES = 200_000;

export function readSnapshot(sort: string, now = Date.now()): Snapshot | null {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return null;
		const s = JSON.parse(raw) as Snapshot;
		if (
			s?.v !== 1 ||
			s.sort !== sort ||
			typeof s.at !== "number" ||
			now - s.at > MAX_AGE_MS ||
			!s.hello ||
			!Array.isArray(s.nodes) ||
			!s.branches?.[""]
		)
			return null;
		return s;
	} catch {
		return null;
	}
}

/** Only what paints: no approval payloads, no session. */
export function makeSnapshot(
	input: Omit<Snapshot, "v" | "at">,
	now = Date.now(),
): Snapshot | null {
	const h = input.hello;
	if (h.firstRun || h.agents === 0) return null;
	const { session: _session, ...hello } = h;
	return {
		v: 1,
		at: now,
		sort: input.sort,
		hello: hello as Hello,
		attention: input.attention.map(({ approval: _a, ...item }) => item),
		recent: input.recent,
		nodes: input.nodes,
		branches: input.branches,
	};
}

export function writeSnapshot(s: Snapshot | null) {
	try {
		if (!s) return localStorage.removeItem(KEY);
		const raw = JSON.stringify(s);
		if (raw.length <= MAX_BYTES) localStorage.setItem(KEY, raw);
		else localStorage.removeItem(KEY);
	} catch {}
}

export function clearSnapshot() {
	writeSnapshot(null);
}
