import { createHmac, randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { driverFor } from "../harnesses/index.ts";
import type {
	PushPayload,
	PushSettings,
	PushSettingsRequest,
	PushSubscribeRequest,
	TurnNotifyMode,
} from "../http/wire.ts";
import { daemonLog } from "../log.ts";
import {
	allowedEndpoint,
	encryptPayload,
	generateVapidKeys,
	type VapidKeys,
	vapidAuthorization,
} from "../push/webpush.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import { authorize } from "./authorize.ts";
import type { Principal } from "./caller.ts";
import type { EventBus } from "./events.ts";
import {
	approvalNotice,
	generic,
	limitNotice,
	securityNotice,
	turnNotice,
	whoOf,
} from "./push-copy.ts";
import type { Registry } from "./registry.ts";

/**
 * Web Push for approvals, security notices, finished or failed turns and
 * usage limits. Each node has its own VAPID key pair (a 0600 file in the
 * state folder) and sends for its own approvals to the subscriptions it
 * knows: those made by app tabs it served. Syncing subscriptions across the
 * pool is a later step.
 *
 * Each payload carries the notification's text (src/service/push-copy.ts:
 * redacted, short), encrypted for the browser (RFC 8291), so the push
 * service sees no names or text. A subscription with "Show previews on the
 * lock screen" off gets the generic copy instead. The `Topic` header is
 * plaintext: an agent's opaque token, or the kind.
 *
 * Finished and failed turns (`notify`, src/service/turns.ts) go only to
 * subscriptions whose "Agent activity" setting includes notifications
 * (`turns` notify or both). A prompt and the turn's end share the agent's
 * tag and topic: a newer one replaces the older one, and never another
 * agent's.
 *
 * Usage limit warnings (`limit`) go to every subscription.
 */

export interface PushOptions {
	store: Store;
	events: EventBus;
	registry: Registry;
	/** Where the VAPID keys live (created on first use, mode 0600); resolved on first use. */
	keyFile: string | (() => string);
	/** Sends one request (tests replace it); `fetch` by default. */
	send?: (
		url: string,
		init: { method: string; headers: Record<string, string>; body: Uint8Array },
	) => Promise<{ status: number }>;
	now?: () => number;
}

/** VAPID `sub`: the project, never the user's address. */
const SUBJECT = "https://github.com/yocontra/pulsar";
const MAX_SUBSCRIPTIONS = 50;
const SECURITY_PUSH_MS = 60_000;
const MODES = new Set<TurnNotifyMode>(["off", "notify", "sound", "both"]);
/** Agent tokens remembered for `GET /push/turns/:ref`. */
const MAX_REFS = 1000;

/**
 * The `Topic` header: plaintext to the push service, so never a name or an
 * id. A prompt or turn uses the agent's opaque token (22 base64url
 * characters; at most 32 allowed), so a newer push for that agent replaces
 * an undelivered one and another agent's never does. A turn that ended
 * while a prompt still waits has its own (`turn:` tag, `t` topic).
 */
function topicOf(p: PushPayload): string {
	const m = /^(agent|turn):([\w-]{1,30})$/.exec(p.tag ?? "");
	if (m) return m[1] === "agent" ? m[2]! : `t${m[2]}`;
	return p.kind;
}

type Row = Record<string, string | number | null>;

/** One subscription's payload for a push, or null to skip it. */
type PerSubscription = (sub: {
	turns: TurnNotifyMode | null;
	/** "Show previews on the lock screen". */
	previews: boolean;
}) => PushPayload | null;

export class Push {
	private keys: VapidKeys | null = null;
	private readonly o: PushOptions;
	private readonly now: () => number;
	private off: (() => void) | null = null;

	constructor(opts: PushOptions) {
		this.o = opts;
		this.now = opts.now ?? Date.now;
	}

	/** Pushes when a prompt starts waiting, a turn ends, a limit or a security change. */
	start() {
		if (this.off) return;
		const offApproval = this.o.events.on("approval", ({ approval }) => {
			if (approval.state !== "pending") return;
			const ask = (approval.kind ?? "permission") !== "permission";
			const text = approvalNotice(
				approval,
				whoOf(this.o.registry, approval.agentId),
				this.refFor(approval.agentId),
			);
			const payload: PushPayload = {
				kind: "approval",
				id: approval.requestId,
				// Older service workers pick their copy from this.
				...(ask ? { interaction: true } : {}),
				// Pool-wide: remote agents waiting on the user count too.
				badge:
					this.o.registry.needingYou().length +
					this.o.registry
						.remoteAgents()
						.filter((a) => this.o.registry.needsYou(a.id) !== null).length,
				...text,
			};
			this.send(payload, (row) =>
				row.previews
					? payload
					: { ...payload, ...generic(ask ? "question" : "approval", text) },
			);
		});
		// Passkey and enrollment changes reach the phone too (at most one push a minute).
		const offSecurity = this.o.events.on("security", (n) => {
			const now = this.now();
			if (now - this.lastSecurityPush < SECURITY_PUSH_MS) return;
			this.lastSecurityPush = now;
			const text = securityNotice(n);
			const payload: PushPayload = {
				kind: "security",
				badge: this.o.registry.needingYou().length,
				...text,
			};
			this.send(payload, (row) =>
				row.previews ? payload : { ...payload, ...generic("security", text) },
			);
		});
		// A finished or failed turn the operator cares about (Interest).
		const offNotify = this.o.events.on("notify", (n) => {
			const ref = this.refFor(n.agentId);
			const built = turnNotice(
				n.kind,
				n.agentId,
				whoOf(this.o.registry, n.agentId),
				ref,
				n.summary,
				n.at,
			);
			const text = {
				...built,
				...(n.title && n.body ? { title: n.title, body: n.body } : {}),
				// Still waiting on a prompt: the finish must not replace it.
				...(this.o.registry.needsYou(n.agentId) ? { tag: `turn:${ref}` } : {}),
			};
			const payload: PushPayload = { kind: n.kind, ref, ...text };
			this.send(payload, (row) => {
				// Not chosen yet (a new subscription): nothing until the app says.
				const mode = row.turns;
				if (mode !== "notify" && mode !== "both") return null;
				const p: PushPayload = row.previews
					? payload
					: { ...payload, ...generic(n.kind, text) };
				return mode === "both" ? { ...p, sound: true } : p;
			});
		});
		// A plan usage limit passed a threshold or was reached (src/usage/limits.ts).
		const offLimit = this.o.events.on("limit", (w) => {
			const text = limitNotice(
				w,
				driverFor(w.harness)?.label ?? w.harness,
				null,
				this.now(),
			);
			const payload: PushPayload = {
				kind: "limit",
				level: w.level,
				...(w.reached ? { reached: true as const } : {}),
				...text,
			};
			this.send(payload, (row) =>
				row.previews ? payload : { ...payload, ...generic("limit", text) },
			);
		});
		this.off = () => {
			offApproval();
			offSecurity();
			offNotify();
			offLimit();
		};
	}

	private lastSecurityPush = 0;
	/** Per daemon run: agent tokens can't be traced back to the id without it. */
	private readonly refKey = randomBytes(32);
	private refs = new Map<string, string>();

	/** The same opaque token for an agent every time (one notification per agent). */
	private refFor(agentId: string): string {
		const ref = createHmac("sha256", this.refKey)
			.update(agentId)
			.digest("base64url")
			.slice(0, 22);
		this.refs.delete(ref);
		this.refs.set(ref, agentId);
		if (this.refs.size > MAX_REFS) {
			const first = this.refs.keys().next().value;
			if (first !== undefined) this.refs.delete(first);
		}
		return ref;
	}

	/** `GET /push/turns/:ref`: the agent a finish/fail notification was about. */
	turnAgent(p: Principal, ref: string): { agentId: string } {
		authorize(p, "push.subscribe");
		const agentId = this.refs.get(ref);
		if (!agentId)
			throw new RpcError("not_found", "that notification is too old");
		return { agentId };
	}

	/** True when some browser subscribed to this node's pushes. */
	hasSubscriptions(): boolean {
		return (
			this.o.store.db
				.prepare("SELECT 1 FROM push_subscriptions LIMIT 1")
				.get() != null
		);
	}

	/** `notify` in the background; a failure (no key file) is logged while running. */
	private send(payload: PushPayload, per?: PerSubscription) {
		this.notify(payload, per).catch((e) => {
			if (this.off) daemonLog(`push failed: ${(e as Error).message}`);
		});
	}

	stop() {
		this.off?.();
		this.off = null;
	}

	private vapid(): Promise<VapidKeys> {
		if (this.keys) return Promise.resolve(this.keys);
		// One load at a time: two first requests must not both make a key.
		this.loading ??= this.loadVapid().finally(() => {
			this.loading = null;
		});
		return this.loading;
	}

	private loading: Promise<VapidKeys> | null = null;

	private async loadVapid(): Promise<VapidKeys> {
		const file =
			typeof this.o.keyFile === "function" ? this.o.keyFile() : this.o.keyFile;
		try {
			this.keys = JSON.parse(await readFile(file, "utf8")) as VapidKeys;
			return this.keys;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		const keys = generateVapidKeys();
		await writeFile(file, `${JSON.stringify(keys)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		await chmod(file, 0o600);
		this.keys = keys;
		return keys;
	}

	/** `GET /push/key`. */
	async publicKey(p: Principal): Promise<string> {
		authorize(p, "push.subscribe");
		return (await this.vapid()).publicKey;
	}

	/**
	 * `POST /push/subscribe`: remembers the browser's subscription on this
	 * node. A full table refuses new subscriptions after dropping failing
	 * ones; working subscriptions are never evicted. `passkeySession`: made
	 * from a passkey-signed session (those will be required once sessions land).
	 */
	subscribe(
		p: Principal,
		sub: PushSubscribeRequest,
		opts: { passkeySession?: boolean } = {},
	) {
		authorize(p, "push.subscribe");
		if (!allowedEndpoint(sub.endpoint))
			throw new RpcError(
				"bad_request",
				"not a known push service (Apple, Google, Mozilla, Microsoft)",
			);
		const login = p.kind === "human" ? p.login : "terminal";
		const db = this.o.store.db;
		const known = db
			.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = ?")
			.get(sub.endpoint);
		if (!known && this.count() >= MAX_SUBSCRIPTIONS) {
			// Make room only from subscriptions the push service keeps refusing.
			db.prepare(
				`DELETE FROM push_subscriptions WHERE endpoint IN
				 (SELECT endpoint FROM push_subscriptions WHERE failures > 0 AND passkey_session = 0
				  ORDER BY failures DESC, created_at LIMIT 1)`,
			).run();
			if (this.count() >= MAX_SUBSCRIPTIONS)
				throw new RpcError(
					"rate_limited",
					"This machine already has too many notification subscriptions.",
				);
		}
		db.prepare(
			`INSERT INTO push_subscriptions (endpoint, p256dh, auth, login, created_at, passkey_session)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, failures = 0,
			   passkey_session = MAX(passkey_session, excluded.passkey_session)`,
		).run(
			sub.endpoint,
			sub.keys.p256dh,
			sub.keys.auth,
			login,
			this.now(),
			opts.passkeySession ? 1 : 0,
		);
		if (!known)
			this.o.events.emit("security", {
				kind: "push-subscribed",
				message: `Notifications turned on for a browser (${new URL(sub.endpoint).hostname}) on ${this.o.registry.machine}`,
				node: this.o.registry.machine,
				at: this.now(),
			});
	}

	/** `POST /push/unsubscribe`. */
	unsubscribe(p: Principal, endpoint: string) {
		authorize(p, "push.subscribe");
		this.o.store.db
			.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
			.run(endpoint);
	}

	/**
	 * `POST /push/settings`: this browser's finish/fail settings, changed
	 * when given. Only a subscription this node holds keeps them.
	 */
	settings(p: Principal, req: PushSettingsRequest): PushSettings {
		authorize(p, "push.subscribe");
		const db = this.o.store.db;
		const turns =
			req.turns !== undefined && MODES.has(req.turns) ? req.turns : undefined;
		if (turns !== undefined)
			db.prepare(
				"UPDATE push_subscriptions SET turns = ? WHERE endpoint = ?",
			).run(turns, req.endpoint);
		if (typeof req.inApp === "boolean")
			db.prepare(
				"UPDATE push_subscriptions SET in_app = ? WHERE endpoint = ?",
			).run(req.inApp ? 1 : 0, req.endpoint);
		if (typeof req.previews === "boolean")
			db.prepare(
				"UPDATE push_subscriptions SET previews = ? WHERE endpoint = ?",
			).run(req.previews ? 1 : 0, req.endpoint);
		const r = db
			.prepare(
				"SELECT turns, in_app, previews FROM push_subscriptions WHERE endpoint = ?",
			)
			.get(req.endpoint) as Row | undefined;
		if (!r)
			return {
				subscribed: false,
				chosen: false,
				turns: turns ?? "notify",
				inApp: req.inApp ?? true,
				previews: req.previews ?? true,
			};
		const mode = r.turns as TurnNotifyMode | null;
		return {
			subscribed: true,
			chosen: mode !== null && MODES.has(mode),
			turns: mode !== null && MODES.has(mode) ? mode : "notify",
			inApp: Number(r.in_app) !== 0,
			previews: Number(r.previews) !== 0,
		};
	}

	count(): number {
		const r = this.o.store.db
			.prepare("SELECT COUNT(*) AS n FROM push_subscriptions")
			.get() as Row;
		return Number(r.n);
	}

	/**
	 * Sends one payload to every subscription; drops the ones the push
	 * service says are gone. `per` picks each subscription's payload (null:
	 * skip that one).
	 */
	async notify(payload: PushPayload, per?: PerSubscription): Promise<number> {
		const all = this.o.store.db
			.prepare("SELECT * FROM push_subscriptions")
			.all() as Row[];
		const subs: Array<{ r: Row; topic: string; body: Buffer }> = [];
		for (const r of all) {
			const p = per
				? per({
						turns: (r.turns as TurnNotifyMode | null) ?? null,
						previews: r.previews == null || Number(r.previews) !== 0,
					})
				: payload;
			if (p)
				subs.push({
					r,
					topic: topicOf(p),
					body: Buffer.from(JSON.stringify(p)),
				});
		}
		if (subs.length === 0) return 0;
		const keys = await this.vapid();
		const send =
			this.o.send ??
			((url, init) =>
				fetch(url, {
					...init,
					body: new Uint8Array(init.body) as Uint8Array<ArrayBuffer>,
					signal: AbortSignal.timeout(10_000),
					// A push service must not redirect the daemon into the tailnet.
					redirect: "manual",
				}));
		let sent = 0;
		await Promise.all(
			subs.map(async ({ r, topic, body }) => {
				const endpoint = String(r.endpoint);
				try {
					const res = await send(endpoint, {
						method: "POST",
						headers: {
							Authorization: vapidAuthorization(
								keys,
								endpoint,
								SUBJECT,
								this.now(),
							),
							"Content-Encoding": "aes128gcm",
							"Content-Type": "application/octet-stream",
							TTL: "3600",
							// A finished turn can wait for the device to wake; the rest can't.
							Urgency: payload.kind === "finished" ? "normal" : "high",
							// A newer push for the same agent (or of the same kind)
							// replaces an undelivered one.
							Topic: topic,
						},
						body: encryptPayload(
							{
								endpoint,
								keys: { p256dh: String(r.p256dh), auth: String(r.auth) },
							},
							body,
						),
					});
					if (res.status === 404 || res.status === 410) this.drop(endpoint);
					else if (res.status >= 200 && res.status < 300) {
						sent++;
						this.mark(endpoint, true);
					}
					// Only the push service refusing this subscription counts toward
					// dropping it; an outage, 5xx or 429 says nothing about it.
					else if (
						res.status >= 400 &&
						res.status < 500 &&
						res.status !== 408 &&
						res.status !== 429
					)
						this.mark(endpoint, false);
				} catch (e) {
					daemonLog(
						`push to ${new URL(endpoint).host} failed: ${(e as Error).message}`,
					);
				}
			}),
		);
		return sent;
	}

	private drop(endpoint: string) {
		this.o.store.db
			.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
			.run(endpoint);
	}

	private mark(endpoint: string, ok: boolean) {
		this.o.store.db
			.prepare(
				ok
					? "UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?"
					: "UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ? AND ? IS NOT NULL",
			)
			.run(...(ok ? [this.now(), endpoint] : [endpoint, 1]));
		// A subscription that keeps failing is dead.
		this.o.store.db
			.prepare("DELETE FROM push_subscriptions WHERE failures >= 20")
			.run();
	}
}
