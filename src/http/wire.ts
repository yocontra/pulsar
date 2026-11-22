/**
 * The app's HTTP API (`/api/v1`) on the wire: the one definition of every
 * request, response and SSE payload, shared by the daemon (`views.ts`,
 * `app.ts`, `events.ts`, `transport/http.ts`), the web client and the
 * development mock. Types only: this file and what it imports must stay free
 * of runtime and `node:` imports, so the browser build can compile it.
 */
import type {
	TranscriptEvent,
	TranscriptPage as TranscriptPageBase,
} from "../transcripts/types.ts";
import type {
	DeliveredMessage,
	Message,
	Priority,
	PublicAgent,
	Receipt,
	ReceiptState,
} from "../types.ts";

export type {
	NoticeColor,
	ToolDetail,
	TranscriptImage,
	TranscriptKind,
	TranscriptNotice,
	TranscriptPush,
	TranscriptRole,
	TranscriptSubtype,
	TranscriptTool,
} from "../transcripts/types.ts";
export type {
	DeliveredMessage,
	Message,
	Priority,
	PublicAgent,
	Receipt,
	ReceiptState,
	TranscriptEvent,
};

/** What a message would do to an agent: wake it, wait in its inbox, or not arrive. */
export type Wake = "wakes" | "inbox-only" | "held" | "refuses" | "queued";

/** The status the app shows: `needs-you` wins over busy/idle; `unknown` shows as idle. */
export type AgentState = "needs-you" | "busy" | "idle" | "offline";

/** Why an agent waits on the user. */
export interface NeedsYou {
	/**
	 * `approval`: a prompt pulsar relays (answerable in the app); `asked`: the
	 * agent asked the user; `terminal`: the session waits on a dialog in its
	 * own terminal that pulsar does not relay (answer it there).
	 */
	reason: "approval" | "asked" | "terminal";
	since: number;
	detail: string | null;
}

/** One agent as the app sees it: tree leaves, lists, previews, the session header. */
export interface AgentRow extends PublicAgent {
	machineId: string;
	/** Pool address: `<machineId>/<agent id>`. */
	address: string;
	state: AgentState;
	/** When `state` last changed (ms), for the busy timer. */
	stateSince: number;
	needsYou: NeedsYou | null;
	wake: Wake;
	/** The harness keeps a transcript pulsar can read. */
	hasTranscript: boolean;
	/** Stop (interrupt the current turn) can reach this agent. */
	canStop: boolean;
	/**
	 * The tmux pane it runs in (`%12`), when Pulsar started it there or was
	 * told (`agent.meta.tmux`); absent otherwise and from older daemons.
	 */
	tmux?: string;
	/**
	 * Its subagents, counted: present once Pulsar found at least one (absent
	 * from older daemons and peers, and for agents with none).
	 */
	subagents?: SubagentCounts;
}

/** What a subagent is doing: working, waiting between tasks (a teammate), or finished. */
export type SubagentState = "running" | "idle" | "done";

/**
 * How a harness runs it: a `task` (Claude's Task/Agent tool, omp's task), a
 * `teammate` (a Claude Code agent-team member), a `thread` (a Codex spawned
 * thread) or a child `session` (OpenCode).
 */
export type SubagentKind = "task" | "teammate" | "thread" | "session";

/** `AgentRow.subagents`. */
export interface SubagentCounts {
	total: number;
	running: number;
	/** Finished ones (absent from older daemons and peers). */
	done?: number;
}

/**
 * Where a message the app sends to a subagent goes: `direct` into the
 * subagent's own session (only where that was verified live), or `parent`:
 * the harness has no way in, so the app offers to send it to the parent
 * agent, naming the subagent. `note` says which, in plain words.
 */
export interface SubagentMessaging {
	mode: "direct" | "parent";
	note: string;
}

/**
 * One subagent of an agent (`GET /agents/:id/subagents`). Subagents are not
 * agents: they are never in `/agents`, the tree's counts, selectors or
 * broadcasts. Only their own id reaches them.
 */
export interface SubagentRow {
	/** `<parent id>/sub:<key>`; a remote one carries its parent's pool address. */
	id: string;
	/** The parent agent's id (the same id space as `AgentRow.id`). */
	parentId: string;
	name: string;
	harness: string;
	kind: SubagentKind;
	/** The harness's agent type (`Explore`, a Codex role), when it says. */
	agentType: string | null;
	/** What it was asked to do, one line, when the harness says. */
	description: string | null;
	state: SubagentState;
	startedAt: number;
	/** Its log's last write (ms). */
	updatedAt: number;
	finishedAt: number | null;
	/** The parent's tool call that started it (Claude's Task call id). */
	callId: string | null;
	/** Started by another subagent: that one's id. */
	parentSubId: string | null;
	hasTranscript: boolean;
	messaging: SubagentMessaging;
}

/** `GET /agents/:id/subagents` (also the `subagents` SSE payload's head). */
export interface SubagentList {
	agentId: string;
	items: SubagentRow[];
	total: number;
	running: number;
}

/** What a Stop did: stopped a turn, found none running, or cannot reach it. */
export type InterruptResult = "interrupted" | "not-running" | "unsupported";

/** `POST /agents/:id/stop`. */
export interface StopResult {
	agentId: string;
	result: InterruptResult;
	/** How it was attempted, e.g. `codex-app-server`, `extension`, `tmux-escape`. */
	via: string;
	detail?: string;
}

/**
 * How a node reaches a machine: `local` (this one), `tailnet` (a linked
 * pool node), or why a remote machine can't be reached.
 */
export type Link = "local" | "tailnet" | "asleep" | "daemon-down" | "upgrade";

/** Status counts for a group. The four buckets sum to `agents`. */
export interface Rollup {
	agents: number;
	needsYou: number;
	busy: number;
	idle: number;
	offline: number;
	/** Latest `lastSeen` in the group (ms), null when empty. */
	lastActive: number | null;
}

export type TreeGroup = "machines" | "projects";

/** Tree order: `needs` (attention first), busy first, most recent, or by name. */
export type TreeSort = "needs" | "busy" | "recent" | "name";

export type AgentSort = "attention" | "recent" | "name" | "busy";

