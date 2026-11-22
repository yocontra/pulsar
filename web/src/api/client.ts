import { sentence } from "../lib/format.ts";
import { shareToken } from "../prove/share.ts";
import {
	type ProveReason,
	proveHuman,
	proven,
	skipProofForSends,
	skippedForSends,
} from "../prove/state.ts";
import {
	type AgentRow,
	type AgentSort,
	type AgentsPage,
	type AgentUsage,
	API_BASE,
	API_HEADER,
	type ApiErrorBody,
	type Approval,
	type ApprovalDecision,
	type ApprovalOptions,
	type AskRequest,
	type AskResponse,
	type AttachmentManifest,
	type AttachmentPut,
	type AttachmentUpload,
	type AttentionList,
	type ChangesMode,
	type ChangesSummary,
	type DecideRequest,
	type DecideResponse,
	type DryRun,
	type FacetKey,
	type FacetsResponse,
	type FileDiff,
	type FileSearch,
	type GitPrDetails,
	type GitStatus,
	type Hello,
	type InteractionAnswer,
	type LimitSettings,
	type Page,
	type PasskeyList,
	type PasskeyRegisterOptions,
	type PasskeyRegisterOptionsRequest,
	type PasskeyRegisterResponse,
	type PushKey,
	type PushSettings,
	type PushSettingsRequest,
	type PushSubscribeRequest,
	type ReceiptsPage,
	type ReconfirmCode,
	type SearchResponse,
	type SendRequest,
	type SendResponse,
	type SendResult,
	type ServerEvent,
	type SessionOptionsResponse,
	type SessionVerifyResponse,
	type StopResult,
	type SubagentList,
	type SubagentRow,
	type Subscription,
	type TranscriptPage,
	type TreeNode,
	type TreePage,
	type TreeSort,
	type UsageLimits,
	type UsagePeriod,
	type UsagePrice,
	type UsageReport,
	type UserSessionInfo,
} from "./types.ts";

export type FailureKind = "offline" | "daemon-down" | "forbidden" | "http";

export class ApiError extends Error {
	constructor(
		readonly kind: FailureKind,
		readonly status: number,
		readonly body: ApiErrorBody | null,
	) {
		const e = body?.error;
		super(
			e?.message ? sentence(e.message) : (e?.code ?? `${kind} (${status})`),
		);
	}

	get code(): string | undefined {
		return this.body?.error?.code;
	}
}

function query(params: Record<string, string | number | null | undefined>) {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params))
		if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
	const s = q.toString();
	return s ? `?${s}` : "";
}

/**
 * The passkey session's bearer token (Face ID / Touch ID once per lifetime).
 * In memory by default. Kept in localStorage (so a reload keeps it) only on
 * the installed app (home-screen PWA) on a phone or tablet (iOS, iPadOS,
 * Android) that runs no pulsar (`/hello` says `persistSession`), never in
 * a browser tab and never on a desktop: on a computer, agents
 * may run without pulsar, and a token on disk is readable by them. The
 * daemon also refuses the token from any other tailnet node. Cookies would
 * not help: they are not scoped by port either. The daemon stores only the
 * token's hash and can revoke it.
 */
