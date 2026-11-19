import { chmod, readFile, writeFile } from "node:fs/promises";
import type { PushPayload, PushSubscribeRequest } from "../http/wire.ts";
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
import type { Registry } from "./registry.ts";

/**
 * Web Push for approvals. Each node has its own VAPID key pair (a 0600 file
 * in the state folder) and sends for its own approvals to the subscriptions
 * it knows: those made by app tabs it served. Syncing subscriptions across
 * the pool is a later step.
 *
 * Payloads carry no agent names, tools or arguments, since they pass
 * through Apple's or Google's push service: only the approval's opaque id
 * and the badge count. The app fetches the details.
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

type Row = Record<string, string | number | null>;

export class Push {
	private keys: VapidKeys | null = null;
	private readonly o: PushOptions;
	private readonly now: () => number;
	private off: (() => void) | null = null;

	constructor(opts: PushOptions) {
		this.o = opts;
		this.now = opts.now ?? Date.now;
	}

	/** Pushes when a prompt starts waiting. */
	start() {
		if (this.off) return;
		const offApproval = this.o.events.on("approval", ({ approval }) => {
			if (approval.state === "pending")
				this.send({
					kind: "approval",
					id: approval.requestId,
					// Only whether it asks for an answer (no tool, no text).
					...((approval.kind ?? "permission") !== "permission"
						? { interaction: true }
						: {}),
					// Pool-wide: remote agents waiting on the user count too.
					badge:
						this.o.registry.needingYou().length +
						this.o.registry
							.remoteAgents()
							.filter((a) => this.o.registry.needsYou(a.id) !== null).length,
				});
		});
		// Passkey and enrollment changes reach the phone too (at most one push a minute).
		const offSecurity = this.o.events.on("security", () => {
			const now = this.now();
			if (now - this.lastSecurityPush < SECURITY_PUSH_MS) return;
			this.lastSecurityPush = now;
			this.send({
				kind: "security",
				badge: this.o.registry.needingYou().length,
			});
		});
		this.off = () => {
			offApproval();
			offSecurity();
		};
	}

	private lastSecurityPush = 0;

	/** `notify` in the background; a failure (no key file) is logged while running. */
	private send(payload: PushPayload) {
		this.notify(payload).catch((e) => {
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

	count(): number {
		const r = this.o.store.db
			.prepare("SELECT COUNT(*) AS n FROM push_subscriptions")
			.get() as Row;
		return Number(r.n);
	}

	/** Sends one payload to every subscription; drops the ones the push service says are gone. */
	async notify(payload: PushPayload): Promise<number> {
		const subs = this.o.store.db
			.prepare("SELECT * FROM push_subscriptions")
			.all() as Row[];
		if (subs.length === 0) return 0;
		const keys = await this.vapid();
		const body = Buffer.from(JSON.stringify(payload));
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
			subs.map(async (r) => {
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
							Urgency: "high",
							// A newer "approval pending" replaces an undelivered one.
							Topic: "approval",
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
