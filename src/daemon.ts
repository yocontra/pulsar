import { dirname } from "node:path";
import { DaemonLock, inodeOf } from "./daemon-lock.ts";
import { poolConfigPath } from "./federation/config.ts";
import {
	type RemoteConfig,
	readSettingsAsync,
	remoteConfig,
} from "./http/config.ts";

export { DaemonLock };

import { daemonLog, flushLog } from "./log.ts";
import { checkedSocketPath, dbPath, ensureDir, socketPath } from "./paths.ts";
import { PulsarService, type ServiceOptions } from "./service/index.ts";
import { Store } from "./store.ts";
import { SocketTransport } from "./transport/socket.ts";
import type { Agent } from "./types.ts";

export { LIMITS } from "./service/limits.ts";

export interface DaemonOptions {
	socket?: string;
	db?: string;
	scan?: boolean;
	/** Run under launchd/systemd: the socket `shutdown` RPC is refused. */
	serviceMode?: boolean;
	/** A fixed machine name; otherwise detected (Tailscale, else the host name). */
	machine?: string;
	/**
	 * The socket's lock, already taken (the process entry takes it before
	 * anything opens the database); otherwise `start` takes it.
	 */
	lock?: DaemonLock;
	/** Whether and how to serve the app; read from the env and settings by default. */
	remote?: RemoteConfig;
	/** Approval timeouts and the local-answer probe (tests). */
	approvals?: ServiceOptions["approvals"];
	/** Redelivery timers (tests shorten them). */
	delivery?: ServiceOptions["delivery"];
	/** Presence checks: the OS prompt and timeout (tests fake them). */
	presence?: ServiceOptions["presence"];
	/** Poll harness servers for prompts (OpenCode); defaults to `scan`. */
	serverInteractions?: boolean;
}

/**
 * One machine's daemon: the service (registry, mailbox, router, waiters)
 * behind the local socket transport, and the app's HTTP transport when
 * remote access is on.
 */
export class Daemon {
	readonly store: Store;
	readonly service: PulsarService;
	private readonly transport: SocketTransport;
	/** Read in `start` (the settings file) unless given. */
	private remote: RemoteConfig;
	private readonly remoteGiven: boolean;
	private http: { close: () => Promise<void> } | null = null;
	private httpStarting: Promise<void> | null = null;
	private stopped = false;
	/** One daemon per socket (see DaemonLock). */
	private readonly lock: DaemonLock;
	private watch: ReturnType<typeof setInterval> | null = null;
	/** Bound the socket (only then are its files ours to remove). */
	private started = false;
	/**
	 * Called when this daemon finds its lock or socket taken by another
	 * daemon (it lost a start race, or someone removed its files). It has
	 * already stopped serving; the process should exit.
	 */
	onOrphan: () => void = () => {};
	private readonly serviceMode: boolean;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(opts: DaemonOptions = {}) {
		this.store = new Store(opts.db ?? dbPath());
		this.service = new PulsarService({
			store: this.store,
			// PULSAR_NO_SCAN=1: no harness scanners (tests and test kits, so a
			// throwaway daemon never finds and messages your real sessions).
			scan: opts.scan ?? process.env.PULSAR_NO_SCAN !== "1",
			// PULSAR_NO_SEARCH=1: keep no copy of transcript text (and delete it).
			search: {
				off: /^(1|true|yes)$/i.test(process.env.PULSAR_NO_SEARCH ?? ""),
			},
			serviceMode: opts.serviceMode ?? false,
			// `pulsar stop`: close the socket and drop the lock before exiting.
			onShutdown: () =>
				setTimeout(
					() =>
						void this.stop()
							.then(flushLog)
							.finally(() => process.exit(0)),
					50,
				).unref(),
			...(opts.machine ? { machine: opts.machine } : {}),
			approvals: {
				// No app on this node: nobody could answer, so the hook lets the terminal decide.
				appServed: () => this.remote.mode !== "off",
				...opts.approvals,
			},
			// The display copy of the pool settings, for doctor and setup.
			pool: { mirror: poolConfigPath() },
			...(opts.delivery ? { delivery: opts.delivery } : {}),
			...(opts.presence ? { presence: opts.presence } : {}),
			...(opts.serverInteractions !== undefined
				? { serverInteractions: opts.serverInteractions }
				: {}),
		});
		this.transport = new SocketTransport(
			this.service,
			opts.socket ?? socketPath(),
		);
		this.lock = opts.lock ?? new DaemonLock(this.transport.path);
		this.remote = opts.remote ?? { mode: "off" };
		this.remoteGiven = opts.remote !== undefined;
		this.serviceMode = opts.serviceMode ?? false;
	}

