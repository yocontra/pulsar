import type {
	Approval,
	ApprovalDecision,
	AskRequest,
	AskResponse,
	AttachmentSaved,
	ChangesMode,
	ChangesSummary,
	DecideResponse,
	FileDiff,
	FileSearch,
	InteractionAnswer,
	Link,
	NeedsYou,
	SubagentCounts,
	SubagentList,
	Wake,
} from "../http/wire.ts";
import type { TranscriptListener } from "../transcripts/tailer.ts";
import type { MediaType } from "../transcripts/types.ts";
import type { Agent, Message, Receipt } from "../types.ts";
import type { PoolUsage } from "../usage/index.ts";
import type { ActingRelay } from "./acting.ts";
import type { Principal } from "./caller.ts";
import type { TranscriptPageResult } from "./transcripts.ts";

/**
 * The rest of the pool as this node's service sees it. Federation
 * (`src/federation/`) implements it; without it every view is local only.
 *
 * Remote agents are `Agent` records whose `id` is the pool address
 * `<machineId>/<localId>` and whose `meta` holds `machineId` and `localId`.
 * Local agent ids never contain `/`, so an id with one is never a local
 * agent. A local subagent id (`<agent id>/sub:<key>`) has one, but its
 * first part is a local agent id (`harness:…`, never a bare machine id).
 */
export interface PoolView extends ActingRelay {
	/** This node's machine id. */
	readonly machineId: string;
	/** Remote agents, including those on machines that can't be reached now. */
	agents(): Agent[];
	get(address: string): Agent | undefined;
	needsYou(address: string): NeedsYou | null;
	/** What a normal message would do, as the home node last said. */
	wake(address: string): Wake | null;
	hasTranscript(address: string): boolean;
	/** Its subagent counts, as the home node last said (absent from older nodes). */
	subagentCounts?(address: string): SubagentCounts | null;
	/** When its status last changed, as the home node said; null from older nodes. */
	statusSince(address: string): number | null;
	/** The home node can interrupt it, and it is reachable now. */
	canStop(address: string): boolean;
	/** Relayed Stop: request options from the agent's home node (a challenge for this Stop). */
	stopOptions(address: string, as: Principal): Promise<unknown>;
	/** Relayed Stop: the browser's assertion, which the home node verifies before it stops. */
	stopAgent(
		address: string,
		as: Principal,
		assertion?: unknown,
	): Promise<unknown>;
	/** Every remote machine this node knows, with how it is reached. */
	machines(): PoolMachine[];
	machine(machineId: string): PoolMachine | undefined;
	/** Bumps whenever anything above changes (live views recompute then). */
	version(): number;
	/**
	 * Hands one message for agents on one peer to the outbox. Returns each
	 * target's first receipt state and detail ("waiting, studio is offline").
	 */
	enqueue(
		machineId: string,
		message: Message,
		sender: Agent,
		fromUser: boolean,
		targets: Agent[],
	): Pick<Receipt, "state" | "detail" | "via">;
	/**
	 * Asks every reachable peer about its own agents (`act: ask`), as `as`.
	 * Machines that do not answer in time are left out (`missing`).
	 */
	ask(
		q: AskRequest,
		as?: Principal,
	): Promise<{
		answers: { machineId: string; response: AskResponse }[];
		missing: string[];
	}>;
	/** Transcripts of remote agents, read through their home node. */
	readonly transcripts: RemoteTranscripts;
	/**
	 * A remote agent's subagents, from its home node (ids are pool
	 * addresses). Absent before subagents existed; older peers answer
	 * not_found.
	 */
	subagents?(address: string, as?: Principal): Promise<SubagentList>;
	/** Worktree changes of remote agents, read through their home node. */
	readonly changes?: RemoteChanges;
	/** Attachment bytes and the `@` file list of remote agents, through their home node. */
	readonly attachments?: RemoteAttachments;
	/** Permission prompts of remote agents, decided by their home node. */
	readonly approvals: RemoteApprovals;
	/** Token usage of other machines and their agents (absent before usage existed). */
	readonly usage?: PoolUsage;
	/**
	 * The sender of a message that came from a peer (`<machineId>/<id>`), or
	 * null when the id is not such an address.
	 */
	sender(id: string, fromName: string): Agent | null;
}

