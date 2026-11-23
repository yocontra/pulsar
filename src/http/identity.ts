import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { TAILSCALE_BINS } from "../machine.ts";
import { stateDir } from "../paths.ts";
import {
	discoverLocalApi,
	type LocalApiEndpoint,
	localApiGet,
} from "./localapi.ts";

/**
 * Who is on the other end of a TCP connection. The HTTP transport asks with
 * the socket's remote address and port (from the kernel), never with
 * anything inside the request.
 */
export interface Identity {
	/**
	 * The user's login: `me@example.com` on tailscale.com; on Headscale the
	 * user's email, else its bare name (`ada`). `tagged-devices` for tagged nodes.
	 */
	login: string;
	/** The user's numeric id (`UserProfile.ID`), unique on the control server. */
	userId?: string;
	/** The calling node's short name (`iphone`). */
	node: string;
	/** The calling node's stable id. */
	nodeId: string;
	/** The Tailscale user's display name (`Ada Lovelace`), when whois gives one. */
	displayName?: string;
	/** The calling node's OS as Tailscale reports it (`iOS`, `android`, `macOS`, …). */
	os?: string;
}

export interface IdentityProvider {
	/**
	 * Who is calling: an identity, or null when that is definitely unknown.
	 * Rejects with `IdentityUnavailable` when it could not find out in time.
	 */
	identify(remoteAddr: string, remotePort: number): Promise<Identity | null>;
	/**
	 * Whether the last answer for this address came from a lookup within the
	 * TTL, not a stale or persisted one served while a lookup runs. Only a
	 * confirmed answer may be kept for a connection's lifetime.
	 */
	confirmed?(remoteAddr: string): boolean;
}

/**
 * Every loopback connection is one fixed user: tests and local dev
 * (`PULSAR_DEV_IDENTITY`). Anything else is not identified.
 */
export class StaticIdentity implements IdentityProvider {
	private readonly identity: Identity;
	constructor(
		login: string,
		node = "localhost",
		nodeId = "dev",
		extra: Pick<Identity, "displayName" | "os"> = {},
	) {
		this.identity = { login, node, nodeId, ...extra };
	}
	async identify(addr?: string): Promise<Identity | null> {
		if (addr !== undefined && !isLoopbackAddr(addr)) return null;
		return this.identity;
	}
}

/** `::ffff:100.1.2.3` → `100.1.2.3`; drops brackets and an IPv6 zone. */
export function normalizeAddr(addr: string): string {
	let a = addr.trim().replace(/^\[|\]$/g, "");
	const zone = a.indexOf("%");
	if (zone !== -1) a = a.slice(0, zone);
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
	return (mapped ? mapped[1]! : a).toLowerCase();
}

/** `addr:port` as `tailscale whois` takes it (IPv6 in brackets). */
export function whoisTarget(addr: string, port: number): string {
	const a = normalizeAddr(addr);
	return isIP(a) === 6 ? `[${a}]:${port}` : `${a}:${port}`;
}

/** True for Tailscale's CGNAT range 100.64.0.0/10 or its ULA fd7a:115c:a1e0::/48. */
export function isTailscaleAddr(addr: string): boolean {
	const a = normalizeAddr(addr);
	if (isIP(a) === 4) {
		const [first, second] = a.split(".").map(Number);
		return first === 100 && second! >= 64 && second! <= 127;
	}
	if (isIP(a) === 6) return /^fd7a:115c:a1e0:/i.test(a);
	return false;
}

export function isLoopbackAddr(addr: string): boolean {
	const a = normalizeAddr(addr);
	return a === "::1" || (isIP(a) === 4 && a.startsWith("127."));
}

function str(v: unknown): string | null {
	return typeof v === "string" && v ? v : null;
}

/** `studio.tail1234.ts.net.` → `studio.tail1234.ts.net`. */
function stripDot(name: string) {
	return name.replace(/\.$/, "");
}

/**
 * The identity in `tailscale whois --json <addr>:<port>` output:
 * `{ Node: { ID, StableID, Name, ComputedName, Tags, Hostinfo: { OS } }, UserProfile: { ID, LoginName, DisplayName } }`.
 * The same on Headscale (its users' LoginName is the email, else the bare
 * user name). A node with tags is always `tagged-devices`, whatever user
 * the control server names. Null when the shape is missing a login or a node.
 */