const TOKEN_KEY = "pulsar.session";
let persist = false;
let sessionToken: string | null = (() => {
	try {
		// A token an older version left on a desktop's disk goes now.
		if (!mayPersist()) {
			localStorage.removeItem(TOKEN_KEY);
			return null;
		}
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
})();
proven.value = Boolean(sessionToken);

/** The installed app (home-screen PWA) on a phone or tablet: the only place a token may persist. */
function mayPersist(): boolean {
	try {
		return mobilePlatform() && installedApp();
	} catch {
		return false;
	}
}

/** Running as an installed app (home-screen PWA), not in a browser tab. */
export function installedApp(
	w: {
		matchMedia?: (q: string) => { matches: boolean };
		navigator?: { standalone?: boolean };
	} = globalThis as never,
): boolean {
	return (
		w.matchMedia?.("(display-mode: standalone)").matches === true ||
		w.navigator?.standalone === true
	);
}

/** iOS, iPadOS (which says "Macintosh", with touch) or Android. */
export function mobilePlatform(
	nav:
		| { userAgent: string; maxTouchPoints?: number }
		| undefined = globalThis.navigator,
): boolean {
	if (!nav) return false;
	const ua = nav.userAgent;
	if (/\b(iPhone|iPad|iPod|Android)\b/.test(ua)) return true;
	return /\bMacintosh\b/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

/** Holds `token` (null: none) in memory, and on disk only where `persist` allows. */
function holdToken(token: string | null) {
	sessionToken = token;
	proven.value = Boolean(token);
	try {
		if (token && persist) localStorage.setItem(TOKEN_KEY, token);
		else localStorage.removeItem(TOKEN_KEY);
	} catch {}
}

const peerListeners = new Set<() => void>();

/** Runs `fn` when another tab hands this one a token or drops it. */
export function onPeerSession(fn: () => void): () => void {
	peerListeners.add(fn);
	return () => peerListeners.delete(fn);
}

/**
 * This browser's open tabs of the app share one session (memory to memory,
 * see `prove/share.ts`): proving in one proves them all, and a tab opened or
 * reloaded while another is open is proven at once.
 */
const shared = shareToken({
	get: () => sessionToken,
	adopt: (token) => {
		holdToken(token);
		for (const fn of peerListeners) fn();
	},
});

/** The one place this tab's token changes; every other open tab follows. */
export function setSessionToken(token: string | null) {
	const prev = sessionToken;
	holdToken(token);
	if (token !== prev) shared.announce(token, prev);
}

/** Waits (briefly) for another tab's token, so a fresh tab doesn't ask again. */
export async function sessionReady(): Promise<void> {
	if (!sessionToken) await shared.ready;
}

/** From /hello: may the token outlive a reload here? Never on a desktop. */
export function setSessionPersist(v: boolean) {
	v = v && mayPersist();
	persist = v;
	if (!v)
		try {
			// A machine with agents: never leave a token on its disk.
			localStorage.removeItem(TOKEN_KEY);
		} catch {}
	else if (sessionToken)
		try {
			localStorage.setItem(TOKEN_KEY, sessionToken);
		} catch {}
}

/** The session token each /hello response was asked with. */
const helloToken = new WeakMap<Hello, string | null>();

/**
 * Drops the token when the daemon no longer knows it (expired, revoked), so
 * the next action opens Prove Human instead of sending unverified. Only when
 * this /hello carried the token we hold now: an answer to a request sent
 * before proving finished says nothing about the new token.
 */
export function dropStaleSession(h: Hello) {
	if (!h.session && sessionToken && helloToken.get(h) === sessionToken)
		setSessionToken(null);
}

export function hasSessionToken() {
	return Boolean(sessionToken);
}

/**
 * How long to wait before trying again after a 503 (`Retry-After` in
 * seconds, else `fallback`), capped at `cap` ms.
 */
export function retryAfterMs(
	res: { headers: Headers },
	fallback: number,
	cap = 15_000,
) {
	const v = Number(res.headers.get("retry-after"));
	return Number.isFinite(v) && v > 0 ? Math.min(v * 1000, cap) : fallback;
}

/** Quiet retries of a 503 `identity_unavailable` (a slow Tailscale lookup). */
const IDENTITY_RETRIES = 3;

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			reject(new DOMException("aborted", "AbortError"));
		});
	});

/**
 * What a failed response means for the app. 403 is the wrong-account screen
 * only for `not_owner` (or an old daemon's 403 without a code); any other
 * 403 (`bad_origin`) is a plain error. A 503 `identity_unavailable` that
 * outlived its retries is a plain error too: the reads poll again, and the
 * screen never says "Wrong Tailscale account" for a slow lookup.
 */
export function failureKind(
	status: number,
	body: ApiErrorBody | null,
): FailureKind {
	const code = body?.error?.code;
	if (status === 503 && code === "identity_unavailable") return "http";
	if (status === 502 || status === 503 || status === 504) return "daemon-down";
	if (status === 403)
		return !code || code === "not_owner" ? "forbidden" : "http";
	return "http";
}

/** How long a response public/preload.js started stays usable. */
const PRELOAD_MS = 10_000;

type Preloaded = { res: Promise<Response>; at: number; token: string | null };

/**
 * The response public/preload.js started for exactly this path, once: only
 * with the session token this request would send, and while fresh.
 */
export function takePreload(
	path: string,
	token: string | null,
	now = Date.now(),
): Promise<Response> | null {
	const pending = (globalThis as { __pulsarPreload?: Map<string, Preloaded> })
		.__pulsarPreload;
	const p = pending?.get(path);
	if (!p) return null;
	pending!.delete(path);
	return p.token === token && now - p.at < PRELOAD_MS ? p.res : null;
}