export interface PoolMachine {
	machineId: string;
	name: string;
	link: Link;
	/** When `link` last changed (ms). */
	linkSince?: number;
	/** Why it can't be reached: "asleep 14m", "upgrade pulsar on studio". */
	reason?: string;
	agents: number;
}

/**
 * Prompts of agents on other machines, as their home nodes share them.
 * Ids and agent ids are pool addresses.
 */
export interface RemoteApprovals {
	approval(id: string): Approval | null;
	pendingFor(address: string): Approval[];
	/**
	 * The relayed ceremony: the prompt's home node issues request options
	 * (its own credentials, a challenge bound to the prompt and answer, for
	 * this node's exact origin)...
	 */
	options(
		as: Principal,
		id: string,
		decision: ApprovalDecision,
		note: string | null,
		answer: InteractionAnswer | null,
	): Promise<{ options: unknown } | { register: true }>;
	/** ...and verifies the browser's assertion itself, then decides (first answer wins). */
	decide(
		as: Principal,
		id: string,
		decision: ApprovalDecision,
		note: string | null,
		assertion: unknown,
		answer: InteractionAnswer | null,
	): Promise<DecideResponse>;
}

/** Transcript reads forwarded to the agent's home node, as the original user. */
export interface RemoteTranscripts {
	page(
		address: string,
		cursor: string | null,
		as?: Principal,
	): Promise<TranscriptPageResult>;
	image(
		address: string,
		imageId: string,
		as?: Principal,
	): Promise<{ mediaType: MediaType; data: Buffer }>;
	subscribe(address: string, fn: TranscriptListener): () => void;
}

/** Worktree changes read through the agent's home node, as the original user. */
export interface RemoteChanges {
	summary(
		address: string,
		mode: ChangesMode,
		as?: Principal,
	): Promise<ChangesSummary>;
	file(
		address: string,
		mode: ChangesMode,
		path: string,
		as?: Principal,
	): Promise<FileDiff>;
	/** Live summaries while watched; returns the unsubscribe function. */
	watch(
		address: string,
		mode: ChangesMode,
		fn: (s: ChangesSummary) => void,
	): () => void;
}

/** True for a pool address (a remote agent's id). */
export function isAddress(id: string): boolean {
	return id.includes("/") && !isLocalSubagentId(id);
}

/** Marks a subagent id: `<parent id>/sub:<key>`. */
export const SUB_MARK = "/sub:";

/** `<parent>/sub:<key>` → its parts (the parent may be a pool address); null otherwise. */
export function splitSubagentId(
	id: string,
): { parentId: string; key: string } | null {
	const at = id.lastIndexOf(SUB_MARK);
	if (at <= 0) return null;
	const key = id.slice(at + SUB_MARK.length);
	if (!key || key.includes("/")) return null;
	return { parentId: id.slice(0, at), key };
}

/**
 * A local subagent id: its parent part has no `/` and names a harness
 * (`claude:…`). Machine ids are UUIDs, so a pool address's first part never
 * has a `:`.
 */
export function isLocalSubagentId(id: string): boolean {
	const parts = splitSubagentId(id);
	return Boolean(
		parts && !parts.parentId.includes("/") && parts.parentId.includes(":"),
	);
}

/** True for a remote agent record (see `PoolView`). */
export function isRemote(agent: Agent): boolean {
	return Boolean(agent.meta.machineId) && isAddress(agent.id);
}

/** `<machineId>/<localId>` → its parts; null for a local id. */
export function splitAddress(
	id: string,
): { machineId: string; localId: string } | null {
	if (isLocalSubagentId(id)) return null;
	const slash = id.indexOf("/");
	if (slash <= 0) return null;
	return { machineId: id.slice(0, slash), localId: id.slice(slash + 1) };
}

/**
 * Attachments and the `@` file list of agents on other machines (forwarded
 * actions to the home node, carrying the user). A chunk carries no
 * authority: it writes into an upload the home node opened after its own
 * passkey check, and must match the hashes that check signed.
 */
export interface RemoteAttachments {
	chunk(
		address: string,
		chunk: { upload: string; index: number; offset: number; data: Uint8Array },
		as: Principal,
	): Promise<{ received: number; file: AttachmentSaved | null }>;
	files(address: string, q: string, as?: Principal): Promise<FileSearch>;
}