export function parseWhois(json: unknown): Identity | null {
	if (!json || typeof json !== "object") return null;
	const w = json as {
		Node?: {
			ID?: unknown;
			StableID?: unknown;
			Name?: unknown;
			ComputedName?: unknown;
			Tags?: unknown;
			Hostinfo?: { OS?: unknown };
		};
		UserProfile?: { ID?: unknown; LoginName?: unknown; DisplayName?: unknown };
	};
	const tagged = Array.isArray(w.Node?.Tags) && w.Node.Tags.length > 0;
	const userLogin = str(w.UserProfile?.LoginName);
	const login = tagged && userLogin ? "tagged-devices" : userLogin;
	const fqdn = str(w.Node?.Name);
	const node =
		str(w.Node?.ComputedName) ?? (fqdn ? stripDot(fqdn).split(".")[0]! : null);
	const nodeId =
		str(w.Node?.StableID) ??
		(typeof w.Node?.ID === "number" ? String(w.Node.ID) : null);
	if (!login || !node || !nodeId) return null;
	const displayName = tagged ? null : str(w.UserProfile?.DisplayName);
	const os = str(w.Node?.Hostinfo?.OS);
	const uid = w.UserProfile?.ID;
	const userId =
		typeof uid === "number" || (typeof uid === "string" && uid)
			? String(uid)
			: null;
	return {
		login,
		node,
		nodeId,
		...(userId ? { userId } : {}),
		...(displayName ? { displayName } : {}),
		...(os ? { os } : {}),
	};
}

export interface TailscaleSelf {
	/** MagicDNS name without the trailing dot: `studio.tail1234.ts.net`. */
	dnsName: string;
	/** Short name: `studio`. */
	name: string;
	/** This node's Tailscale addresses (100.x and fd7a:…). */
	ips: string[];
	ownerLogin: string | null;
	ownerId: string | null;
	/** Names `tailscale cert` can issue for (empty when HTTPS certs are off). */
	certDomains: string[];
}

/**
 * This node in `tailscale status --json` output:
 * `{ BackendState, Self: { DNSName, HostName, TailscaleIPs, UserID }, User: { [id]: { LoginName } }, CertDomains }`.
 * Null unless the backend is running and the node has a DNS name.
 */
export function parseStatusSelf(json: unknown): TailscaleSelf | null {
	if (!json || typeof json !== "object") return null;
	const s = json as {
		BackendState?: unknown;
		Self?: {
			DNSName?: unknown;
			HostName?: unknown;
			TailscaleIPs?: unknown;
			UserID?: unknown;
		};
		User?: Record<string, { LoginName?: unknown }> | null;
		CertDomains?: unknown;
	};
	if (s.BackendState !== "Running") return null;
	const dns = str(s.Self?.DNSName);
	if (!dns) return null;
	const dnsName = stripDot(dns);
	const ownerId =
		typeof s.Self?.UserID === "number" || typeof s.Self?.UserID === "string"
			? String(s.Self.UserID)
			: null;
	const ownerLogin =
		ownerId && s.User && typeof s.User === "object"
			? str(s.User[ownerId]?.LoginName)
			: null;
	const ips = Array.isArray(s.Self?.TailscaleIPs)
		? (s.Self.TailscaleIPs as unknown[])
				.filter((ip): ip is string => typeof ip === "string")
				.filter(isTailscaleAddr)
		: [];
	const certDomains = Array.isArray(s.CertDomains)
		? (s.CertDomains as unknown[])
				.filter((d): d is string => typeof d === "string")
				.map(stripDot)
		: [];
	return {
		dnsName,
		name: dnsName.split(".")[0]!,
		ips,
		ownerLogin,
		ownerId,
		certDomains,
	};
}

export interface RunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	/** No Tailscale CLI was found. */
	missing?: boolean;
}

/** Runs the Tailscale CLI (PATH, else the macOS app's binary). Never throws. */
export type TailscaleRunner = (
	args: string[],
	timeoutMs?: number,
) => Promise<RunResult>;