/** A request to the daemon's API (`/api/v1<path>`) with this tab's session. */
export async function request<T>(
	path: string,
	init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		let res: Response;
		const preloaded =
			attempt === 0 && !init.method && init.body === undefined && !init.signal
				? // A page asked with `?stream=` takes the plain preloaded page (a
					// link opened before the stream: its subscription runs alongside).
					takePreload(path.replace(/\?stream=[^&]*$/, ""), sessionToken)
				: null;
		try {
			res = await (preloaded ??
				fetch(API_BASE + path, {
					method: init.method ?? "GET",
					headers: {
						[API_HEADER]: "1",
						...(sessionToken
							? { Authorization: `Bearer ${sessionToken}` }
							: {}),
						...(init.body !== undefined
							? { "Content-Type": "application/json" }
							: {}),
					},
					body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
					credentials: "omit",
					cache: "no-store",
					signal: init.signal,
				}));
		} catch (err) {
			if ((err as Error).name === "AbortError") throw err;
			throw new ApiError("offline", 0, null);
		}
		if (res.ok) return (await res.json()) as T;
		let body: ApiErrorBody | null = null;
		try {
			body = (await res.json()) as ApiErrorBody;
		} catch {}
		if (
			res.status === 503 &&
			body?.error?.code === "identity_unavailable" &&
			attempt < IDENTITY_RETRIES
		) {
			await sleep(retryAfterMs(res, 500 * 2 ** attempt, 5000), init.signal);
			continue;
		}
		throw new ApiError(failureKind(res.status, body), res.status, body);
	}
}

const enc = encodeURIComponent;