export interface TreeNode {
	/** Opaque: pass it back to `/tree/:id/children` and in `expanded`. */
	id: string;
	kind: "machine" | "project" | "agent";
	label: string;
	/** Selector that targets every agent under this node (the scoped composer). */
	selector: string;
	machineId: string | null;
	machine: string | null;
	project: string | null;
	/** Machines: how this node reaches it. */
	link: Link | null;
	/** Machines that can't be reached: "asleep 14m", "daemon down" (federation). */
	reason?: string;
	/** Projects under a machine: how many other machines have it too (federation). */
	elsewhere?: number;
	/** Groups only. */
	rollup: Rollup | null;
	/** Direct children (projects, machines or agents); 0 for an agent. */
	childCount: number;
	/** Agents only. */
	agent: AgentRow | null;
}

export interface Page<T> {
	items: T[];
	total: number;
	nextCursor: string | null;
}

/**
 * `GET /tree`. With `expand`, also the first page of children of the named
 * nodes (`default`: this machine, and every machine when the pool is small,
 * as the app opens them on a device's first visit), so the open branches
 * paint with the top level instead of one round trip later.
 */
export interface TreePage extends Page<TreeNode> {
	expanded?: Record<string, Page<TreeNode>>;
}

/** `GET /agents`. */
export interface AgentsPage extends Page<AgentRow> {
	/** Distinct machines among all matches. */
	machines: number;
	/** Wakeability across all matches. */
	totals: Record<Wake, number>;
}

/** What this daemon serves; the app hides what is missing. */
export type Feature =
	| "tree"
	| "facets"
	| "send"
	| "events"
	| "transcripts"
	| "receipts"
	| "stop"
	| "ask"
	| "approvals"
	| "push"
	| "subagents"
	| "usage"
	/** Attachments and the composer's `@` file list. */
	| "attachments"
	/** Start agents from the app (`POST /agents/launch`, src/service/launch.ts). */
	| "launch"
	/** Commit, push and PR from the app (`/agents/:id/git/*`). */
	| "git"
	/** The issue card of an agent's GitHub issue (`/agents/:id/issue`). */
	| "issues"
	/** Message search (`GET /search/messages`); absent with PULSAR_NO_SEARCH. */
	| "search";

/** `GET /hello`. */
export interface Hello {
	version: string;
	machineId: string;
	/** This node's name, e.g. "studio". */
	machine: string;
	fedProtocol: [number, number];
	features: Feature[];
	/**
	 * The caller, when it is the human operator: login, device, and the name
	 * from Tailscale (display name, else login) that tags their messages.
	 */
	you?: { login: string; node: string; name?: string };
	/** The app's URL ("Open on phone"): the pool name later, this node now. */
	appUrl: string;
	/** Pool totals: this machine plus linked machines with agents; live agents. */
	machines: number;
	agents: number;
	/** True until the daemon has seen any agent. */
	firstRun: boolean;
	/**
	 * The passkey session this request carried, or null. User-framed sends,
	 * Stop and removing passkeys need one.
	 */
	session?: UserSessionInfo | null;
	/** This login has a passkey on this node, so a session can be started. */
	canSession?: boolean;
	/**
	 * The browser may keep its session token across reloads: true only when
	 * the calling device runs no pulsar (a phone, a tablet). On a machine with
	 * agents, a token on disk is readable by them; keep it in memory there.
	 */
	persistSession?: boolean;
}

/**
 * The app's three answers to a permission prompt, and `answer` for any
 * other interaction (the typed answer travels with it).
 */
export type ApprovalDecision =
	| "allow-once"
	| "allow-session"
	| "deny"
	| "answer";

/**
 * Where a prompt stands. `answered-locally`: someone answered on the agent's
 * own screen first. `expired`: the daemon stopped waiting; the agent's own
 * prompt decides.
 */
export type ApprovalState =
	| "pending"
	| "allowed"
	| "denied"
	| "answered-locally"
	| "expired";

/**
 * What a relayed prompt asks of the operator.
 * `permission` is a tool permission prompt (the original approvals);
 * the others carry a typed `prompt` and take a typed `answer`.
 */
export type InteractionKind =
	| "permission"
	| "question"
	| "plan"
	| "confirm"
	| "select"
	| "input";

export interface InteractionOption {
	label: string;
	description?: string;
}

/** One question of a `question` prompt (Claude's AskUserQuestion shape, generalized). */
export interface InteractionQuestion {
	/** The key of its answer (Claude: the question text; omp: the field name). */
	id: string;
	question: string;
	/** A short tag shown as a chip ("Auth method"). */
	header?: string;
	/** More than one option may be picked. */
	multiSelect: boolean;
	/** None: a free-text question. */
	options: InteractionOption[];
	/** Free text ("Other") is accepted besides the options. */
	allowOther: boolean;
	/** Multi-line free text. */
	multiline?: boolean;
	/** Hide what is typed (a password field). */
	secret?: boolean;
}

/** One way to answer a `plan` prompt. */
export interface PlanChoice {
	id: string;
	label: string;
	/** True when this choice lets the agent start (Approve, Execute). */
	approves: boolean;
	/** The choice takes feedback text (Keep planning, Refine). */
	feedback?: boolean;
}

/** The typed payload of a non-permission interaction. */
export type InteractionPrompt =
	| { kind: "question"; title?: string; questions: InteractionQuestion[] }
	| {
			kind: "plan";
			/** The plan, as Markdown (rendered, never as HTML from the agent). */
			plan: string;
			planFile?: string | null;
			choices: PlanChoice[];
	  }
	| { kind: "confirm"; title: string; message: string }
	| {
			kind: "select";
			title: string;
			options: InteractionOption[];
	  }
	| {
			kind: "input";
			title: string;
			placeholder?: string;
			prefill?: string;
			multiline?: boolean;
			secret?: boolean;
	  };

/** The operator's answer to a non-permission interaction. */
export type InteractionAnswer =
	/** Per question id: the picked labels and/or free text (one entry for single-select). */
	| { kind: "question"; answers: Record<string, string[]> }
	| { kind: "plan"; choice: string; feedback?: string }
	| { kind: "confirm"; confirmed: boolean }
	| { kind: "select"; value: string }
	| { kind: "input"; value: string }
	/** Dismissed without an answer (the agent hears "declined"). */
	| { kind: "cancel" };