function runOnce(
	bin: string,
	args: string[],
	timeoutMs: number,
): Promise<RunResult & { missing: boolean }> {
	return new Promise((resolve) => {
		try {
			execFile(
				bin,
				args,
				{ timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
				(err, stdout, stderr) => {
					const missing =
						(err as NodeJS.ErrnoException | null)?.code === "ENOENT";
					resolve({
						ok: !err,
						stdout: String(stdout ?? ""),
						stderr: String(stderr ?? (err ? err.message : "")),
						missing,
					});
				},
			).on("error", (e) =>
				resolve({
					ok: false,
					stdout: "",
					stderr: e.message,
					missing: (e as NodeJS.ErrnoException).code === "ENOENT",
				}),
			);
		} catch (e) {
			resolve({
				ok: false,
				stdout: "",
				stderr: (e as Error).message,
				missing: true,
			});
		}
	});
}

export const runTailscale: TailscaleRunner = async (args, timeoutMs = 3000) => {
	let last: RunResult = {
		ok: false,
		stdout: "",
		stderr: "tailscale is not installed",
		missing: true,
	};
	for (const bin of TAILSCALE_BINS) {
		const r = await runOnce(bin, args, timeoutMs);
		if (!r.missing) return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
		last = r;
	}
	return last;
};

/**
 * `tailscale whois` over tailscaled's LocalAPI (src/http/localapi.ts), the
 * rest of the CLI as is. A whois the LocalAPI cannot answer (none found,
 * refused, a rotated token, an error) looks the endpoint up again once,
 * then runs the CLI. A 404 is tailscaled's definite "no match".
 */
export function localApiRunner(
	opts: {
		fallback?: TailscaleRunner;
		discover?: () => Promise<LocalApiEndpoint | null> | LocalApiEndpoint | null;
		get?: typeof localApiGet;
	} = {},
): TailscaleRunner {
	const fallback = opts.fallback ?? runTailscale;
	const discover = opts.discover ?? (() => discoverLocalApi());
	const get = opts.get ?? localApiGet;
	let ep: LocalApiEndpoint | null | undefined;
	return async (args, timeoutMs = 3000) => {
		if (args[0] !== "whois" || args[1] !== "--json" || args.length !== 3)
			return fallback(args, timeoutMs);
		const path = `/localapi/v0/whois?addr=${encodeURIComponent(args[2]!)}`;
		for (let i = 0; i < 2; i++) {
			if (ep === undefined || i > 0) ep = await discover();
			if (!ep) break;
			try {
				const r = await get(ep, path, timeoutMs);
				if (r.status === 200) return { ok: true, stdout: r.body, stderr: "" };
				if (r.status === 404)
					return { ok: false, stdout: "", stderr: "no match for IP:port" };
			} catch {}
		}
		return fallback(args, timeoutMs);
	};
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * A lookup that could not finish (tailscaled slow or busy, the whois queue
 * full): the caller answers 503 `identity_unavailable` and the client tries
 * again. Never a 403: only a definite answer about who is calling is.
 */
/** How long a known address may answer from cache while it is re-checked. */
const STALE_MS = 60 * 60_000;

export class IdentityUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IdentityUnavailable";
	}
}

/** whois's answer for an address it knows nothing about: definite, not slow. */
const WHOIS_NO_MATCH = /no match|not found|unknown (peer|ip)/i;

/**
 * Identity from `tailscale whois --json <addr>`. A Tailscale address is one
 * node, so answers are cached per address (not port) for a short time;
 * concurrent connections share one lookup, at most `maxConcurrent` whois
 * processes run and a full queue refuses. A failed or slow whois is tried
 * again with backoff for up to `waitMs`, then the lookup rejects with
 * `IdentityUnavailable`; failures are never cached. Null is a definite
 * answer: not a Tailscale address, or whois knows no user for it.
 */
export class TailscaleIdentity implements IdentityProvider {
	/** By Tailscale address: an address is one node whatever the port. */
	private cache = new Map<
		string,
		{ at: number; value: Identity; verified: boolean }
	>();
	private inflight = new Map<string, Promise<Identity | null>>();
	private running = 0;
	private queue: Array<() => void> = [];
	private readonly ttlMs: number;
	private readonly run: TailscaleRunner;
	private readonly maxConcurrent: number;
	private readonly maxQueued: number;
	private readonly waitMs: number;
	private readonly retryMs: number;
	private readonly file: string | null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	/** The persisted cache, read once before the first answer. */
	private loading: Promise<void> | null = null;
	/** `tailscale whois` processes started (tests check the cap and the cache). */
	lookups = 0;

	constructor(
		opts: {
			ttlMs?: number;
			run?: TailscaleRunner;
			maxConcurrent?: number;
			maxQueued?: number;
			/** How long one lookup keeps retrying a failed or slow whois. */
			waitMs?: number;
			/** The first retry's delay; it doubles. */
			retryMs?: number;
			/**
			 * Keeps known addresses across daemon restarts (JSON, mode 0600).
			 * Loaded entries answer within STALE_MS of their lookup, and each
			 * is re-checked with whois on its first use.
			 */
			file?: string | null;
		} = {},
	) {
		// A Tailscale address keeps its node: re-asking every 30 s cost a whois per
		// client under load; 5 min still notices a reassigned address soon.
		this.ttlMs = opts.ttlMs ?? 300_000;
		this.run = opts.run ?? runTailscale;
		this.maxConcurrent = opts.maxConcurrent ?? 4;
		this.maxQueued = opts.maxQueued ?? 64;
		this.waitMs = opts.waitMs ?? 15_000;
		this.retryMs = opts.retryMs ?? 250;
		this.file = opts.file ?? null;
		if (this.file) this.loading = this.load(this.file);
	}

