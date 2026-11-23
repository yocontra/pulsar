import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256hex } from "../canonical.ts";
import type { UserSessionInfo } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";

/** Where sessions live: the store's `meta` table (the mock keeps a Map). */
export type SessionStore = Pick<
	Store,
	"metaByPrefix" | "metaSet" | "metaDelete"
>;

import { cleanLabel, type Passkeys, type RelyingParty } from "./passkeys.ts";

/** A browser on a pulsar node: the user is at a computer that runs agents. */
export const PULSAR_NODE_SESSION_MS = 12 * 3600_000;
/** A phone or tablet (no pulsar): asked again once a week. */
export const DEVICE_SESSION_MS = 7 * 24 * 3600_000;
const OPTIONS_MS = 2 * 60_000;
const MAX_PENDING = 50;
/** Open sign-in requests one device may hold; its own oldest goes first. */
const MAX_PENDING_PER_NODE = 5;
/** Sessions one login may hold; the oldest goes first. */
const MAX_SESSIONS = 50;
const PREFIX = "session:";

interface Stored {
	id: string;
	/** sha256 of the token, hex. */
	hash: string;
	login: string;
	device: string;
	/** The tailnet node the browser ran on. */
	node: string;
	/** Its whois node id: the token works only from this node. */
	nodeId?: string;
	createdAt: number;
	expiresAt: number;
	lastUsedAt: number;
}

/**
 * Passkey sessions: the app proves the user is present (Face ID / Touch ID
 * on one of this node's passkeys) once, and gets a bearer token for actions
 * an agent on the same machine must not take as the user: user-framed
 * sends, Stop, removing passkeys, pool settings. Without one, a request
 * from the user's login is still served, but its sends are framed as from
 * "the Pulsar app (not verified as your operator)".
 *
 * Tokens are 32 random bytes, kept only as sha256 hashes (in the store's
 * `meta` table, so they survive restarts), sent as `Authorization: Bearer`
 * (no cookies, so no CSRF). The WebAuthn work is the approvals code's
 * (`sessionOptions` / `verifySession`, a session-purpose challenge), so a
 * session signature can never answer an approval and the other way round.
 */
export class UserSessions {
	private readonly store: SessionStore;
	private readonly passkeys: Passkeys;
	private readonly now: () => number;
	private pending = new Map<
		string,
		{
			login: string;
			device: string;
			context: string;
			nodeId: string;
			expiresAt: number;
		}
	>();

	constructor(deps: {
		store: SessionStore;
		passkeys: Passkeys;
		now?: () => number;
	}) {
		this.store = deps.store;
		this.passkeys = deps.passkeys;
		this.now = deps.now ?? Date.now;
	}

	/**
	 * Step 1: WebAuthn request options for "start a session on <device>",
	 * asked from the whois node `nodeId`. Each node holds at most a few open
	 * requests (its own oldest goes first), so one node can't crowd out another.
	 */
	async options(
		login: string,
		rp: RelyingParty,
		device: unknown,
		nodeId: string,
	) {
		const label = cleanLabel(device);
		const requestId = `session:${randomBytes(16).toString("base64url")}`;
		// The approvals code binds `context` into a session-purpose challenge,
		// so it can never stand in for an approval signature.
		const context = `${requestId}:${login}:${label}`;
		const options = await this.passkeys.sessionOptions(
			login,
			rp,
			context,
			`node:${nodeId}`,
		);
		const now = this.now();
		for (const [k, v] of this.pending)
			if (v.expiresAt <= now) this.pending.delete(k);
		const mine = [...this.pending].filter(([, v]) => v.nodeId === nodeId);
		for (const [k] of mine.slice(
			0,
			Math.max(0, mine.length - MAX_PENDING_PER_NODE + 1),
		))
			this.pending.delete(k);
		while (this.pending.size >= MAX_PENDING) {
			const oldest = this.pending.keys().next().value;
			if (oldest === undefined) break;
			this.pending.delete(oldest);
		}
		this.pending.set(requestId, {
			login,
			device: label,
			context,
			nodeId,
			expiresAt: now + OPTIONS_MS,
		});
		return { requestId, options };
	}

