import { dirname } from "node:path";
import { DaemonLock, inodeOf } from "./daemon-lock.ts";
import { poolConfigPath } from "./federation/config.ts";
import {
	type RemoteConfig,
	readSettingsAsync,
	remoteConfig,
} from "./http/config.ts";

export { DaemonLock };

import type { RemoteApp, RemoteOptions } from "./http/start.ts";
import { daemonLog, flushLog } from "./log.ts";
import { checkedSocketPath, dbPath, ensureDir, socketPath } from "./paths.ts";
import { PulsarService, type ServiceOptions } from "./service/index.ts";
import { Store } from "./store.ts";
import { SocketTransport } from "./transport/socket.ts";
import type { Agent, AppStatus } from "./types.ts";

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
	/** Starts the app's HTTP transport (tests fake Tailscale with it). */
	startRemote?: (
		service: PulsarService,
		cfg: Exclude<RemoteConfig, { mode: "off" }>,
		opts: RemoteOptions,
	) => Promise<RemoteApp>;
	/** The wait before retry `attempt` (0 first) to serve the app; tests shorten it. */
	appRetryMs?: (attempt: number) => number;
}

/**
 * Waits between tries to serve the app: every 5 s six times (a slow
 * tailscaled at login, a restart), then 15 s doubling to 5 min.
 */
export function appRetryMs(attempt: number): number {
	return attempt < 6 ? 5_000 : Math.min(15_000 * 2 ** (attempt - 6), 300_000);
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
	private http: RemoteApp | null = null;
	/** The one try to serve the app in flight (tries never overlap on the port). */
	private httpStarting: Promise<void> | null = null;
	private readonly startRemoteFn: NonNullable<DaemonOptions["startRemote"]>;
	private readonly retryMs: (attempt: number) => number;
	/** Failed tries since the app was last served. */
	private attempt = 0;
	private app: AppStatus = { state: "off" };
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
			// Doctor shows whether the app is served, or why not and when the next try is.
			appStatus: () => this.appStatus(),
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
		this.startRemoteFn =
			opts.startRemote ??
			(async (service, cfg, o) =>
				(await import("./http/start.ts")).startRemote(service, cfg, o));
		this.retryMs = opts.appRetryMs ?? appRetryMs;
	}

	/** Binds the socket. Resolves false when another live daemon already owns it. */
	async start(): Promise<boolean> {
		// The database holds message and transcript text: this user only.
		await this.store.secure();
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
		if (this.remote.mode !== "off") this.serveApp();
		return true;
	}

	/** Whether the app is served, or why not and when the next try is. */
	appStatus(): AppStatus {
		return this.app;
	}

	/**
	 * Tries to serve the app unless it is served or a try is in flight. A
	 * failure never takes the daemon down: it is logged and tried again
	 * (`appRetryMs`), in every mode. At login, after a restart or with
	 * Tailscale logged out, the daemon often starts before Tailscale is up.
	 */
	private serveApp(): void {
		if (this.stopped || this.remote.mode === "off") return;
		if (this.http || this.httpStarting) return;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.httpStarting = this.tryServe().finally(() => {
			this.httpStarting = null;
		});
	}

	private async tryServe(): Promise<void> {
		const cfg = this.remote;
		if (cfg.mode === "off") return;
		if (this.app.state !== "retrying") this.app = { state: "starting" };
		try {
			const http = await this.startRemoteFn(this.service, cfg, {
				onAddressesChanged: (ips) => void this.listenAgain(ips),
			});
			if (this.stopped) {
				await http.close();
				return;
			}
			if (this.attempt > 0)
				daemonLog(`app served after ${this.attempt} failed tries`);
			this.http = http;
			this.attempt = 0;
			this.app = {
				state: "serving",
				url: http.transport.url,
				hosts: http.hosts,
			};
		} catch (e) {
			if (this.stopped) return;
			const delay = this.retryMs(this.attempt);
			const error = (e as Error).message;
			const { TailscaleNotReady } = await import("./http/start.ts");
			if (this.stopped) return;
			const since = this.app.state === "retrying" ? this.app.since : Date.now();
			this.attempt++;
			this.app = {
				state: "retrying",
				error,
				tailscale: e instanceof TailscaleNotReady,
				attempt: this.attempt,
				since,
				retryAt: Date.now() + delay,
			};
			daemonLog(
				`app not served: ${error} (retrying in ${Math.round(delay / 1000)} s)`,
			);
			this.retryTimer = setTimeout(() => {
				this.retryTimer = null;
				this.serveApp();
			}, delay);
		}
	}

	/** Tailscale moved this node to other addresses: listen on the new ones. */
	private async listenAgain(ips: string[]): Promise<void> {
		// Off the caller's stack (the pool's status poll, which closing stops).
		await Promise.resolve();
		const http = this.http;
		if (this.stopped || !http || this.httpStarting) return;
		daemonLog(
			`app: Tailscale addresses changed (${http.hosts.join(", ")} to ${ips.join(", ")}); listening again`,
		);
		this.http = null;
		this.app = { state: "starting" };
		// Hold off other tries until the old listener is closed.
		this.httpStarting = http
			.close()
			.catch((e) => daemonLog(`app: close failed: ${(e as Error).message}`))
			.finally(() => {
				this.httpStarting = null;
				this.serveApp();
			});
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

	/**
	 * True once nothing has used the daemon for a while; the CLI exits then.
	 * Never while the app is on (served, or waiting for Tailscale): the app
	 * may be open on a phone with no local connection at all.
	 */
	idleTooLong(now = Date.now()) {
		if (this.remote.mode !== "off") return false;
		return this.service.idleTooLong(now);
	}

	/** Live agents. */
	live(): Agent[] {
		return this.service.registry.live();
	}
}