export const api = {
	hello: async () => {
		const sent = sessionToken;
		const h = await request<Hello>("/hello");
		helloToken.set(h, sent);
		return h;
	},
	tree: (p: {
		group: "machines" | "projects";
		filter?: string;
		sort?: TreeSort;
		cursor?: string | null;
		limit?: number;
		/** Branches to include (`default`: the first-visit expansion). */
		expand?: string | null;
	}) => request<TreePage>(`/tree${query(p)}`),
	children: (
		nodeId: string,
		p: { cursor?: string | null; filter?: string; sort?: TreeSort },
	) => request<Page<TreeNode>>(`/tree/${enc(nodeId)}/children${query(p)}`),
	attention: () => request<AttentionList>("/attention"),
	recent: () => request<{ items: AgentRow[] }>("/recent"),
	agent: (id: string) => request<AgentRow>(`/agents/${enc(id)}`),
	/** An agent's subagents (never in `/agents`). */
	subagents: (agentId: string) =>
		request<SubagentList>(`/agents/${enc(agentId)}/subagents`),
	subagent: (id: string) => request<SubagentRow>(`/subagents/${enc(id)}`),
	agents: (
		p: {
			selector?: string;
			sort?: AgentSort;
			cursor?: string | null;
			limit?: number;
		},
		signal?: AbortSignal,
	) => request<AgentsPage>(`/agents${query(p)}`, { signal }),
	facets: (
		p: { selector: string; facet: FacetKey; q?: string; top?: number },
		signal?: AbortSignal,
	) =>
		request<Extract<FacetsResponse, { facet: FacetKey }>>(
			`/facets${query(p)}`,
			{ signal },
		),
	search: (q: string, signal?: AbortSignal) =>
		request<SearchResponse>(`/search${query({ q })}`, { signal }),
	/**
	 * Dry run or send. A 409 (`confirm`, `drift`, `stale_token`) carries a
	 * fresh dry run: it comes back as a result with `reconfirm` set, so the
	 * caller shows the confirmation and resends with the new token.
	 */
	send: async (body: SendRequest): Promise<SendResult> => {
		try {
			// A real send goes out as the human operator only with a passkey
			// session: unproven, Prove Human opens first. The operator may send
			// without proof (framed as unverified) or cancel the send.
			const prove = async () => {
				const r = await proveHuman("send", { allowSkip: true });
				if (r === "cancelled") throw new SendCancelled();
				if (r === "skipped") skipProofForSends();
			};
			const post = async () =>
				normalizeSend(
					await request<SendResponse>("/send", { method: "POST", body }),
				);
			if (!body.dryRun && !sessionToken) await sessionReady();
			if (!body.dryRun && !sessionToken && !skippedForSends.peek())
				await prove();
			try {
				return await post();
			} catch (e) {
				// The proof expired or was revoked: prove again, then send.
				if (!(e instanceof ApiError) || e.code !== "session_required") throw e;
				setSessionToken(null);
				await prove();
				return await post();
			}
		} catch (err) {
			if (
				err instanceof ApiError &&
				err.status === 409 &&
				(err.code === "confirm" ||
					err.code === "drift" ||
					err.code === "stale_token")
			) {
				const r = normalizeSend(err.body as unknown as DryRun);
				return { ...r, drift: true, reconfirm: err.code as ReconfirmCode };
			}
			throw err;
		}
	},
	/** Who works on what, from what the daemon knows; wakes nobody. */
	ask: (body: AskRequest) =>
		request<AskResponse>("/ask", { method: "POST", body }),
	receipts: (messageId: string, cursor?: string | null) =>
		request<ReceiptsPage>(
			`/messages/${enc(messageId)}/receipts${query({ cursor })}`,
		),
	/** With `stream`, the daemon subscribes that event stream to the transcript first. */
	transcript: (
		agentId: string,
		cursor?: string | null,
		stream?: string | null,
	) =>
		request<TranscriptPage>(
			`/agents/${enc(agentId)}/transcript${query({ cursor, stream })}`,
		),
	/** What the agent's git worktree has dirty (the diff viewer). */
	changes: (agentId: string, mode: ChangesMode) =>
		request<ChangesSummary>(
			`/agents/${enc(agentId)}/changes${query({ mode })}`,
		),
	/** The pool's token usage, priced on this node; `refresh` reads new session lines first. */
	usage: (p: { period: UsagePeriod; tz: number; refresh?: boolean }) =>
		request<UsageReport>(
			`/usage${query({ period: p.period, tz: p.tz, refresh: p.refresh ? 1 : null })}`,
		),
	/** One agent's tokens, cost and context. */
	agentUsage: (agentId: string) =>
		request<AgentUsage>(`/agents/${enc(agentId)}/usage`),
	/** Plan usage limits (every machine's last readings) and when to warn. */
	usageLimits: () => request<UsageLimits>("/usage/limits"),
	/** Turn limit warnings on or off, or set their thresholds. */
	setUsageLimits: (change: Partial<LimitSettings>) =>
		request<UsageLimits>("/usage/limits", { method: "PUT", body: change }),
	/** Set a model's price (dollars per million tokens), or null to drop the edit. */
	setUsagePrice: (
		model: string,
		price: Omit<UsagePrice, "model" | "source"> | null,
	) =>
		request<{ prices: UsagePrice[] }>("/usage/prices", {
			method: "PUT",
			body: { model, price },
		}),
	/** One changed file's unified diff. */
	changeFile: (agentId: string, mode: ChangesMode, path: string) =>
		request<FileDiff>(
			`/agents/${enc(agentId)}/changes/file${query({ mode, path })}`,
		),
	/** What the git actions need about the agent's worktree (features/git). */
	gitStatus: (agentId: string) =>
		request<GitStatus>(`/agents/${enc(agentId)}/git/status`),
	/** The branch's PR with checks and review comments. */
	gitPr: (agentId: string) =>
		request<GitPrDetails>(`/agents/${enc(agentId)}/git/pr`),
	/**
	 * Commit, push or PR: acting ops (Prove Human here; a remote agent's
	 * machine checks one passkey assertion for exactly these params).
	 */
	gitAct: <T>(
		agentId: string,
		what: "commit" | "push" | "pr",
		params: object,
	) =>
		api.acting<T>(`git.${what}`, { agent: agentId }, params, (assertion) =>
			request<T>(`/agents/${enc(agentId)}/git/${what}`, {
				method: "POST",
				body: assertion === undefined ? params : { ...params, assertion },
			}),
		),
	/**
	 * Opens an upload of files for an agent (the `attachments.upload` act;
	 * call through `api.acting`, which passes the assertion for another
	 * machine). Then `uploadAttachment` per file.
	 */
	attachments: (
		agentId: string,
		manifest: AttachmentManifest,
		assertion?: unknown,
	) =>
		request<AttachmentUpload>(`/agents/${enc(agentId)}/attachments`, {
			method: "POST",
			body: { manifest, ...(assertion !== undefined ? { assertion } : {}) },
		}),
	/** The composer's `@` menu: files in the agent's folder. */
	files: (agentId: string, q: string, signal?: AbortSignal) =>
		request<FileSearch>(`/agents/${enc(agentId)}/files${query({ q })}`, {
			signal,
		}),
	/**
	 * Interrupt/stop an agent; only when `/hello` lists the `stop` feature. A
	 * local agent uses this node's passkey session. An agent on another
	 * machine is a relayed ceremony: its home node issues the challenge, the
	 * passkey signs here, and the home node verifies it (one Face ID per Stop).
	 */
	stop: async (agentId: string) => {
		if (!agentId.includes("/"))
			return withSession(
				() =>
					request<StopResult>(`/agents/${enc(agentId)}/stop`, {
						method: "POST",
						body: {},
					}),
				"stop",
			);
		let options: unknown;
		try {
			options = await request<unknown>(`/agents/${enc(agentId)}/stop/options`, {
				method: "POST",
				body: {},
			});
		} catch (e) {
			if (e instanceof ApiError && e.code === "no_passkey")
				throw new Error(
					"That agent's machine doesn't know this device yet. Open Pulsar on that machine and prove you're human there.",
				);
			throw e;
		}
		const { startAuthentication } = await import("@simplewebauthn/browser");
		const assertion = await startAuthentication({
			optionsJSON: options as Parameters<
				typeof startAuthentication
			>[0]["optionsJSON"],
		});
		return request<StopResult>(`/agents/${enc(agentId)}/stop`, {
			method: "POST",
			body: { assertion },
		});
	},
	/**
	 * An acting op (src/service/acting.ts: attachments, launch, git). Here:
	 * `send()` with this browser's passkey session (Prove Human first if
	 * needed). On another machine (an agent address with `/`, or a `machine`,
	 * which callers pass only for another machine): that machine issues a
	 * challenge for exactly this op, target and `params`, the passkey signs
	 * it, and `send(assertion)` makes the op's own request with it, which
	 * that machine verifies. `params` must be what the request sends.
	 */
	acting: async <T>(
		op: ActingOp,
		target: { agent?: string; machine?: string },
		params: unknown,
		send: (assertion?: unknown) => Promise<T>,
		/** What the Prove Human sheet says it is for. */
		reason: ProveReason = "act",
	): Promise<T> => {
		const remote = target.agent ? target.agent.includes("/") : !!target.machine;
		if (!remote) return withSession(() => send(), reason);
		let options: unknown;
		try {
			options = await request<unknown>("/acting/options", {
				method: "POST",
				body: { op, ...target, params },
			});
		} catch (e) {
			if (e instanceof ApiError && e.code === "no_passkey")
				throw new Error(
					"That machine doesn't know this device yet. Open Pulsar on that machine and prove you're human there.",
				);
			throw e;
		}
		const { startAuthentication } = await import("@simplewebauthn/browser");
		const assertion = await startAuthentication({
			optionsJSON: options as Parameters<
				typeof startAuthentication
			>[0]["optionsJSON"],
		});
		return send(assertion);
	},
	approval: (requestId: string) =>
		request<Approval>(`/approvals/${enc(requestId)}`),
	/** Passkey request options whose challenge covers this prompt and this answer. */
	approvalOptions: (
		requestId: string,
		decision: ApprovalDecision,
		note?: string,
		answer?: InteractionAnswer,
	) =>
		request<ApprovalOptions>(`/approvals/${enc(requestId)}/options`, {
			method: "POST",
			body: {
				decision,
				...(note ? { note } : {}),
				...(answer ? { answer } : {}),
			},
		}),
	/**
	 * Decide an approval: with a passkey assertion, or (a prompt on this
	 * machine) with this browser's passkey session plus the card's input hash
	 * and listed rules. Only with the `approvals` feature.
	 */
	decide: (requestId: string, body: DecideRequest) =>
		request<DecideResponse>(`/approvals/${enc(requestId)}/decide`, {
			method: "POST",
			body,
		}),
	passkeyRegisterOptions: (body: PasskeyRegisterOptionsRequest) =>
		request<PasskeyRegisterOptions>("/passkeys/register/options", {
			method: "POST",
			body,
		}),
	passkeys: () => request<PasskeyList>("/passkeys"),
	removePasskey: (id: string) =>
		withSession(
			() =>
				request<{ ok: boolean }>(`/passkeys/${enc(id)}/remove`, {
					method: "POST",
					body: {},
				}),
			"remove",
		),
	sessionOptions: (device: string) =>
		request<SessionOptionsResponse>("/session/options", {
			method: "POST",
			body: { device },
		}),
	sessionVerify: (requestId: string, assertion: unknown) =>
		request<SessionVerifyResponse>("/session/verify", {
			method: "POST",
			body: { requestId, assertion },
		}),
	sessions: () => request<{ sessions: UserSessionInfo[] }>("/sessions"),
	revokeSession: (id: string) =>
		request<{ ok: boolean }>(`/sessions/${enc(id)}/revoke`, {
			method: "POST",
			body: {},
		}),
	pushKey: () => request<PushKey>("/push/key"),
	/** Notifications on or off take a passkey session (Prove Human first). */
	pushSubscribe: (sub: PushSubscribeRequest) =>
		withSession(
			() =>
				request<{ ok: boolean }>("/push/subscribe", {
					method: "POST",
					body: sub,
				}),
			"notifications",
		),
	/** This browser's finish/fail settings, kept with its subscription (read when none given). */
	pushSettings: (body: PushSettingsRequest) =>
		request<PushSettings>("/push/settings", { method: "POST", body }),
	pushUnsubscribe: (endpoint: string) =>
		withSession(
			() =>
				request<{ ok: boolean }>("/push/unsubscribe", {
					method: "POST",
					body: { endpoint },
				}),
			"notifications",
		),
	/** Also starts this browser's session: registering took Face ID / Touch ID. */
	passkeyRegisterVerify: (response: Record<string, unknown>) =>
		request<PasskeyRegisterResponse>("/passkeys/register/verify", {
			method: "POST",
			body: { response },
		}),
	subscribe: (streamId: string, sub: Subscription) =>
		request<{ ok: boolean }>(`/subscriptions/${enc(streamId)}`, {
			method: "PUT",
			body: sub,
		}),
};