/** A prompt relayed from a harness (the `approvals` feature): a permission prompt or another interaction. */
export interface Approval {
	requestId: string;
	/** "permission" when absent (nodes before interactions). */
	kind?: InteractionKind;
	/** The typed prompt; absent for a permission prompt. */
	prompt?: InteractionPrompt;
	/** The app's answer, once answered there. */
	answer?: InteractionAnswer;
	/** Shown only: the harness takes the answer on its own screen (Codex). */
	readOnly?: true;
	/** The agent that asks. */
	agentId: string;
	/** The machine it runs on (where "Answered on <machine>" happened). */
	machine: string;
	tool: string;
	/** Exact tool input; the app shows whitespace/control/bidi characters. */
	input: Record<string, unknown>;
	/** sha256 of the canonical tool input (hex); the passkey challenge covers it. */
	inputHash: string;
	cwd: string | null;
	branch: string | null;
	createdAt: number;
	expiresAt: number;
	state: ApprovalState;
	/**
	 * What "Allow for session" adds, as Claude permission rules (for example
	 * `Bash(git init *)` or `directory /repo`); null when the harness offers
	 * nothing narrower than a mode change, so the app offers Allow once only.
	 */
	sessionRules: string[] | null;
	/** Once decided: "Allowed once by Ada Lovelace · Face ID on iPhone · 10:46". */
	outcome?: string;
}

/** `POST /approvals/:id/options` body: the answer the passkey will sign. */
export interface ApprovalOptionsRequest {
	decision: ApprovalDecision;
	/** With `decision: "answer"`: the answer; the challenge covers its hash. */
	answer?: InteractionAnswer;
	/**
	 * Deny only: the note to send with it. The challenge covers its sha256,
	 * and decide must carry the same note, so no relay can change it.
	 */
	note?: string;
}

/**
 * WebAuthn options as JSON (the shapes of `@simplewebauthn/browser`'s
 * `optionsJSON`). Kept loose here so this file needs no WebAuthn types.
 */
export type WebAuthnOptionsJSON = Record<string, unknown> & {
	challenge: string;
};

/**
 * `POST /approvals/:id/options`: sign `options` with the passkey, then
 * decide. `register: true`: the pool has no passkey yet; register this
 * browser's first (`/passkeys/register/*`), then ask again.
 */
export type ApprovalOptions =
	| { options: WebAuthnOptionsJSON }
	| { register: true };

/** `POST /approvals/:id/decide`. */
export interface DecideRequest {
	decision: ApprovalDecision;
	/** With `decision: "answer"`: the same answer the options were for. */
	answer?: InteractionAnswer;
	/** Deny only: told to the agent. */
	note?: string;
	/**
	 * The browser's `startAuthentication` result. Absent for a prompt on this
	 * machine decided with the request's passkey session instead (then
	 * `inputHash`, and for "allow-session" `sessionRules`, are required).
	 */
	assertion?: Record<string, unknown>;
	/** Session decisions: the `inputHash` of the card the operator answered. */
	inputHash?: string;
	/** Session decisions, "allow-session": the rules the card listed. */
	sessionRules?: string[] | null;
}

/** The decision's result. `won: false`: another answer came first; `approval` shows it. */
export interface DecideResponse {
	won: boolean;
	approval: Approval;
}

/**
 * `POST /passkeys/register/options`. Any device of the operator's (a known
 * Tailscale identity) may register a platform passkey with user verification.
 */
export interface PasskeyRegisterOptionsRequest {
	/** "iPhone", "Mac": shown in outcomes and `pulsar passkeys`. */
	label: string;
}

export interface PasskeyRegisterOptions {
	options: WebAuthnOptionsJSON;
}

/** `POST /passkeys/register/verify`. */
export interface PasskeyRegisterVerifyRequest {
	/** The browser's `startRegistration` result. */
	response: Record<string, unknown>;
}

export interface PasskeyInfo {
	id: string;
	label: string;
	createdAt: number;
	lastUsedAt: number | null;
}

/** `GET /passkeys`. */
export interface PasskeyList {
	items: PasskeyInfo[];
}

/** A security-relevant change or a lost answer, shown in every open tab (SSE `security`). */
export interface SecurityNotice {
	kind:
		| "passkey-added"
		| "passkey-removed"
		| "enrollment"
		| "push-subscribed"
		/** `pulsar mesh allow|deny|forget|owner` changed who is in the pool. */
		| "pool-changed"
		/** A node claimed a machine id bound to another node; refused. */
		| "pool-conflict"
		/** A known node answered with a new machine id (reinstalled?); accepted. */
		| "pool-reinstall"
		/**
		 * The app's answer to a relayed prompt (OpenCode) did not reach the
		 * harness: it still waits, and the card is shown again.
		 */
		| "reply-failed";
	/** "New passkey 'iPhone' added on studio". */
	message: string;
	node: string;
	at: number;
}

/** `GET /push/key`: the node's VAPID public key (base64url, uncompressed P-256). */
export interface PushKey {
	publicKey: string;
}