	confirmed(addr: string): boolean {
		const hit = this.cache.get(normalizeAddr(addr));
		return !!hit?.verified && Date.now() - hit.at < this.ttlMs;
	}

	async identify(addr: string, port: number): Promise<Identity | null> {
		if (!isTailscaleAddr(addr) || !Number.isInteger(port) || port <= 0)
			return null;
		if (this.loading) {
			await this.loading;
			this.loading = null;
		}
		const key = normalizeAddr(addr);
		const now = Date.now();
		const hit = this.cache.get(key);
		// An entry from the persisted file is re-checked on first use, however fresh.
		if (hit?.verified && now - hit.at < this.ttlMs) return hit.value;
		// One lookup per address at a time; every connection from it waits on it.
		const pending = this.inflight.get(key);
		// A recently known address answers at once while a fresh whois runs:
		// a whois can take seconds on a loaded machine, and an address keeps
		// its node. Past STALE_MS (or with no answer yet) the caller waits.
		if (hit && now - hit.at < STALE_MS) {
			if (!pending) {
				const p = this.lookup(key)
					.then((v) => {
						// The address no longer matches that node: forget it now.
						if (!v && this.cache.delete(key)) this.scheduleSave();
						return v;
					})
					.catch(() => hit.value)
					.finally(() => this.inflight.delete(key));
				this.inflight.set(key, p);
			}
			return hit.value;
		}
		if (pending) return pending;
		const p = this.lookup(key).finally(() => this.inflight.delete(key));
		this.inflight.set(key, p);
		return p;
	}

	private async lookup(addr: string): Promise<Identity | null> {
		const deadline = Date.now() + this.waitMs;
		let delay = this.retryMs;
		let last = "";
		for (;;) {
			const left = deadline - Date.now();
			const r = await this.whois(addr, Math.max(500, Math.min(8000, left)));
			if (r.ok) {
				const value = parseWhois(parseJson(r.stdout));
				if (value) {
					const now = Date.now();
					if (this.cache.size > 1000) this.prune(now);
					this.cache.set(addr, { at: now, value, verified: true });
					this.scheduleSave();
				} else if (this.cache.delete(addr)) this.scheduleSave();
				return value;
			}
			if (WHOIS_NO_MATCH.test(r.stderr)) {
				if (this.cache.delete(addr)) this.scheduleSave();
				return null;
			}
			if (r.missing)
				throw new IdentityUnavailable("the Tailscale CLI is not installed");
			last = r.stderr.trim().slice(0, 200) || "whois failed";
			if (deadline - Date.now() <= delay)
				throw new IdentityUnavailable(
					`could not identify this connection yet (${last})`,
				);
			await new Promise((ok) => setTimeout(ok, delay));
			delay *= 2;
		}
	}

	/** One whois, in a bounded number of slots; past the queue, unavailable. */
	private async whois(addr: string, timeoutMs: number): Promise<RunResult> {
		if (this.running >= this.maxConcurrent) {
			if (this.queue.length >= this.maxQueued)
				throw new IdentityUnavailable(
					"too many connections are being identified; try again",
				);
			await new Promise<void>((resolve) => this.queue.push(resolve));
		}
		this.running++;
		try {
			this.lookups++;
			return await this.run(["whois", "--json", addr], timeoutMs);
		} finally {
			this.running--;
			this.queue.shift()?.();
		}
	}

	private prune(now: number) {
		for (const [k, v] of this.cache)
			if (now - v.at >= Math.max(this.ttlMs, STALE_MS)) this.cache.delete(k);
	}

	/** Reads the persisted cache; a missing, corrupt or foreign file is ignored. */
	private async load(file: string) {
		let data: unknown;
		try {
			data = JSON.parse(await readFile(file, "utf8"));
		} catch {
			return;
		}
		const entries = (data as { v?: unknown; entries?: unknown })?.entries;
		if ((data as { v?: unknown })?.v !== 1 || !Array.isArray(entries)) return;
		const now = Date.now();
		for (const e of entries.slice(0, 1000)) {
			const { addr, at, value } = (e ?? {}) as {
				addr?: unknown;
				at?: unknown;
				value?: unknown;
			};
			if (typeof addr !== "string" || !isTailscaleAddr(addr)) continue;
			// Kept only within STALE_MS of the lookup (a clock that went back: dropped).
			if (typeof at !== "number" || now - at >= STALE_MS || at > now + 60_000)
				continue;
			const v = value as Partial<Identity> | null;
			const identity = parseWhois({
				Node: {
					StableID: v?.nodeId,
					ComputedName: v?.node,
					Hostinfo: { OS: v?.os },
				},
				UserProfile: {
					ID: v?.userId,
					LoginName: v?.login,
					DisplayName: v?.displayName,
				},
			});
			if (identity)
				this.cache.set(normalizeAddr(addr), {
					at,
					value: identity,
					verified: false,
				});
		}
	}