/**
 * Makes sure this browser holds a passkey session: unproven, the Prove
 * Human sheet opens (Face ID / Touch ID; a first passkey is made there), and
 * the caller carries on once it's done. Throws `ProveCancelled` when the
 * operator closes the sheet.
 */
export async function ensureSession(
	reason: ProveReason = "manual",
): Promise<true> {
	await sessionReady();
	if (sessionToken) return true;
	const r = await proveHuman(reason);
	if (r !== "proven" || !sessionToken) throw new ProveCancelled();
	return true;
}

/** The operator closed Prove Human: the action that needed it does not happen. */
export class ProveCancelled extends Error {
	constructor() {
		super("Not proven: nothing was done.");
		this.name = "ProveCancelled";
	}
}

/** The operator cancelled a send at Prove Human. */
export class SendCancelled extends ProveCancelled {}

/** Runs `fn` with a passkey session; asks again once if the daemon says it expired. */
/** Ops that change something on an agent's machine (src/service/authorize.ts ACTING_OPS). */
export type ActingOp =
	| "attachments.upload"
	| "agents.launch"
	| "git.commit"
	| "git.push"
	| "git.pr";

/**
 * One attached file's bytes into an open upload (`PUT`, streamed; XHR for
 * upload progress). Rejects with an ApiError like `request`.
 */