/** `POST /push/subscribe`: the browser's `PushSubscription.toJSON()`. */
export interface PushSubscribeRequest {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

/** How an agent's turn ended: on its own, or with an error from the harness. */
export type TurnKind = "finished" | "failed";

/** Finish and fail notifications on one device: Settings' "Agent activity" select. */
export type TurnNotifyMode = "off" | "notify" | "sound" | "both";

/**
 * `POST /push/settings`: read (no fields) or change this browser's
 * finish/fail settings, kept with its subscription (`endpoint`). Without a
 * subscription only the browser keeps them.
 */
export interface PushSettingsRequest {
	endpoint: string;
	turns?: TurnNotifyMode;
	inApp?: boolean;
}

export interface PushSettings {
	/** False when this node holds no subscription for `endpoint`. */
	subscribed: boolean;
	/**
	 * False until this browser sent its choice (a new subscription): no
	 * finish/fail pushes until then. The app sends what this device chose.
	 */
	chosen: boolean;
	turns: TurnNotifyMode;
	inApp: boolean;
}

/**
 * What a push carries: no agent names, tools or arguments (they would pass
 * through Apple's or Google's push service). The app fetches details.
 */
export type PushPayload =
	| {
			kind: "approval";
			/** The approval's request id (opaque). */
			id: string;
			/** A question, plan or dialog rather than a permission prompt. */
			interaction?: true;
			/** Agents waiting on the user now (the app badge). */
			badge: number;
	  }
	/** A passkey or enrollment change: the app's settings say what (no details here). */
	| { kind: "security"; badge: number }
	/**
	 * An agent the operator recently acted on finished its turn or stopped
	 * with an error. `ref`: an opaque token for that agent on this node
	 * (an agent id can hold a session name); `GET /push/turns/:ref` gives
	 * the agent's id to open.
	 */
	| {
			kind: "finished" | "failed";
			ref: string;
			/** Play the notification's sound ("Notifications with sound"). */
			sound?: true;
	  }
	/** A plan usage limit passed a threshold (`level`, a percent) or was reached. */
	| { kind: "limit"; level: number; reached?: true };

/** `GET /attention` items: who waits on the user, approvals first, newest first. */
export interface AttentionItem {
	/** Stable while the wait lasts: `<address>@<since>`. */
	id: string;
	kind: NeedsYou["reason"];
	agent: AgentRow;
	/** "Approval", or the question. */
	title: string;
	createdAt: number;
	/** The prompt's details; only with the `approvals` feature. */
	approval?: Approval;
	/**
	 * `terminal` items of this machine's agents: why the prompt is answered
	 * only in the terminal. Absent for agents on other machines.
	 */
	terminal?: TerminalPrompt;
}

/**
 * A prompt only the agent's own terminal can answer, shown read-only.
 * `expired`: the app's time to answer ran out (`approval` is that prompt,
 * no longer answerable); `not-sent`: the prompt never reached the app.
 */
export interface TerminalPrompt {
	why: "expired" | "not-sent";
	approval?: Approval;
}

export interface AttentionList {
	items: AttentionItem[];
	total: number;
}

export type FacetKey =
	| "machine"
	| "project"
	| "harness"
	| "model"
	| "branch"
	| "status"
	| "pr"
	| "role"
	| "tag";

export interface FacetValue {
	value: string;
	count: number;
	/** The selector term that picks this value. */
	term: string;
}

export interface Facet {
	values: FacetValue[];
	/** Values beyond `top`. */
	more: number;
}

/** `GET /facets?facet=`: one facet. Without `facet`: `facets` holds all of them. */
export type FacetsResponse =
	| ({ total: number; facet: FacetKey } & Facet)
	| { total: number; facets: Record<FacetKey, Facet> };

/** `GET /search`. */
export interface SearchResponse {
	machines: { id: string; machineId: string; name: string; agents: number }[];
	projects: { id: string; name: string; agents: number; machines: number }[];
	agents: AgentRow[];
	tags: { tag: string; count: number; term: string }[];
}

/** Who wrote a message hit: the operator, the agent, another agent, or a tool call's title. */
export type MessageHitRole = "user" | "agent" | "peer" | "tool";

/** One transcript event that matched `GET /search/messages`. */
export interface MessageHit {
	/** The agent (a pool address for another machine's agent). */
	agentId: string;
	/** The event's id in the agent's transcript. */
	eventId: string;
	/** When it was written (ms). */
	ts: number;
	role: MessageHitRole;
	/** Who sent a peer message. */
	from?: string;
	/** Plain text around the match; mark `marks` ([start, end) into it) yourself. */
	snippet: string;
	marks: [number, number][];
	/** A transcript page cursor whose page holds the event; null: one of the newest pages. */
	cursor: string | null;
	/** Higher first; comparable across machines. */
	score: number;
}

/**
 * `GET /search/messages?q=`: transcript messages with every word of `q` (the
 * last word may be a prefix). Needs a word of at least 3 letters, else no
 * hits. `agents` has a row for every agent a hit names. With `agent=<id>`
 * (the find bar): only that agent's hits, oldest first, up to `limit` (200),
 * searched on its home machine.
 */
export interface MessageSearchResponse {
	q: string;
	hits: MessageHit[];
	agents: AgentRow[];
	/** Machines that did not answer in time. */
	partial?: true;
	missing?: string[];
}

/** `POST /send`: `to` (a selector) or `ids` (agent ids), not both. */
export interface SendRequest {
	to?: string;
	ids?: string[];
	body?: string;
	priority?: Priority;
	expectReply?: boolean;
	dryRun?: boolean;
	resolveToken?: string;
	/**
	 * Sending to one subagent (`ids: [<subagent id>]`) that can't receive
	 * messages: send it to its parent instead, naming the subagent (the
	 * subagent's `messaging.note` says so). Without it such a send is
	 * refused with `subagent_unreachable`.
	 */
	viaParent?: boolean;
	/**
	 * A client-chosen id for this send (the app's optimistic line). A real
	 * send repeated with the same `clientId` by the same user within 10
	 * minutes is not sent again: it returns the first send's result. A
	 * retry after a lost response therefore never sends twice. Ignored on a
	 * dry run.
	 */
	clientId?: string;
}

/** Recipients per machine, for the confirmation dialog. */
export interface MachineCount {
	machineId: string;
	machine: string;
	count: number;
}

/** A dry run: who would get it and how. Also the body of a `/send` 409. */
export interface DryRun {
	dryRun: true;
	count: number;
	machines: number;
	breakdown: MachineCount[];
	/** Predicted outcome per recipient, by wake state. */
	totals: Record<Wake, number>;
	/** Pass back on the real send; refused (409) if the match drifted. */
	resolveToken: string;
	expiresAt: number;
	/** The first recipients. */
	preview: AgentRow[];
}

/** One recipient's receipt, with where it runs and its reply. */
export interface ReceiptRow extends Receipt {
	machineId: string;
	machine: string;
	/** The recipient's harness, for its avatar (absent from older daemons). */
	harness?: string;
	/** The reply's text once the agent answered this message. */
	reply?: string;
}

/** A real send. */
export interface SendDone {
	dryRun: false;
	message: Message;
	count: number;
	totals: Partial<Record<ReceiptState, number>>;
	/** The first receipts; page the rest with `GET /messages/:id/receipts`. */
	receipts: ReceiptRow[];
}

export type SendResponse = DryRun | SendDone;

/** 409 codes from `POST /send`; each body carries a fresh dry run. */
export type ReconfirmCode = "confirm" | "drift" | "stale_token";

/** `GET /messages/:id/receipts` (also the `receipts` SSE payload). */
export interface ReceiptsPage {
	message: Message;
	totals: Partial<Record<ReceiptState, number>>;
	items: ReceiptRow[];
	total: number;
	replies: DeliveredMessage[];
	nextCursor: string | null;
}

/**
 * `GET /agents/:id/transcript?cursor=`: newest page first; pass `cursor` back
 * for older events, null once the start is reached. `available: false` means
 * the harness keeps no transcript.
 */
export interface TranscriptPage extends TranscriptPageBase {
	available: boolean;
}

/**
 * What an agent's worktree has dirty: `worktree` compares the working tree
 * (staged, unstaged and untracked) with HEAD; `base` compares it with the
 * merge base of the default branch (what the branch committed, plus dirty).
 */
export type ChangesMode = "worktree" | "base";

export type ChangeStatus =
	| "modified"
	| "added"
	| "deleted"
	| "renamed"
	| "copied"
	| "typechange"
	| "conflicted"
	| "untracked";

/** One changed file in `GET /agents/:id/changes`. Paths are relative to the repo root. */
export interface ChangedFile {
	path: string;
	/** A rename's or copy's source. */
	oldPath?: string;
	status: ChangeStatus;
	/** Worktree mode: the index has changes for it (`git add`ed). */
	staged: boolean;
	/** Worktree mode: the working tree has changes the index does not. */
	unstaged: boolean;
	binary: boolean;
	/** A symbolic link (its diff shows the link target, never what it points at). */
	symlink?: boolean;
	/** Lines added and removed; null when unknown (binary, too large). */
	added: number | null;
	removed: number | null;
	/** Changes whenever the file's diff may have: a cache key for its diff. */
	key: string;
}

/** A branch compared with another ref: commits on each side. */
export interface BranchCompare {
	ref: string;
	ahead: number;
	behind: number;
}

/** `GET /agents/:id/changes?mode=` (also the `changes` SSE payload). */
export interface ChangesSummary {
	agent: string;
	mode: ChangesMode;
	/**
	 * False when there is nothing to diff: `no_cwd` (the agent has no
	 * folder), `not_a_repo`, `git_failed` (git is missing or timed out),
	 * `unsupported` (the agent's machine runs an older pulsar), `no_base`
	 * (base mode, and no default branch was found).
	 */
	available: boolean;
	reason?: "no_cwd" | "not_a_repo" | "git_failed" | "unsupported" | "no_base";
	/** The repo's folder name. */
	repo: string | null;
	/** The worktree's root folder. */
	root: string | null;
	/** Checked-out branch; null when HEAD is detached. */
	branch: string | null;
	/** Short commit id of HEAD; null in a repo with no commits yet. */
	head: string | null;
	upstream: BranchCompare | null;
	/** The default branch the base mode compares with, when known. */
	base: (BranchCompare & { mergeBase: string | null }) | null;
	files: ChangedFile[];
	/** Changed files in all; `files` holds at most 500. */
	total: number;
	truncated: boolean;
	added: number;
	removed: number;
	/** Changes whenever anything above may have. */
	stamp: string;
}

/**
 * `GET /agents/:id/changes/file?mode=&path=`: one file's unified diff (git's
 * own, or one built for an untracked file). `patch` is null for a binary
 * file, one over 512 KB (`tooLarge`), or one that is gone.
 */
export interface FileDiff {
	path: string;
	oldPath?: string;
	status: ChangeStatus;
	binary: boolean;
	tooLarge: boolean;
	patch: string | null;
	/** The `key` of the summary entry this diff belongs to. */
	key: string;
}

// ------------------------------------------------------------ git actions

/** A pull request of the agent's branch, as `gh` reports it. */
export interface GitPr {
	number: number;
	url: string;
	title: string;
	state: "open" | "draft" | "merged" | "closed";
	base: string;
	head: string;
}

/**
 * `GET /agents/:id/git/status`: what commit, push and PR need, read from
 * the agent's worktree (and `gh` for the PR, cached). `available: false`
 * says why there is nothing to act on.
 */
export interface GitStatus {
	agent: string;
	available: boolean;
	reason?: "no_cwd" | "not_a_repo" | "git_failed" | "unsupported";
	root: string | null;
	/** Checked-out branch; null when HEAD is detached. */
	branch: string | null;
	/** Short commit id of HEAD; null in a repo with no commits. */
	head: string | null;
	/** The repo's default branch (the remote's HEAD, else main / master). */
	defaultBranch: string | null;
	onDefault: boolean;
	/** The remote a push goes to; null when the repo has none. */
	remote: string | null;
	/** The branch's upstream (`origin/feat`); null before the first push. */
	upstream: string | null;
	/**
	 * Where a push goes: the same-named branch on the push remote
	 * (`origin/feat`), whatever the upstream is. Null without a branch or
	 * a remote.
	 */
	pushTo: string | null;
	/** The upstream is set but its branch is gone (deleted after a merge). */
	upstreamGone: boolean;
	/**
	 * Commits on the branch / on `pushTo` only, when the upstream is
	 * `pushTo`; 0 otherwise (no upstream, another branch, gone).
	 */
	ahead: number;
	behind: number;
	/** Changed files (staged, unstaged, untracked). */
	dirty: number;
	/** Files with merge conflicts. */
	conflicted: number;
	/** A merge, rebase, cherry-pick or revert in progress. */
	operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
	/** The push remote is on GitHub (PRs through `gh`). */
	github: boolean;
	/** `gh` on the agent's machine; null when not asked (no GitHub remote). */
	gh: "ok" | "missing" | "logged_out" | "error" | null;
	/** The branch's PR, open or not; null when none (or `gh` can't tell). */
	pr: GitPr | null;
}

/** One CI check of a PR. */
export interface GitCheck {
	name: string;
	state: "pass" | "fail" | "pending" | "skipped";
	url: string | null;
	workflow: string | null;
}

/** A review or a review comment on a PR (text from GitHub: untrusted). */
export interface GitReviewComment {
	author: string;
	body: string;
	/** An inline comment's file and line; null for a review's summary. */
	path: string | null;
	line: number | null;
	/** A review's verdict, for a review's summary. */
	verdict?: "approved" | "changes_requested" | "commented";
	url: string | null;
	at: string | null;
}

/** `GET /agents/:id/git/pr`: the branch's PR with checks and review comments. */
export interface GitPrDetails {
	agent: string;
	pr: GitPr | null;
	/** Why there is no PR to show: no GitHub remote, gh missing or logged out. */
	reason?: "no_github" | "gh_missing" | "gh_logged_out" | "gh_error";
	message?: string;
	checks: GitCheck[];
	review: "approved" | "changes_requested" | "review_required" | null;
	comments: GitReviewComment[];
}

/** Where pulsar found the issue an agent works on. */
export type IssueSource = "tag" | "branch" | "pr" | "message";

/** One GitHub issue, as the issue card shows it (bounded; body is Markdown). */
export interface IssueInfo {
	number: number;
	title: string;
	state: "open" | "closed";
	stateReason: "completed" | "not_planned" | null;
	/** The issue's page (https only). */
	url: string | null;
	/** Label names with their hex color (no `#`), when GitHub gave one. */
	labels: { name: string; color: string | null }[];
	assignees: string[];
	author: string | null;
	/** The body's first part (Markdown); `truncated` when cut. */
	body: string;
	truncated: boolean;
	updatedAt: string | null;
}

/**
 * `GET /agents/:id/issue`: the issue the agent works on (its `issue:` tag),
 * read with gh on the agent's machine. Always 200: `reason` says why there
 * is no card.
 */
export interface IssueDetails {
	agent: string;
	/** The issue number the agent's tags name; null when none. */
	number: number | null;
	/** How it was found (absent for an older home node). */
	source?: IssueSource;
	issue: IssueInfo | null;
	reason?:
		| "no_issue"
		| "no_github"
		| "gh_missing"
		| "gh_logged_out"
		| "not_found"
		| "gh_error"
		| "unsupported";
	message?: string;
}

/**
 * `POST /agents/:id/git/commit`. Every field but `assertion` is the acting
 * op's params (a remote proof covers exactly them). `confirmBusy` and
 * `confirmDefault` say the operator confirmed a commit while the agent
 * works, or on the default branch.
 */
export interface GitCommitParams {
	/** Paths from the changes summary (a rename: both paths). */
	files: string[];
	message: string;
	/** Commit on this new branch (switched to first). */
	newBranch?: string;
	confirmBusy?: boolean;
	confirmDefault?: boolean;
}
export interface GitCommitResult {
	sha: string;
	branch: string | null;
	subject: string;
	files: number;
}

/** `POST /agents/:id/git/push`. */
export interface GitPushParams {
	confirmBusy?: boolean;
	confirmDefault?: boolean;
}
export interface GitPushResult {
	branch: string;
	remote: string;
	upstream: string;
	/** False: the upstream already had every commit. */
	pushed: boolean;
}

/** `POST /agents/:id/git/pr`: title and body default to the commits'. */
export interface GitPrParams {
	title?: string;
	body?: string;
	draft?: boolean;
}
export interface GitPrResult {
	pr: GitPr;
	/** False: the branch already had this PR. */
	created: boolean;
}

/** What a question is about (`POST /ask`), as the parser read it. */
export interface AskIntent {
	paths: string[];
	/** PR / issue numbers. */
	numbers: string[];
	branches: string[];
	projects: string[];
	machines: string[];
	/** Agent names (lowercase). */
	agents: string[];
	state: "idle" | "busy" | null;
	/** Other words, matched against branches, activity, tags and paths. */
	words: string[];
}

/** One agent that fits a question, and why. */
export interface AskMatch {
	agent: AgentRow;
	score: number;
	/** "Edited src/auth/session.ts 4m ago", "PR #1402", "branch fix-1378". */
	evidence: string[];
}

/** `POST /ask {question, selector?}`: answered from what pulsar knows; nobody is woken. */
export interface AskRequest {
	question: string;
	selector?: string;
}

export interface AskResponse {
	question: string;
	intent: AskIntent;
	matches: AskMatch[];
	/** Matches before the cut. */
	total: number;
	/** Agents considered. */
	scanned: number;
	/** Some pool machines did not answer in time (`missing` names them). */
	partial?: boolean;
	missing?: string[];
}

/**
 * A passkey session: proof (Face ID / Touch ID) that the user is at this
 * browser, for actions an agent on the same machine must not take as them.
 */
export interface UserSessionInfo {
	id: string;
	/** The passkey's device label ("iPhone", "MacBook"). */
	device: string;
	/** The tailnet node the browser runs on. */
	node: string;
	createdAt: number;
	expiresAt: number;
	lastUsedAt: number;
}

/** `POST /session/options {device}`: WebAuthn request options to sign. */
export interface SessionOptionsResponse {
	requestId: string;
	options: unknown;
}

/** `POST /session/verify {requestId, assertion}`. Send the token as `Authorization: Bearer`. */
export interface SessionVerifyResponse {
	token: string;
	session: UserSessionInfo;
}

/** `POST /passkeys/register/verify`: the new passkey, and a session (registering proves presence). */
export interface PasskeyRegisterResponse extends PasskeyInfo {
	token: string;
	session: UserSessionInfo;
}

/** `PUT /subscriptions/:streamId` replaces the stream's whole set. */
export interface Subscription {
	/** Expanded tree node ids: their children stay live. */
	expanded: string[];
	/** The visible tree: its top-level nodes' rollups stay live. */
	window: { group: TreeGroup; filter?: string } | null;
	/** The open agent: its row and its live transcript. */
	session: string | null;
	/** The broadcast builder's selector: match count, machines, wake totals. */
	query: string | null;
	/** A page of agents kept live (the builder's preview, a list view). */
	results: {
		selector: string;
		sort?: AgentSort;
		offset?: number;
		limit?: number;
	} | null;
	/** Message ids whose receipts are on screen. */
	receipts: string[];
	/** The open changes viewer: that agent's worktree changes stay live. */
	changes?: { agent: string; mode: ChangesMode } | null;
	/**
	 * Agents whose subagent lists are on screen (an expanded sidebar row, an
	 * agent page): `subagents` events keep them live. Absent: none.
	 */
	subagents?: string[];
}

/** Error bodies: `{error: {code, message}}`, plus a fresh dry run on a `/send` 409. */
export interface ApiErrorBody {
	error: { code: string; message: string };
}

/**
 * List topics send `full: true` with every item first, then `full: false`
 * with only changed `items`, the `removed` ids and the new `order`.
 */
export type ListUpdate<T> =
	| { full: true; items: T[]; total: number }
	| {
			full: false;
			items: T[];
			removed: string[];
			order: string[];
			total: number;
	  };

/**
 * SSE on `GET /events`, as `event: <name>` + `data: <json>`. Event ids are
 * `<bootId>.<streamId>.<seq>`; resume with `Last-Event-ID`. `ready` comes
 * first; `gap` means replay is gone (refetch, or for a transcript, re-page).
 */
export interface ServerEvents {
	ready: { streamId: string; bootId: string; resumed: boolean };
	/**
	 * An agent the operator recently started, messaged or opened finished
	 * its turn or stopped with an error (the in-app toast and sound).
	 */
	notify: { kind: TurnKind; agentId: string; at: number };
	/** A plan usage limit passed a warning threshold or was reached. */
	limit: LimitWarning;
	gap: {
		reason: "expired" | "overflow";
		topic?: "transcript" | "changes";
		agent?: string;
	};
	attention: AttentionList & { full: boolean };
	tree: ListUpdate<TreeNode> & { group: TreeGroup; filter: string };
	children: ListUpdate<TreeNode> & { nodeId: string; filter: string };
	agent: { id: string; agent: AgentRow | null; full: boolean };
	query: {
		selector: string;
		total: number;
		machines: number;
		totals: Record<Wake, number>;
		full: boolean;
	};
	results: {
		selector: string;
		sort: AgentSort;
		offset: number;
		limit: number;
		items: AgentRow[];
		total: number;
		machines: number;
		full: boolean;
	};
	/** `missing`: not one of the user's sends (or gone). */
	receipts: { messageId: string; full: boolean } & (
		| ReceiptsPage
		| { missing: true }
	);
	transcript: { agent: string; events: TranscriptEvent[] };
	/** The open changes viewer's worktree changed (the new summary). */
	changes: ChangesSummary;
	/** An approval appeared or changed (sent at once; also in `attention`). */
	approval: { approval: Approval };
	/** A passkey was added or removed, or an enrollment code was created. */
	security: SecurityNotice;
	/** An agent's subagents (a `subagents` subscription), as list updates. */
	subagents: ListUpdate<SubagentRow> & { agentId: string };
	/** A launch started from the app moved on (sent at once to every stream). */
	launch: LaunchState;
}

export type ServerEventName = keyof ServerEvents;

/** A parsed SSE event: its name as `type`, its payload as `data`. */
export type ServerEvent = {
	[K in ServerEventName]: { type: K; data: ServerEvents[K] };
}[ServerEventName];

/** `GET /usage` periods. */
export type UsagePeriod = "24h" | "7d" | "30d" | "90d";

/** Token counts; `input` is uncached input only. */
export interface UsageTokens {
	input: number;
	cacheRead: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
	output: number;
	/** Model responses counted. */
	records: number;
}

/** Tokens for one machine, harness and model in one hour (24h) or local day. */
export interface UsageRow extends UsageTokens {
	machine: string;
	harness: string;
	model: string;
	/** Bucket start (ms). */
	t: number;
	/** API estimate in US dollars; null when the model has no price. */
	cost: number | null;
}

/** A model price in US dollars per million tokens. */
export interface UsagePrice {
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
	source: "default" | "custom";
}

/** `GET /usage`: the pool's token usage, priced by this node. */
export interface UsageReport {
	period: UsagePeriod;
	from: number;
	to: number;
	bucket: "hour" | "day";
	rows: UsageRow[];
	/** Sessions with usage in the period, per machine and harness. */
	sessions: { machine: string; harness: string; count: number }[];
	/** Every machine asked; `error` when it did not answer. */
	machines: { id: string; name: string; error: string | null }[];
	prices: UsagePrice[];
	/** This node's last finished scan of session files (ms), null before the first. */
	scannedAt: number | null;
	scanning: boolean;
	/** Plan usage limits each machine's harnesses last reported (current windows only). */
	limits?: (LimitState & { machine: string })[];
	/** When the operator is warned about limits (this node's setting). */
	limitSettings?: LimitSettings;
}

/** `GET /agents/:id/usage`: one agent's session so far. */
export interface AgentUsage {
	agent: string;
	tokens: UsageTokens;
	cost: number | null;
	/** Tokens in the latest request; `window` when the harness reports it. */
	context: { used: number; window: number | null } | null;
	model: string | null;
	/** Its harness's plan limits on its machine (current windows only). */
	limits?: LimitState[];
}

/**
 * One plan usage limit as a harness last reported it (src/usage/limits.ts).
 * Codex reports a percentage; Claude Code, pi and omp only say when the
 * limit is reached (`usedPercent` 100, `reached`).
 */
export interface LimitState {
	harness: string;
	/** The harness's limit or provider id ("" when it names none). */
	account: string;
	/** A stable id for the window ("m10080", "seven_day", "weekly"). */
	window: string;
	/** "Weekly", "5-hour". */
	label: string;
	usedPercent: number | null;
	reached: boolean;
	/** When the window resets (ms), when known. */
	resetsAt: number | null;
	/** When the harness reported it (ms). */
	at: number;
	plan: string | null;
}

/** `GET`/`PUT /usage/limits`: every machine's current limits (last readings) and the settings. */
export interface UsageLimits {
	limits: (LimitState & { machine: string })[];
	settings: LimitSettings;
}

/** `PUT /usage/limits`: warn at these percents and when a limit is reached. */
export interface LimitSettings {
	enabled: boolean;
	/** 1 to 3 whole percents, ascending (default 80 and 95). */
	thresholds: number[];
}

/** A limit passed a threshold or was reached (SSE `limit`; Web Push has no names). */
export interface LimitWarning {
	harness: string;
	label: string;
	/** The threshold passed, or 100 when reached. */
	level: number;
	reached: boolean;
	usedPercent: number | null;
	resetsAt: number | null;
}

// ------------------------------------------------------------ attachments

/** One file the operator attaches, as the browser describes it before upload. */
export interface AttachmentFileSpec {
	name: string;
	/** The browser's media type ("" when unknown). */
	type: string;
	size: number;
	/** Hex SHA-256 of the file's bytes. */
	sha256: string;
}

/**
 * `POST /agents/:id/attachments` params, signed as one `attachments.upload`
 * act: every file of one message, so one proof covers the whole upload.
 */
export interface AttachmentManifest {
	/** Random per upload: two uploads of the same files are two acts. */
	nonce: string;
	files: AttachmentFileSpec[];
}

/** The upload the home node opened: then `PUT …/attachments/:upload/:index` per file. */
export interface AttachmentUpload {
	upload: string;
	/** Until then the upload takes bytes (ms since epoch). */
	expiresAt: number;
	files: { index: number; name: string }[];
}

/** A file saved on the agent's machine. */
export interface AttachmentSaved {
	name: string;
	/** Sniffed for images; else the browser's type. */
	type: string;
	size: number;
	/** Absolute path on the agent's machine. */
	path: string;
}

/** The answer to one `PUT …/attachments/:upload/:index`. */
export interface AttachmentPut {
	received: number;
	file: AttachmentSaved;
}

/** One `@` menu row: a tracked or untracked file, or a folder, relative to the agent's folder. */
export interface FileHit {
	path: string;
	kind: "file" | "dir";
}

/** `GET /agents/:id/files?q=`. */
export interface FileSearch {
	agent: string;
	available: boolean;
	/** Why there is no list (`no_cwd`, `not_git`, `unavailable`, `unsupported`). */
	reason?: string;
	items: FileHit[];
	/** The folder holds more files than are searched. */
	truncated?: boolean;
}

/** One row of the file viewer's folder listing. */
export interface FileEntry {
	/** The file or folder name. */
	name: string;
	/** Relative to the agent's folder. */
	path: string;
	kind: "file" | "dir";
}

/**
 * `GET /agents/:id/files/tree?path=`: one folder of the agent's folder
 * (`path` empty: its top). Files git ignores are left out, unless the
 * folder itself is ignored or not in a repo (then it is read as it is).
 */
export interface FileTree {
	agent: string;
	path: string;
	available: boolean;
	/** `no_cwd`, `not_found` (no such folder in it), `unavailable`, `unsupported`. */
	reason?: string;
	entries: FileEntry[];
	/** More entries than are listed. */
	truncated?: boolean;
}

/**
 * `GET /agents/:id/files/content?path=`: one file of the agent's folder.
 * `text` up to 1 MB (`truncated` past it); an image's bytes come from the
 * same route with `raw=1`. A secret-looking file (`.env`, keys) is
 * `sensitive` until asked with `reveal=1`.
 */
export interface FileContent {
	agent: string;
	path: string;
	available: boolean;
	/** `no_cwd`, `not_found`, `not_file`, `refused` (in `.git`), `unavailable`, `unsupported`. */
	reason?: string;
	/** `sensitive`: the name looks like a secret; ask again with `reveal=1` to show it. */
	kind?: "text" | "image" | "binary" | "too_large" | "sensitive";
	/** Bytes on disk. */
	size?: number;
	text?: string;
	truncated?: boolean;
	/** An image's type: png, jpeg, gif or webp. */
	mediaType?: string;
	/** The path from the git worktree's top (what Changes lists); null outside a repo. */
	repoPath?: string | null;
}

// ------------------------------------------------------------------ launch

/** Harnesses the app can start (src/service/launch.ts has their fixed commands). */
export type LaunchHarness = "claude" | "codex" | "opencode" | "pi" | "omp";

/**
 * `POST /agents/launch` params, signed as they are (the acting challenge
 * covers a digest of exactly this object). `nonce`: the client's id for one
 * press of Send, so a repeat starts nothing new.
 */
export interface LaunchParams {
	nonce: string;
	/** An absolute folder on that machine (`~/` is its home). */
	cwd: string;
	harness: LaunchHarness;
	/** `worktree`: a new git worktree next to the repo, on a new branch. */
	workspace: "current" | "worktree";
	/** The new branch (worktree only); Pulsar names one when absent. */
	branch?: string;
	/** What the new branch starts from (worktree only); HEAD when absent. */
	base?: string;
	/** The first message, sent once the agent is ready. */
	prompt?: string;
	/** The agent's name in Pulsar. */
	name?: string;
}

/** `POST /agents/launch` body. */
export interface LaunchRequest {
	/** Another machine (id or name); absent: this one. */
	machine?: string;
	params: LaunchParams;
	/** On another machine: the passkey assertion over its challenge. */
	assertion?: unknown;
}

export type LaunchStep =
	| "worktree"
	| "starting"
	| "waiting"
	/** A dialog in the agent's own terminal (folder trust): answer it there. */
	| "terminal"
	| "sending"
	| "done"
	| "failed";

/** One launch, as `POST /agents/launch`, `GET /launches/:id` and the `launch` event show it. */
export interface LaunchState {
	/** On another machine: `<machineId>/<id>`. */
	id: string;
	machineId: string;
	machine: string;
	harness: LaunchHarness;
	/** The folder the agent runs in (the new worktree's, when one was made). */
	cwd: string;
	branch: string | null;
	step: LaunchStep;
	/** The terminal's dialog, or how far a step got. */
	detail: string | null;
	/** Why it failed (`step: "failed"`). */
	error: string | null;
	/** The agent once it showed up (a pool address on another machine). */
	agentId: string | null;
	/** It runs in this tmux session (`tmux attach -t <session>` on that machine). */
	session: string | null;
	/** A first message was given, and whether it went out. */
	prompt: boolean;
	sent: boolean;
	startedAt: number;
	updatedAt: number;
}

/** One folder agents ran in on a machine (`GET /machines/:m/projects`). */
export interface LaunchProject {
	path: string;
	name: string;
	/** Live agents there now. */
	agents: number;
	lastSeen: number;
}

/** `GET /machines/:m/projects`: where and what that machine can start. */
export interface LaunchOptions {
	machineId: string;
	machine: string;
	/** Its home folder (`~`). */
	home: string;
	projects: LaunchProject[];
	harnesses: { id: LaunchHarness; label: string; installed: boolean }[];
	/**
	 * False while the login shell is still looking (a slow rc file): then
	 * `installed` means nothing yet. Absent from older daemons.
	 */
	checked?: boolean;
}

/** `GET /machines/:m/refs?cwd=`: branches to start a worktree from. */
export interface LaunchRefs {
	/** The repo's top folder; null when `cwd` is not in a git repo. */
	root: string | null;
	/** The checked-out branch (null: detached or no repo). */
	current: string | null;
	branches: { name: string; remote: boolean }[];
}