	/**
	 * Step 2: verifies the assertion (user verification required) and issues a
	 * token. `pulsarNode`: the browser runs on a pool node (12 h), else a
	 * phone or tablet (7 days).
	 */
	async verify(
		login: string,
		rp: RelyingParty,
		input: { requestId: unknown; assertion: unknown },
		where: { node: string; nodeId: string; pulsarNode: boolean },
	): Promise<{ token: string; session: UserSessionInfo }> {
		const id = typeof input.requestId === "string" ? input.requestId : "";
		const p = this.pending.get(id);
		this.pending.delete(id);
		if (
			!p ||
			p.login !== login ||
			p.nodeId !== where.nodeId ||
			p.expiresAt <= this.now()
		)
			throw new RpcError("bad_assertion", "unknown or used session request");
		await this.passkeys.verifySession(login, rp, p.context, input.assertion);
		// The browser's own device name, not the passkey's label: a synced
		// passkey keeps the name of the device it was registered on.
		return this.issue(login, p.device, where);
	}

	/**
	 * A session for a browser that just proved presence another way:
	 * registering a passkey (user verification required) is that proof.
	 */
	issue(
		login: string,
		device: string,
		where: { node: string; nodeId: string; pulsarNode: boolean },
	): { token: string; session: UserSessionInfo } {
		const token = randomBytes(32).toString("base64url");
		const now = this.now();
		const s: Stored = {
			id: randomBytes(8).toString("base64url"),
			hash: sha256hex(token),
			login,
			device: cleanLabel(device),
			node: where.node,
			nodeId: where.nodeId,
			createdAt: now,
			expiresAt:
				now + (where.pulsarNode ? PULSAR_NODE_SESSION_MS : DEVICE_SESSION_MS),
			lastUsedAt: now,
		};
		this.save(s);
		this.prune(login);
		return { token, session: info(s) };
	}

	/**
	 * The live session a bearer token names for this login, presented from
	 * the node that started it (whois `nodeId`), or null. A token copied to
	 * another device is worthless there.
	 */
	check(
		token: string | null | undefined,
		login: string,
		nodeId: string,
	): UserSessionInfo | null {
		if (!token || token.length > 200) return null;
		const hash = sha256hex(token);
		const s = this.load().find(
			(x) =>
				x.login.toLowerCase() === login.toLowerCase() &&
				timingSafeEqual(Buffer.from(x.hash), Buffer.from(hash)),
		);
		if (!s || s.nodeId !== nodeId) return null;
		const now = this.now();
		if (s.expiresAt <= now) {
			this.store.metaDelete(PREFIX + s.id);
			return null;
		}
		// Note use at most once a minute (a write per request is wasteful).
		if (now - s.lastUsedAt > 60_000) this.save({ ...s, lastUsedAt: now });
		return info(s);
	}

	list(login: string): UserSessionInfo[] {
		const now = this.now();
		return this.load()
			.filter(
				(s) =>
					s.login.toLowerCase() === login.toLowerCase() && s.expiresAt > now,
			)
			.sort((a, b) => b.createdAt - a.createdAt)
			.map(info);
	}

	/** Ends one session (Settings, or the app signing out). */
	revoke(login: string, id: string): boolean {
		const s = this.load().find(
			(x) => x.id === id && x.login.toLowerCase() === login.toLowerCase(),
		);
		if (!s) return false;
		this.store.metaDelete(PREFIX + s.id);
		return true;
	}

	private save(s: Stored) {
		this.store.metaSet(PREFIX + s.id, JSON.stringify(s));
	}

	private load(): Stored[] {
		const out: Stored[] = [];
		for (const { value } of this.store.metaByPrefix(PREFIX)) {
			try {
				out.push(JSON.parse(value) as Stored);
			} catch {}
		}
		return out;
	}

	private prune(login: string) {
		const now = this.now();
		const mine = this.load()
			.filter((s) => s.login === login)
			.sort((a, b) => a.createdAt - b.createdAt);
		for (const s of mine)
			if (s.expiresAt <= now) this.store.metaDelete(PREFIX + s.id);
		const live = mine.filter((s) => s.expiresAt > now);
		for (const s of live.slice(0, Math.max(0, live.length - MAX_SESSIONS)))
			this.store.metaDelete(PREFIX + s.id);
	}
}

function info(s: Stored): UserSessionInfo {
	return {
		id: s.id,
		device: s.device,
		node: s.node,
		createdAt: s.createdAt,
		expiresAt: s.expiresAt,
		lastUsedAt: s.lastUsedAt,
	};
}