export function uploadAttachment(
	agentId: string,
	upload: string,
	index: number,
	file: Blob,
	onProgress?: (fraction: number) => void,
	signal?: AbortSignal,
): Promise<AttachmentPut> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open(
			"PUT",
			`${API_BASE}/agents/${enc(agentId)}/attachments/${enc(upload)}/${index}`,
		);
		xhr.setRequestHeader(API_HEADER, "1");
		if (sessionToken)
			xhr.setRequestHeader("Authorization", `Bearer ${sessionToken}`);
		xhr.setRequestHeader("Content-Type", "application/octet-stream");
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
		};
		xhr.onload = () => {
			let body: unknown = null;
			try {
				body = JSON.parse(xhr.responseText);
			} catch {}
			if (xhr.status >= 200 && xhr.status < 300) resolve(body as AttachmentPut);
			else
				reject(
					new ApiError(
						failureKind(xhr.status, body as ApiErrorBody | null),
						xhr.status,
						body as ApiErrorBody | null,
					),
				);
		};
		xhr.onerror = () => reject(new ApiError("offline", 0, null));
		xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
		signal?.addEventListener("abort", () => xhr.abort(), { once: true });
		xhr.send(file);
	});
}

async function withSession<T>(
	fn: () => Promise<T>,
	reason: ProveReason = "manual",
): Promise<T> {
	await ensureSession(reason);
	try {
		return await fn();
	} catch (e) {
		if (!(e instanceof ApiError) || e.code !== "session_required") throw e;
		setSessionToken(null);
		await ensureSession(reason);
		return fn();
	}
}