	private scheduleSave() {
		if (!this.file || this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, 1000);
		this.saveTimer.unref?.();
	}

	/** Writes the cache now (atomic, mode 0600). Never throws. */
	async save(): Promise<void> {
		const file = this.file;
		if (!file) return;
		const now = Date.now();
		const entries = [...this.cache]
			.filter(([, v]) => now - v.at < STALE_MS)
			.map(([addr, v]) => ({ addr, at: v.at, value: v.value }));
		const tmp = `${file}.${process.pid}.tmp`;
		try {
			await mkdir(dirname(file), { recursive: true, mode: 0o700 });
			await writeFile(tmp, JSON.stringify({ v: 1, entries }), { mode: 0o600 });
			await chmod(tmp, 0o600);
			await rename(tmp, file);
		} catch {}
	}
}

/** This node as Tailscale sees it; null when Tailscale is missing, stopped or slow. */
export async function tailscaleSelf(
	run: TailscaleRunner = runTailscale,
): Promise<TailscaleSelf | null> {
	return (await tailscaleSelfOrWhy(run)).self;
}

/**
 * `tailscaleSelf`, and when there is no self node, why: the CLI's error
 * (missing, refused, timed out) or the backend state it reported.
 */
export async function tailscaleSelfOrWhy(
	run: TailscaleRunner = runTailscale,
): Promise<{ self: TailscaleSelf | null; why: string }> {
	const r = await run(["status", "--json"]);
	if (!r.ok) {
		const err = (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 200);
		return { self: null, why: err || "tailscale status failed" };
	}
	const json = parseJson(r.stdout);
	const self = parseStatusSelf(json);
	if (self) return { self, why: "" };
	const state = (json as { BackendState?: unknown } | null)?.BackendState;
	return {
		self: null,
		why:
			typeof state === "string" ? `backend state ${state}` : "no node status",
	};
}

/** Where pulsar keeps the node certificate for `domain`. */
export function tailscaleCertPaths(
	domain: string,
	dir = join(stateDir(), "tls"),
): { cert: string; key: string } {
	const safe = domain.replace(/[^a-z0-9.-]/gi, "_");
	return { cert: join(dir, `${safe}.crt`), key: join(dir, `${safe}.key`) };
}

/**
 * Fetches (or renews; tailscaled reuses a valid one) the node certificate
 * with `tailscale cert`. Throws with Tailscale's message when HTTPS
 * certificates are off for the tailnet or the CLI may not write the files.
 */
export async function fetchCert(
	domain: string,
	opts: { dir?: string; run?: TailscaleRunner } = {},
): Promise<{ cert: string; key: string }> {
	const paths = tailscaleCertPaths(domain, opts.dir);
	await mkdir(join(paths.cert, ".."), { recursive: true, mode: 0o700 });
	const r = await (opts.run ?? runTailscale)(
		["cert", "--cert-file", paths.cert, "--key-file", paths.key, domain],
		60_000,
	);
	if (!r.ok) throw new Error(certError(domain, r.stderr));
	// Only this user reads the private key.
	await chmod(paths.key, 0o600).catch(() => {});
	return paths;
}

/** The fix to show when the tailnet has HTTPS certificates turned off. */
export const ENABLE_HTTPS_HINT =
	"Enable HTTPS Certificates in the Tailscale admin console (DNS page): https://login.tailscale.com/admin/dns";

/** The fix to show on a self-hosted control server, where `tailscale cert` cannot work. */
export const BRING_CERT_HINT =
	"This tailnet's control server is self-hosted (Headscale), which cannot issue certificates. Bring one: pulsar mesh on --cert <file> --key <file> --ca <root> (see docs/headscale.md)";

/** True for tailscaled's answer when the tailnet has HTTPS certificates off. */
export function certsDisabled(stderr: string): boolean {
	return /does not support getting TLS certs/i.test(stderr);
}

/** A readable `tailscale cert` failure; names the admin-console fix when certs are off. */
function certError(domain: string, stderr: string): string {
	if (certsDisabled(stderr)) return ENABLE_HTTPS_HINT;
	return `tailscale cert ${domain} failed: ${stderr.trim() || "unknown error"}`;
}