	/** Binds the socket. Resolves false when another live daemon already owns it. */
	async start(): Promise<boolean> {
		if (!this.remoteGiven)
			this.remote = remoteConfig(process.env, await readSettingsAsync());
		// The socket's folder: made (and for a short path in /tmp, checked) first.
		if (this.transport.path === socketPath()) await checkedSocketPath();
		else await ensureDir(dirname(this.transport.path));
		if (!(await this.lock.owns()) && !(await this.lock.acquire())) return false;
		let listening = false;
		try {
			listening = await this.transport.listen();
		} finally {
			if (!listening) await this.lock.release();
		}
		if (!listening) return false;
		// Exit when the lock or the socket stop being ours: another daemon
		// took over, and this one must not keep scanning and pushing unseen.
		const ino = await inodeOf(this.transport.path);
		let checking = false;
		this.watch = setInterval(async () => {
			if (this.stopped || checking) return;
			checking = true;
			try {
				const owns = await this.lock.owns();
				if (owns && (await inodeOf(this.transport.path)) === ino) return;
				if (this.stopped) return;
				daemonLog(
					`daemon ${process.pid}: lost ${owns ? "its socket" : "its lock"} to another daemon; stopping`,
				);
				void this.stop({ orphaned: true }).then(() => this.onOrphan());
			} finally {
				checking = false;
			}
		}, 2000);
		this.watch.unref();
		this.started = true;
		this.service.start();
		if (this.remote.mode !== "off") this.httpStarting = this.startHttp();
		return true;
	}

	/**
	 * The app transport never takes the daemon down: failures are logged and
	 * it stays off. A service retries (at login it often starts before
	 * Tailscale is up): every 5 s six times, then every 15 s growing to 5 min.
	 */
	private async startHttp(attempt = 0): Promise<void> {
		const cfg = this.remote;
		if (cfg.mode === "off" || this.stopped) return;
		try {
			const { startRemote } = await import("./http/start.ts");
			const http = await startRemote(this.service, cfg);
			if (this.stopped) await http.close();
			else this.http = http;
		} catch (e) {
			const retry = this.serviceMode && !this.stopped;
			// Quick retries first (a slow tailscaled at start, a restart), then back off.
			const delay =
				attempt < 6 ? 5_000 : Math.min(15_000 * 2 ** (attempt - 6), 300_000);
			daemonLog(
				`app not served: ${(e as Error).message}${retry ? ` (retrying in ${delay / 1000} s)` : ""}`,
			);
			if (retry)
				this.retryTimer = setTimeout(() => {
					this.httpStarting = this.startHttp(attempt + 1);
				}, delay);
		}
	}

	/** `orphaned`: another daemon owns the socket now; leave its files alone. */
	async stop(opts: { orphaned?: boolean } = {}) {
		if (this.stopped) return;
		this.stopped = true;
		if (this.watch) clearInterval(this.watch);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.service.stop();
		await this.httpStarting;
		await this.http?.close();
		this.http = null;
		if (opts.orphaned) this.transport.abandon();
		else if (this.started) await this.transport.close();
		await this.lock.release();
		this.store.close();
	}

	/** True once nothing has used the daemon for a while (never while serving the app); the CLI exits then. */
	idleTooLong(now = Date.now()) {
		// The app may be open on a phone with no local connection at all.
		if (this.http) return false;
		return this.service.idleTooLong(now);
	}

	/** Live agents. */
	live(): Agent[] {
		return this.service.registry.live();
	}
}