/** Survives reconnects and hidden-tab closes, so the stream resumes with Last-Event-ID. */
let lastId: string | null = null;

/**
 * The daemon writes at least a keepalive every 15 s: a stream silent this
 * long is half-open (a sleeping laptop, a dropped tailnet path) and is
 * reopened instead of showing "Live" forever.
 */
export const EVENTS_STALL_MS = 45_000;

/**
 * One SSE stream per tab. EventSource can't send the `X-Pulsar` header, so
 * this reads `text/event-stream` from fetch and resumes with `Last-Event-ID`.
 */
export function openEvents(
	handlers: {
		onEvent: (e: ServerEvent) => void;
		onState: (state: "open" | "retrying" | "closed") => void;
	},
	stallMs = EVENTS_STALL_MS,
): { close: () => void } {
	let ctrl: AbortController | null = null;
	let closed = false;
	let retry = 1000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	let stalled = false;
	const heard = () => {
		clearTimeout(watchdog);
		watchdog = setTimeout(() => {
			stalled = true;
			ctrl?.abort();
		}, stallMs);
	};

	const connect = async () => {
		ctrl = new AbortController();
		stalled = false;
		try {
			const res = await fetch(`${API_BASE}/events`, {
				headers: {
					[API_HEADER]: "1",
					Accept: "text/event-stream",
					...(lastId ? { "Last-Event-ID": lastId } : {}),
				},
				credentials: "omit",
				cache: "no-store",
				signal: ctrl.signal,
			});
			if (!res.ok || !res.body) {
				// A slow identity lookup (503 `identity_unavailable`) or a restart:
				// retry quietly ("Reconnecting…"), when the daemon says to.
				if (res.status === 503) retry = retryAfterMs(res, retry);
				throw new Error(`events ${res.status}`);
			}
			handlers.onState("open");
			retry = 1000;
			const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
			let buf = "";
			heard();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				heard();
				buf += value;
				let idx = buf.indexOf("\n\n");
				while (idx >= 0) {
					const block = buf.slice(0, idx);
					buf = buf.slice(idx + 2);
					let data = "";
					let name = "";
					for (const line of block.split("\n")) {
						if (line.startsWith("id:")) lastId = line.slice(3).trim();
						else if (line.startsWith("event:")) name = line.slice(6).trim();
						else if (line.startsWith("data:"))
							data += (data ? "\n" : "") + line.slice(5).trimStart();
					}
					if (data && name) {
						try {
							handlers.onEvent({
								type: name,
								data: JSON.parse(data),
							} as ServerEvent);
						} catch {}
					}
					idx = buf.indexOf("\n\n");
				}
			}
		} catch (err) {
			if (closed || ((err as Error).name === "AbortError" && !stalled)) return;
		}
		clearTimeout(watchdog);
		if (closed) return;
		handlers.onState("retrying");
		timer = setTimeout(connect, retry);
		retry = Math.min(retry * 2, 15000);
	};
	connect();
	return {
		close() {
			closed = true;
			clearTimeout(timer);
			clearTimeout(watchdog);
			ctrl?.abort();
			handlers.onState("closed");
		},
	};
}

/** A dry run, a send, or a 409's fresh dry run, for the composer and builder. */
export function normalizeSend(r: SendResponse): SendResult {
	if (r.dryRun)
		return {
			total: r.count,
			machines: r.machines,
			breakdown: r.breakdown,
			counts: r.totals,
			resolveToken: r.resolveToken,
			preview: r.preview,
		};
	const machines = new Map<
		string,
		{ machineId: string; machine: string; count: number }
	>();
	for (const rc of r.receipts) {
		const m = machines.get(rc.machineId);
		if (m) m.count++;
		else
			machines.set(rc.machineId, {
				machineId: rc.machineId,
				machine: rc.machine,
				count: 1,
			});
	}
	return {
		messageId: r.message.id,
		total: r.count,
		machines: machines.size,
		breakdown: [...machines.values()],
		counts: r.totals,
	};
}
