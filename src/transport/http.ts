import { access, readFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createSecureServer, Http2ServerRequest } from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { renderSVG } from "uqr";
import { z } from "zod";
import { isOwner } from "../federation/members.ts";
import { tailnetRpId } from "../federation/tailnet.ts";
import { compressJson } from "../http/compress.ts";
import { EventHub, type HubOptions } from "../http/events.ts";
import {
	type Identity,
	type IdentityProvider,
	IdentityUnavailable,
	isLoopbackAddr,
	isTailscaleAddr,
	normalizeAddr,
} from "../http/identity.ts";
import type { UserSessionInfo } from "../http/wire.ts";
import { operatorName } from "../human-tag.ts";
import { RpcError } from "../rpc.ts";
import { ATTACH_LIMITS } from "../service/attachments.ts";
import { ACTING_OPS } from "../service/authorize.ts";
import {
	type Principal,
	principalLabel,
	requesterOf,
} from "../service/caller.ts";
import { commitParams, prParams, pushParams } from "../service/git.ts";
import type { PulsarService, RelyingParty } from "../service/index.ts";
import { LIMITS } from "../service/limits.ts";
import { decodeCursor, encodeCursor, FACET_KEYS } from "../service/views.ts";
import { RECEIPT_STATES } from "../types.ts";
import { serveStatic } from "./static.ts";

/**
 * The app's HTTP transport: REST under `/api/v1`, live updates by SSE, and
 * the static app from `dist/web/`. Every request is the pool owner or is
 * refused:
 *
 * 1. Host must be one of this node's app hosts (blocks DNS rebinding), an
 *    `Origin`, when sent, one of the allowed origins, and a browser's
 *    `Sec-Fetch-Site` never `cross-site`.
 * 2. Identity comes from the TCP connection only: the IdentityProvider
 *    (`tailscale whois` on the remote address and port) names the login and
 *    node. A login other than the pool owner's is refused. No header can
 *    claim an identity.
 * 3. API calls carry `X-Pulsar: 1` (a page on another site cannot add it
 *    without a CORS preflight, which only allowed origins pass). Exceptions:
 *    `GET /api/v1/hello` (identity only), and `GET /events` and `GET /qr` from
 *    a same-origin browser context (`Sec-Fetch-Site: same-origin`, which
 *    pages cannot forge), so a native EventSource or `<img>` works.
 *
 * Plus strict CORS (allowed origins echoed, no wildcard, no credentials),
 * `Cache-Control: no-store` on the API, and CSP/nosniff/referrer headers on
 * everything. The daemon binds loopback (dev) or its Tailscale addresses
 * (TLS); never 0.0.0.0.
 */
export interface HttpOptions {
	identity: IdentityProvider;
	/** The pool owner's login; every other login is refused. */
	owner: string;
	/** The owner's user id, when known: a caller must have it too. */
	ownerId?: string;
	/** Addresses to bind: loopback in dev, this node's Tailscale IPs with TLS. */
	hosts: string[];
	/** 0 picks a free port (tests). */
	port: number;
	/** Certificate and key files (`tailscale cert`'s or the operator's own); without them, loopback only. */
	tls?: { cert: string; key: string };
	/** This node's MagicDNS name: the app's origin with TLS. */
	publicName?: string;
	/** The WebAuthn RP id with TLS; the tailnet's MagicDNS suffix by default. */
	rpId?: string;
	/** More allowed origins (other pool nodes, later). */
	extraOrigins?: string[];
	/** Where the built app lives; null for none. Defaults to `dist/web/`. */
	webRoot?: string | null;
	hub?: HubOptions;
	/**
	 * Whether a device runs pulsar (tests). By default: this node or a linked
	 * pool machine, and every loopback caller in development (no TLS).
	 */
	pulsarNode?: (node: string) => boolean;
	/**
	 * Tests and benchmarks only: TLS on loopback (with a test certificate)
	 * and more accepted Host values (a latency proxy's port).
	 */
	testing?: {
		loopbackTls?: boolean;
		extraHosts?: string[];
		/** HTTP/1.1 only over TLS (the benchmark's baseline). */
		http1?: boolean;
	};
}

/**
 * The connection a request came on: for HTTP/2 the session's TLS socket
 * (every stream of a connection shares it), else the request's socket.
 */
export function connectionOf(incoming: unknown): Socket | undefined {
	if (incoming instanceof Http2ServerRequest)
		return (incoming.stream.session?.socket as Socket | undefined) ?? undefined;
	return (incoming as { socket?: Socket } | undefined)?.socket;
}

/** Serves `/fed/v1` (federation between pool nodes); it checks the caller itself. */
export interface FedHandler {
	handle(req: Request, who: Identity | null): Promise<Response>;
}

type UserPrincipal = Extract<Principal, { kind: "human" }> & { nodeId: string };

type Env = {
	Bindings: { incoming: IncomingMessage; outgoing: ServerResponse };
	Variables: {
		principal: UserPrincipal;
		/** The passkey session the request's bearer token names, if any. */
		session: UserSessionInfo | null;
		/** Set by a route whose successful response may be cached privately. */
		cacheControl?: string;
	};
};

// img-src: the app shows transcript images as blob: URLs it fetched with X-Pulsar.
// frame-src: a transcript PDF opens in an in-app frame from such a blob: URL
// (the app checks the bytes are application/pdf first); nothing else frames.
// frame-ancestors 'self': WebKit applies this CSP to that blob: document too,
// so 'none' would refuse it; other origins still can't frame the app.
const CSP =
	"default-src 'self'; script-src 'self'; img-src 'self' data: blob:; frame-src blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

const STATUS: Record<string, number> = {
	bad_request: 400,
	bad_cursor: 400,
	forbidden: 403,
	not_owner: 403,
	not_found: 404,
	unknown_method: 404,
	no_recipients: 404,
	subagent_unreachable: 409,
	gone: 410,
	drift: 409,
	stale_token: 409,
	confirm: 409,
	decided: 409,
	no_passkey: 409,
	not_a_terminal: 403,
	bad_assertion: 403,
	too_large: 413,
	unsupported_media: 415,
	rate_limited: 429,
	session_required: 401,
	not_implemented: 501,
	unreachable: 503,
	upgrade: 426,
	// Git actions (src/git-actions.ts): git said no, a guard refused, or the
	// operator must confirm first (the agent works; the default branch).
	git_failed: 409,
	git_refused: 409,
	confirm_busy: 409,
	confirm_default: 409,
};

/** Refuses any bind address that is not loopback or (with TLS) a Tailscale address. */
export function checkBindAddress(host: string, tls: boolean) {
	const a = normalizeAddr(host);
	if (!a || a === "0.0.0.0" || a === "::")
		throw new Error(`refusing to bind ${host || "every interface"}`);
	if (tls ? !isTailscaleAddr(a) : !isLoopbackAddr(a))
		throw new Error(
			tls
				? `refusing to bind ${host}: not a Tailscale address`
				: `refusing to bind ${host}: plain HTTP is loopback only`,
		);
}

async function defaultWebRoot(): Promise<string | null> {
	for (const rel of ["./web/", "../../dist/web/"]) {
		const dir = fileURLToPath(new URL(rel, import.meta.url));
		try {
			await access(join(dir, "index.html"));
			return dir;
		} catch {}
	}
	return null;
}

const optionalText = (max: number) => z.string().max(max).optional();
const limit = (dflt: number, max: number) =>
	z.coerce.number().int().min(1).max(max).default(dflt);
const TreeSort = z.enum(["needs", "busy", "recent", "name"]);
const AgentSort = z.enum(["attention", "recent", "name", "busy"]);

const Q = {
	tree: z.object({
		group: z.enum(["machines", "projects"]).default("machines"),
		filter: optionalText(2000),
		sort: TreeSort.optional(),
		cursor: optionalText(100),
		limit: limit(50, 500),
		expand: optionalText(2000),
	}),
	children: z.object({
		filter: optionalText(2000),
		sort: TreeSort.optional(),
		cursor: optionalText(100),
		limit: limit(100, 1000),
	}),
	agents: z.object({
		selector: optionalText(4000),
		sort: AgentSort.default("attention"),
		cursor: optionalText(100),
		limit: limit(50, 500),
	}),
	facets: z.object({
		selector: optionalText(4000),
		facet: z.enum(FACET_KEYS).optional(),
		q: optionalText(200),
		top: limit(8, 100),
	}),
	search: z.object({ q: z.string().max(200).default("") }),
	searchMessages: z.object({
		q: z.string().max(200).default(""),
		agent: optionalText(500),
		limit: limit(20, 200),
	}),
	recent: z.object({ limit: limit(10, 50) }),
	transcript: z.object({
		cursor: optionalText(2000),
		stream: optionalText(100),
	}),
	changes: z.object({
		mode: z.enum(["worktree", "base"]).default("worktree"),
	}),
	changeFile: z.object({
		mode: z.enum(["worktree", "base"]).default("worktree"),
		path: z.string().min(1).max(4096),
	}),
	files: z.object({ q: z.string().max(200).default("") }),
	receipts: z.object({
		state: z.enum(RECEIPT_STATES).optional(),
		cursor: optionalText(100),
		limit: limit(100, 500),
	}),
	usage: z.object({
		period: z.enum(["24h", "7d", "30d", "90d"]).default("7d"),
		/** Minutes east of UTC, for local days. */
		tz: z.coerce.number().int().min(-1440).max(1440).default(0),
		/** Read new session lines first (waits a few seconds at most). */
		refresh: z.enum(["0", "1"]).optional(),
	}),
};

const PriceNumber = z.number().min(0).max(10_000);
const UsagePriceBody = z
	.object({
		model: z.string().min(1).max(200),
		/** Dollars per million tokens; null drops the edit (back to the default). */
		price: z
			.object({
				input: PriceNumber,
				output: PriceNumber,
				cacheRead: PriceNumber,
				cacheWrite5m: PriceNumber,
				cacheWrite1h: PriceNumber,
			})
			.strict()
			.nullable(),
	})
	.strict();

/** How long `GET /usage?refresh=1` waits for the scan before answering anyway. */
const USAGE_REFRESH_WAIT_MS = 8000;

const SendBody = z
	.object({
		to: z.string().max(4000).optional(),
		ids: z.array(z.string().min(1).max(300)).max(LIMITS.maxSendIds).optional(),
		body: z
			.string()
			.max(LIMITS.maxBody * 2)
			.optional(),
		priority: z.enum(["urgent", "normal", "fyi"]).default("normal"),
		expectReply: z.boolean().default(false),
		dryRun: z.boolean().default(false),
		resolveToken: z.string().max(100).optional(),
		viaParent: z.boolean().optional(),
		clientId: z
			.string()
			.regex(/^[A-Za-z0-9_.:-]{8,100}$/)
			.optional(),
	})
	.strict();

const AskBody = z
	.object({
		question: z.string().min(1).max(2000),
		selector: z.string().max(4000).optional(),
	})
	.strict();

const SessionOptionsBody = z
	.object({ device: z.string().max(200).optional() })
	.strict();

const SessionVerifyBody = z
	.object({ requestId: z.string().max(200), assertion: z.unknown() })
	.strict();

const SubscriptionBody = z
	.object({
		expanded: z.array(z.string().max(1000)).max(500).default([]),
		window: z
			.object({
				group: z.enum(["machines", "projects"]),
				filter: z.string().max(2000).optional(),
			})
			.nullable()
			.default(null),
		session: z.string().max(300).nullable().default(null),
		/** Agents whose subagent list the app shows (an expanded row, a page). */
		subagents: z.array(z.string().max(300)).max(50).default([]),
		query: z.string().max(4000).nullable().default(null),
		results: z
			.object({
				selector: z.string().max(4000),
				sort: AgentSort.optional(),
				offset: z.number().int().min(0).max(100_000).optional(),
				limit: z.number().int().min(1).max(500).optional(),
			})
			.nullable()
			.default(null),
		receipts: z.array(z.string().max(100)).max(50).default([]),
		changes: z
			.object({
				agent: z.string().max(300),
				mode: z.enum(["worktree", "base"]),
			})
			.nullable()
			.default(null),
	})
	.strict();

/** `POST /agents/:id/attachments`: the manifest (checked by the handler) and, on another machine, the assertion. */
const AttachmentsBody = z
	.object({ manifest: z.unknown(), assertion: z.unknown().optional() })
	.strict();
/** `PUT /api/v1/agents/:id/attachments/:upload/:index`: exempt from the 2 MB JSON limit. */
const ATTACHMENT_PUT = /^\/api\/v1\/agents\/.+\/attachments\/[^/]+\/\d+$/;
const Decision = z.enum(["allow-once", "allow-session", "deny", "answer"]);
const StopBody = z.object({ assertion: z.unknown().optional() }).strict();
/** `POST /acting/options`: the home node's challenge for one acting op (src/service/acting.ts). */
const ActingOptionsBody = z
	.object({
		op: z.enum(ACTING_OPS),
		agent: z.string().max(600).optional(),
		machine: z.string().max(200).optional(),
		params: z.unknown().optional(),
	})
	.strict();
/** `POST /agents/launch`: params go to the handler as sent (the challenge signs them). */
const LaunchBody = z
	.object({
		machine: z.string().max(200).optional(),
		params: z.unknown(),
		assertion: z.unknown().optional(),
	})
	.strict();
const LaunchRefsQuery = z.object({ cwd: z.string().min(1).max(4096) });
// The answer is checked against its prompt by the approvals service.
const Answer = z.record(z.string(), z.unknown()).optional();
const ApprovalOptionsBody = z
	.object({
		decision: Decision,
		note: z.string().max(2000).optional(),
		answer: Answer,
	})
	.strict();
// A passkey assertion, or (a prompt on this machine) the request's passkey
// session plus the input hash and rules the card showed.
const DecideBody = ApprovalOptionsBody.extend({
	assertion: z.record(z.string(), z.unknown()).optional(),
	inputHash: z.string().max(128).optional(),
	sessionRules: z.array(z.string().max(4000)).max(200).nullable().optional(),
});
const RegisterOptionsBody = z
	.object({ label: z.string().max(80).default("browser") })
	.strict();
const RegisterVerifyBody = z
	.object({ response: z.record(z.string(), z.unknown()) })
	.strict();

const PushSubscribeBody = z
	.object({
		endpoint: z.string().url().max(2000),
		keys: z
			.object({
				p256dh: z.string().regex(/^[\w-]{80,100}$/),
				auth: z.string().regex(/^[\w-]{16,40}$/),
			})
			.strip(),
		expirationTime: z.number().nullable().optional(),
	})
	.strip();
const PushUnsubscribeBody = z
	.object({ endpoint: z.string().max(2000) })
	.strict();
const PushSettingsBody = z
	.object({
		endpoint: z.string().max(2000),
		turns: z.enum(["off", "notify", "sound", "both"]).optional(),
		inApp: z.boolean().optional(),
	})
	.strict();

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
	const r = schema.safeParse(value);
	if (!r.success)
		throw new RpcError(
			"bad_request",
			r.error.issues
				.map((i) => `${i.path.join(".") || "request"}: ${i.message}`)
				.join("; "),
		);
	return r.data;
}

/** Routes that change what the user is told or who is signed in need a passkey session. */
function requireSession(c: Context<Env>) {
	if (!c.get("session"))
		throw new RpcError(
			"session_required",
			"prove you're human first (Prove Human, Face ID / Touch ID)",
		);
}

async function jsonBody(c: Context<Env>): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new RpcError("bad_request", "the body must be JSON");
	}
}

export class HttpTransport {
	readonly app = new Hono<Env>();
	readonly hub: EventHub;
	private readonly service: PulsarService;
	private readonly opts: HttpOptions;
	private servers: Server[] = [];
	/** Federation (`/fed/v1`), once this node joins a pool. */
	fed: FedHandler | null = null;
	/** Where non-fatal problems go (the daemon log). */
	onWarn: (line: string) => void = () => {};
	private boundPort = 0;
	private allowedHosts = new Set<string>();
	private allowedOrigins = new Set<string>();
	private readonly webRoot: Promise<string | null>;
	/** One identity lookup per connection. */
	private identities = new WeakMap<Socket, Promise<Identity | null>>();
	/** Open TLS connections (HTTP/2 sessions and HTTP/1.1), destroyed on close. */
	private conns = new Set<Socket>();

	constructor(service: PulsarService, opts: HttpOptions) {
		if (opts.hosts.length === 0) throw new Error("no address to bind");
		for (const h of opts.hosts)
			checkBindAddress(h, Boolean(opts.tls) && !opts.testing?.loopbackTls);
		if (opts.tls && !opts.publicName)
			throw new Error("TLS needs the node's MagicDNS name");
		this.service = service;
		this.opts = opts;
		this.webRoot =
			opts.webRoot === undefined
				? defaultWebRoot()
				: Promise.resolve(opts.webRoot);
		this.hub = new EventHub(service, opts.hub);
		this.routes();
	}

	get port() {
		return this.boundPort;
	}

	/**
	 * Whether a browser on `node` runs on a pulsar node (this one or a pool
	 * peer): its passkey sessions last 12 h, a phone's or tablet's 7 days.
	 */
	private isPulsarNode(node: string): boolean {
		if (this.opts.pulsarNode) return this.opts.pulsarNode(node);
		if (!this.opts.tls) return true;
		const n = node.toLowerCase().split(".")[0]!;
		if (n === this.service.machine.toLowerCase()) return true;
		return (
			this.service.registry.pool
				?.machines()
				.some((m) => m.name.toLowerCase() === n) ?? false
		);
	}

	/** The app's URL (what `pulsar qr` and `GET /qr` encode). */
	get url(): string {
		return this.opts.tls
			? `https://${this.opts.publicName}${this.boundPort === 443 ? "" : `:${this.boundPort}`}/`
			: `http://127.0.0.1:${this.boundPort}/`;
	}

	get origins(): string[] {
		return [...this.allowedOrigins];
	}

	async listen() {
		const fetch = this.app.fetch;
		let port = this.opts.port;
		for (const [i, host] of this.opts.hosts.entries()) {
			// TLS: HTTP/2, so the app's ~40 first-load files and its event stream
			// share one connection instead of queueing on six; HTTP/1.1 too
			// (federation peers, older clients) by ALPN.
			const server = (
				this.opts.tls && this.opts.testing?.http1
					? createAdaptorServer({
							fetch,
							createServer: createHttpsServer,
							serverOptions: await this.tlsFiles(),
						})
					: this.opts.tls
						? createAdaptorServer({
								fetch,
								createServer: createSecureServer,
								serverOptions: { ...(await this.tlsFiles()), allowHTTP1: true },
							})
						: createAdaptorServer({ fetch })
			) as Server;
			if (this.opts.tls)
				server.on("secureConnection", (s: Socket) => {
					this.conns.add(s);
					s.once("close", () => this.conns.delete(s));
				});
			try {
				await new Promise<void>((resolveListen, reject) => {
					server.once("error", reject);
					server.listen(port, host, () => {
						server.off("error", reject);
						resolveListen();
					});
				});
			} catch (e) {
				// The first address must bind; a later one (often IPv6) may be skipped.
				if (i === 0) {
					await this.close();
					throw e;
				}
				this.onWarn(`could not bind ${host}: ${(e as Error).message}`);
				continue;
			}
			server.on("error", () => {});
			// Every address shares the first one's port.
			port = (server.address() as { port: number }).port;
			this.servers.push(server);
		}
		this.boundPort = port;
		this.computeOrigins();
		this.hub.start();
		return { port, url: this.url };
	}

	private async tlsFiles() {
		const tls = this.opts.tls!;
		const [cert, key] = await Promise.all([
			readFile(tls.cert),
			readFile(tls.key),
		]);
		return { cert, key };
	}

	/** Swaps in a renewed certificate without dropping connections. */
	async reloadTls() {
		if (!this.opts.tls) return;
		const ctx = await this.tlsFiles();
		for (const s of this.servers)
			(s as unknown as { setSecureContext(o: object): void }).setSecureContext(
				ctx,
			);
	}

	async close() {
		this.hub.stop();
		await Promise.all(
			this.servers.map(
				(s) =>
					new Promise<void>((done) => {
						s.close(() => done());
						(s as { closeAllConnections?: () => void }).closeAllConnections?.();
						// HTTP/2 sessions (an open event stream never ends on its own).
						for (const c of this.conns) c.destroy();
					}),
			),
		);
		this.servers = [];
	}

	private computeOrigins() {
		const port = this.boundPort;
		const hosts: string[] = [];
		if (this.opts.tls) {
			const name = this.opts.publicName!.toLowerCase();
			hosts.push(`${name}:${port}`);
			if (port === 443) hosts.push(name);
		} else {
			hosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
		}
		hosts.push(...(this.opts.testing?.extraHosts ?? []));
		const scheme = this.opts.tls ? "https" : "http";
		this.allowedOrigins = new Set(
			hosts.map((h) => `${scheme}://${h}`).concat(this.opts.extraOrigins ?? []),
		);
		this.allowedHosts = new Set(hosts);
	}

	/**
	 * The WebAuthn relying party for this node: the tailnet's MagicDNS suffix
	 * with TLS (`tail1234.ts.net`, or a Headscale base domain; shared by the
	 * pool's nodes so a home node can verify a ceremony relayed through
	 * another node's app; see `tailnetRpId`),
	 * `localhost` in loopback development (WebAuthn refuses IP addresses).
	 * Credentials still belong to the node that enrolled them; origins stay
	 * this node's own.
	 */
	relyingParty(): RelyingParty {
		return {
			rpId: this.opts.tls
				? (this.opts.rpId ?? tailnetRpId(this.opts.publicName!))
				: "localhost",
			origins: this.origins,
			node: this.service.machine,
		};
	}

	private identify(c: Context<Env>): Promise<Identity | null> {
		const socket = connectionOf(c.env?.incoming);
		if (!socket?.remoteAddress || !socket.remotePort)
			return Promise.resolve(null);
		let found = this.identities.get(socket);
		if (!found) {
			// After TLS, per request, never inside the handshake: a slow lookup
			// holds this request only. Only a confirmed identity is kept for the
			// connection; a failed, unavailable or stale one (served while whois
			// checks the address again) is asked again next time.
			const addr = socket.remoteAddress;
			const provider = this.opts.identity;
			const lookup = provider
				.identify(addr, socket.remotePort)
				.catch((e) => {
					if (e instanceof IdentityUnavailable) throw e;
					return null;
				})
				.then(
					(id) => {
						const keep = !!id && (provider.confirmed?.(addr) ?? true);
						if (!keep && this.identities.get(socket) === lookup)
							this.identities.delete(socket);
						return id;
					},
					(e) => {
						if (this.identities.get(socket) === lookup)
							this.identities.delete(socket);
						throw e;
					},
				);
			found = lookup;
			this.identities.set(socket, found);
		}
		return found;
	}

	private routes() {
		const app = this.app;
		const refuse = (
			c: Context<Env>,
			status: 403 | 421,
			code: string,
			message: string,
		) => c.json({ error: { code, message } }, status);
		/** Who is calling, or a 503 to retry when that could not be found out in time. */
		const identity = async (
			c: Context<Env>,
		): Promise<{ who: Identity | null } | { retry: Response }> => {
			try {
				return { who: await this.identify(c) };
			} catch (e) {
				if (!(e instanceof IdentityUnavailable)) throw e;
				return {
					retry: c.json(
						{ error: { code: "identity_unavailable", message: e.message } },
						503,
						{ "Retry-After": "2" },
					),
				};
			}
		};

		// Security headers on everything, refusals and errors included.
		app.use("*", async (c, next) => {
			await next();
			const h = c.res.headers;
			// A route's own sandbox CSP (transcript media bytes) is stricter: keep it.
			if (!h.get("Content-Security-Policy")?.startsWith("sandbox"))
				h.set("Content-Security-Policy", CSP);
			h.set("X-Content-Type-Options", "nosniff");
			h.set("Referrer-Policy", "no-referrer");
			h.set("X-Frame-Options", "DENY");
			h.set("Cross-Origin-Opener-Policy", "same-origin");
			const cacheable = c.get("cacheControl");
			if (cacheable && c.res.status === 200) h.set("Cache-Control", cacheable);
			else if (c.req.path.startsWith("/api/"))
				h.set("Cache-Control", "no-store");
			else if (!h.has("Cache-Control")) h.set("Cache-Control", "no-cache");
		});

		// Host, Origin and fetch-site: the browser-side checks.
		app.use("*", async (c, next) => {
			// HTTP/2 names the host in :authority (no Host header).
			const incoming = c.env?.incoming;
			const host = (
				c.req.header("host") ??
				(incoming instanceof Http2ServerRequest ? incoming.authority : "") ??
				""
			).toLowerCase();
			if (!this.allowedHosts.has(host))
				return refuse(c, 421, "bad_host", `unknown host ${host || "(none)"}`);
			const origin = c.req.header("origin");
			if (origin !== undefined && !this.allowedOrigins.has(origin))
				return refuse(c, 403, "bad_origin", "origin not allowed");
			if (c.req.header("sec-fetch-site") === "cross-site")
				return refuse(c, 403, "bad_origin", "cross-site request");
			await next();
		});

		// Federation: pool nodes (the owner's, or allowed tagged nodes) as peers.
		// The handler checks the connection's identity itself; a tagged node
		// never gets past the owner check below.
		app.all("/fed/*", async (c) => {
			if (!this.fed)
				return c.json(
					{
						error: { code: "not_found", message: "this node is not in a pool" },
					},
					404,
				);
			const id = await identity(c);
			if ("retry" in id) return id.retry;
			return this.fed.handle(c.req.raw, id.who);
		});

		// Identity: the connection's Tailscale identity must be the pool owner.
		app.use("*", async (c, next) => {
			const id = await identity(c);
			if ("retry" in id) return id.retry;
			const who = id.who;
			if (!who)
				return refuse(
					c,
					403,
					"not_owner",
					"could not identify this connection",
				);
			if (!isOwner(who, this.opts.owner, this.opts.ownerId ?? null))
				return refuse(
					c,
					403,
					"not_owner",
					`${who.login} is not this pool's owner`,
				);
			// A node the user denied (`pulsar mesh deny`) loses the app too.
			if (this.service.poolMembers.entry(who.nodeId)?.verdict === "deny")
				return refuse(
					c,
					403,
					"not_owner",
					`${who.node} is denied from this pool`,
				);
			// A passkey session (Authorization: Bearer) marks the user as present.
			const bearer = /^Bearer\s+(\S+)$/i.exec(
				c.req.header("authorization") ?? "",
			)?.[1];
			const session = bearer
				? this.service.userSessions.check(bearer, who.login, who.nodeId)
				: null;
			c.set("session", session);
			c.set("principal", {
				kind: "human",
				login: who.login,
				node: who.node,
				nodeId: who.nodeId,
				name: operatorName(who.displayName, who.login),
				...(who.os ? { os: who.os } : {}),
				...(session ? { verified: true } : {}),
			});
			await next();
		});

		// API: CORS for allowed origins, then the custom-header check.
		app.use("/api/*", async (c, next) => {
			const origin = c.req.header("origin");
			if (c.req.method === "OPTIONS") {
				if (!origin) return c.body(null, 204);
				return c.body(null, 204, {
					"Access-Control-Allow-Origin": origin,
					"Access-Control-Allow-Methods": "GET, POST, PUT",
					"Access-Control-Allow-Headers":
						"X-Pulsar, Content-Type, Last-Event-ID, Authorization",
					"Access-Control-Max-Age": "600",
					Vary: "Origin",
				});
			}
			const path = c.req.path;
			const sameOrigin = c.req.header("sec-fetch-site") === "same-origin";
			const exempt =
				c.req.method === "GET" &&
				(path === "/api/v1/hello" ||
					(sameOrigin && (path === "/api/v1/events" || path === "/api/v1/qr")));
			if (c.req.header("x-pulsar") !== "1" && !exempt)
				return refuse(
					c,
					403,
					"missing_header",
					"API calls need the X-Pulsar: 1 header",
				);
			await next();
			if (origin) {
				c.res.headers.set("Access-Control-Allow-Origin", origin);
				c.res.headers.append("Vary", "Origin");
			}
		});

		const jsonLimit = bodyLimit({
			maxSize: 2 * 1024 * 1024,
			onError: (c) =>
				c.json(
					{ error: { code: "too_large", message: "the body is over 2 MB" } },
					413,
				),
		});
		// An attachment's bytes stream with their own limit (src/service/attachments.ts).
		app.use("/api/*", (c, next) =>
			c.req.method === "PUT" && ATTACHMENT_PUT.test(c.req.path)
				? next()
				: jsonLimit(c, next),
		);

		app.onError((err, c) => {
			// Internal errors keep their details in the daemon log, not the response.
			if (!(err instanceof RpcError))
				this.onWarn(`http ${c.req.method} ${c.req.path}: ${err.message}`);
			const e =
				err instanceof RpcError
					? err
					: new RpcError("internal", "internal error");
			const status = (STATUS[e.code] ?? 500) as 400;
			return c.json(
				{
					error: { code: e.code, message: e.message },
					...(e.data && typeof e.data === "object" ? e.data : {}),
				},
				status,
			);
		});

		const api = new Hono<Env>();
		api.use("*", compressJson);
		const svc = this.service.app;
		const who = (c: Context<Env>) => c.get("principal");
		const sessionDevice = (me: UserPrincipal) => ({
			node: me.node,
			nodeId: me.nodeId,
			pulsarNode: this.isPulsarNode(me.node),
		});
		/** `label` leads the audit detail: the device, and how the session began. */
		const auditSessionStart = (
			me: UserPrincipal,
			session: UserSessionInfo,
			label: string,
		) =>
			this.service.store.audit({
				principal: principalLabel(me),
				op: "session.start",
				target: session.id,
				detail: `${label} · until ${new Date(session.expiresAt).toISOString()}`,
				ok: true,
			});

		api.get("/hello", (c) =>
			c.json({
				...svc.hello(who(c)),
				appUrl: this.url,
				session: c.get("session"),
				// The same rule as the session lifetime: a token may outlive a
				// reload only on a device that runs no pulsar (no agents there).
				persistSession: !this.isPulsarNode(who(c).node),
				canSession: this.service.passkeys.has(
					who(c).login,
					this.relyingParty(),
				),
			}),
		);
		// Passkey sessions: Face ID / Touch ID once, then a bearer token for
		// user-framed sends, Stop and removing passkeys.
		api.post("/session/options", async (c) => {
			const body = parse(SessionOptionsBody, await jsonBody(c));
			return c.json(
				await this.service.userSessions.options(
					who(c).login,
					this.relyingParty(),
					body.device,
					who(c).nodeId,
				),
			);
		});
		api.post("/session/verify", async (c) => {
			const body = parse(SessionVerifyBody, await jsonBody(c));
			const me = who(c);
			const r = await this.service.userSessions.verify(
				me.login,
				this.relyingParty(),
				body,
				sessionDevice(me),
			);
			auditSessionStart(me, r.session, r.session.device);
			return c.json(r);
		});
		api.get("/sessions", (c) =>
			c.json({ sessions: this.service.userSessions.list(who(c).login) }),
		);
		api.post("/sessions/:id/revoke", (c) => {
			const me = who(c);
			// Signing out any browser, this one included, takes a passkey session.
			requireSession(c);
			const ok = this.service.userSessions.revoke(me.login, c.req.param("id"));
			this.service.store.audit({
				principal: principalLabel(me),
				op: "session.revoke",
				target: c.req.param("id"),
				detail: null,
				ok,
			});
			if (!ok) throw new RpcError("not_found", "no such session");
			return c.json({ ok: true });
		});
		api.get("/tree", (c) => {
			const q = parse(Q.tree, c.req.query());
			return c.json(svc.tree(who(c), q));
		});
		api.get("/tree/:nodeId/children", (c) => {
			const q = parse(Q.children, c.req.query());
			return c.json(svc.children(who(c), c.req.param("nodeId"), q));
		});
		api.get("/attention", (c) => c.json(svc.attention(who(c))));
		api.get("/recent", (c) => {
			const q = parse(Q.recent, c.req.query());
			return c.json(svc.recent(who(c), q.limit));
		});
		api.get("/agents", (c) => {
			const q = parse(Q.agents, c.req.query());
			return c.json(svc.agents(who(c), q));
		});
		api.get("/agents/:id", (c) => c.json(svc.agent(who(c), c.req.param("id"))));
		// Subagents: children of one agent, never in /agents.
		api.get("/agents/:id/subagents", async (c) => {
			this.service.authorize(who(c), "agents");
			return c.json(
				await this.service.subagents.list(c.req.param("id"), who(c)),
			);
		});
		api.get("/subagents/:id", async (c) => {
			this.service.authorize(who(c), "agents");
			return c.json(
				await this.service.subagents.get(c.req.param("id"), who(c)),
			);
		});
		// Stop: interrupt the agent's current turn (the session keeps running).
		// A remote agent's Stop is a relayed ceremony: options from its home
		// node, then the assertion, which the home node verifies.
		api.post("/agents/:id/stop/options", async (c) =>
			c.json(await this.service.stopOptions(who(c), c.req.param("id"))),
		);
		api.post("/agents/:id/stop", async (c) => {
			// No body: a local agent (the session is enough). Otherwise JSON,
			// checked like every other body.
			const text = await c.req.text();
			let raw: unknown = {};
			if (text.trim())
				try {
					raw = JSON.parse(text);
				} catch {
					throw new RpcError("bad_request", "the body must be JSON");
				}
			const body = parse(StopBody, raw);
			return c.json(
				await this.service.stopAgent(who(c), c.req.param("id"), body.assertion),
			);
		});
		// Attachments: the manifest is the `attachments.upload` act (one
		// proof for every file); then each file's bytes, streamed.
		api.post("/agents/:id/attachments", async (c) => {
			const body = parse(AttachmentsBody, await jsonBody(c));
			return c.json(
				await this.service.acting.run(
					who(c),
					"attachments.upload",
					{ agent: c.req.param("id") },
					body.manifest,
					body.assertion,
				),
			);
		});
		api.put("/agents/:id/attachments/:upload/:index", async (c) => {
			const index = Number(c.req.param("index"));
			if (!Number.isInteger(index) || index < 0 || index > 99)
				throw new RpcError("bad_request", "index");
			const length = Number(c.req.header("content-length") ?? 0);
			if (length > ATTACH_LIMITS.fileBytes)
				throw new RpcError("too_large", "the file is over 25 MB");
			return c.json(
				await this.service.attachments.receive(
					who(c),
					c.req.param("id"),
					c.req.param("upload").slice(0, 100),
					index,
					c.req.raw.body,
				),
			);
		});
		// The composer's `@` menu: files in the agent's folder (same rule as its transcript).
		api.get("/agents/:id/files", async (c) => {
			const q = parse(Q.files, c.req.query());
			const id = c.req.param("id");
			this.service.authorize(who(c), "transcript.read", id);
			return c.json(await this.service.files.search(id, q.q, who(c)));
		});
		// Acting ops on another machine (attachments, launch, git): its home
		// node's challenge for this exact act. The op's own route then sends
		// the assertion, which the home node verifies (src/service/acting.ts).
		api.post("/acting/options", async (c) => {
			const body = parse(ActingOptionsBody, await jsonBody(c));
			return c.json(
				await this.service.acting.options(
					who(c),
					body.op,
					{ agent: body.agent ?? null, machine: body.machine ?? null },
					body.params ?? null,
				),
			);
		});
		// Launch: start an agent in tmux on a machine (src/service/launch.ts).
		const launches = this.service.launches;
		api.post("/agents/launch", async (c) => {
			const body = parse(LaunchBody, await jsonBody(c));
			return c.json(
				await launches.launch(
					who(c),
					body.machine ?? null,
					body.params,
					body.assertion,
				),
			);
		});
		api.get("/launches/:id{.+}", async (c) => {
			const id = c.req.param("id");
			const held = launches.get(id);
			if (held) return c.json(held);
			const slash = id.indexOf("/");
			if (slash < 0) throw new RpcError("not_found", `no launch ${id}`);
			return c.json(
				await launches.read(who(c), id.slice(0, slash), {
					op: "launch.status",
					id: id.slice(slash + 1),
				}),
			);
		});
		api.get("/machines/:m/projects", async (c) =>
			c.json(
				await launches.read(who(c), c.req.param("m"), { op: "launch.options" }),
			),
		);
		api.get("/machines/:m/refs", async (c) => {
			const q = parse(LaunchRefsQuery, c.req.query());
			return c.json(
				await launches.read(who(c), c.req.param("m"), {
					op: "launch.refs",
					cwd: q.cwd,
				}),
			);
		});
		// Approvals: the passkey signs one prompt and one answer.
		const approvals = this.service.approvals;
		const auditRegisterFailure = (c: Context<Env>, e: unknown) =>
			approvals.audit(
				who(c),
				"passkeys.register",
				null,
				{ error: (e as Error).message },
				false,
			);
		api.get("/approvals/:id", (c) => {
			this.service.authorize(who(c), "attention");
			const a = approvals.get(c.req.param("id"));
			if (!a) throw new RpcError("not_found", "no such approval");
			return c.json(a);
		});
		api.post("/approvals/:id/options", async (c) => {
			const body = parse(ApprovalOptionsBody, await jsonBody(c));
			return c.json(
				await approvals.options(
					who(c),
					this.relyingParty(),
					c.req.param("id"),
					body.decision,
					{ note: body.note ?? null, answer: body.answer },
				),
			);
		});
		api.post("/approvals/:id/decide", async (c) => {
			const body = parse(DecideBody, await jsonBody(c));
			return c.json(
				await approvals.decide(who(c), this.relyingParty(), c.req.param("id"), {
					decision: body.decision,
					...(body.note !== undefined ? { note: body.note } : {}),
					...(body.answer !== undefined ? { answer: body.answer } : {}),
					assertion: body.assertion,
					...(body.assertion === undefined
						? {
								session: c.get("session"),
								inputHash: body.inputHash,
								sessionRules: body.sessionRules,
							}
						: {}),
				}),
			);
		});
		api.post("/passkeys/register/options", async (c) => {
			this.service.authorize(who(c), "passkeys.register");
			const body = parse(RegisterOptionsBody, await jsonBody(c));
			try {
				// Any device of the operator's (a known Tailscale identity, checked
				// above) may register: the passkey's user verification is the proof.
				const options = await approvals.passkeys.registrationOptions(
					who(c).login,
					this.relyingParty(),
					{ label: body.label, requester: requesterOf(who(c)) },
				);
				return c.json({ options });
			} catch (e) {
				auditRegisterFailure(c, e);
				throw e;
			}
		});
		api.post("/passkeys/register/verify", async (c) => {
			this.service.authorize(who(c), "passkeys.register");
			const body = parse(RegisterVerifyBody, await jsonBody(c));
			try {
				const info = await approvals.passkeys.verifyRegistration(
					who(c).login,
					this.relyingParty(),
					body.response,
				);
				approvals.passkeyAdded(who(c), info);
				// Registering took Face ID / Touch ID: that proves presence, so
				// the browser is proven at once (no second prompt).
				const me = who(c);
				const r = this.service.userSessions.issue(
					me.login,
					info.label,
					sessionDevice(me),
				);
				auditSessionStart(me, r.session, `${r.session.device} · registered`);
				return c.json({ ...info, ...r });
			} catch (e) {
				auditRegisterFailure(c, e);
				throw e;
			}
		});
		// Web Push: this node's VAPID key and the browser's subscription.
		api.get("/push/key", async (c) =>
			c.json({ publicKey: await this.service.push.publicKey(who(c)) }),
		);
		api.post("/push/subscribe", async (c) => {
			const body = parse(PushSubscribeBody, await jsonBody(c));
			// Subscribing takes a passkey session (it is then never evicted by others).
			requireSession(c);
			this.service.push.subscribe(who(c), body, { passkeySession: true });
			return c.json({ ok: true });
		});
		api.post("/push/unsubscribe", async (c) => {
			// Turning notifications off (also the security-notice channel) takes a passkey session.
			requireSession(c);
			const body = parse(PushUnsubscribeBody, await jsonBody(c));
			this.service.push.unsubscribe(who(c), body.endpoint);
			return c.json({ ok: true });
		});
		// The agent a finish/fail notification was about (its payload has a token).
		api.get("/push/turns/:ref", (c) =>
			c.json(this.service.push.turnAgent(who(c), c.req.param("ref"))),
		);
		// Finish/fail settings of this browser's subscription (read, or change).
		api.post("/push/settings", async (c) => {
			const body = parse(PushSettingsBody, await jsonBody(c));
			return c.json(this.service.push.settings(who(c), body));
		});
		api.get("/passkeys", (c) =>
			c.json({ items: approvals.listPasskeys(who(c)) }),
		);
		api.post("/passkeys/:id/remove", (c) => {
			if (!approvals.removePasskey(who(c), c.req.param("id")))
				throw new RpcError("not_found", "no such passkey");
			return c.json({ ok: true });
		});
		// History newest first; `cursor` from the last page, null once the start is reached.
		// Subscribe (`session`) before paging; merge by event id. `stream`
		// subscribes that event stream here, before the page is read.
		api.get("/agents/:id/transcript", async (c) => {
			const q = parse(Q.transcript, c.req.query());
			const id = c.req.param("id");
			this.service.authorize(who(c), "transcript.read", id);
			if (q.stream && !q.cursor) {
				this.service.authorize(who(c), "subscribe");
				this.hub.watchSession(q.stream, who(c).login, id);
			}
			return c.json(
				await this.service.transcripts.page(id, q.cursor ?? null, who(c)),
			);
		});
		// Image bytes by the `images[].url` of a transcript event. Immutable by id.
		api.get("/agents/:id/transcript/images/:imageId", async (c) => {
			const id = c.req.param("id");
			this.service.authorize(who(c), "transcript.read", id);
			const image = await this.service.transcripts.image(
				id,
				c.req.param("imageId"),
				who(c),
			);
			c.set("cacheControl", "private, max-age=3600");
			return c.body(new Uint8Array(image.data), 200, {
				"Content-Type": image.mediaType,
				"Content-Disposition": "inline",
				"X-Content-Type-Options": "nosniff",
				// Never active content, even if opened directly.
				"Content-Security-Policy": "sandbox; default-src 'none'",
			});
		});
		// What the agent's git worktree has dirty (same rule as its transcript).
		api.get("/agents/:id/changes", async (c) => {
			const q = parse(Q.changes, c.req.query());
			const id = c.req.param("id");
			this.service.authorize(who(c), "transcript.read", id);
			return c.json(await this.service.changes.summary(id, q.mode, who(c)));
		});
		// One changed file's unified diff; only paths the summary lists.
		api.get("/agents/:id/changes/file", async (c) => {
			const q = parse(Q.changeFile, c.req.query());
			const id = c.req.param("id");
			this.service.authorize(who(c), "transcript.read", id);
			return c.json(
				await this.service.changes.file(id, q.mode, q.path, who(c)),
			);
		});
		// Git actions on the agent's worktree (src/service/git.ts). Reads
		// follow the diff viewer's rule; commit, push and PR are acting ops.
		api.get("/agents/:id/git/status", async (c) => {
			const id = c.req.param("id");
			this.service.authorize(who(c), "transcript.read", id);
			return c.json(await this.service.git.status(id, who(c)));
		});
		api.get("/agents/:id/git/pr", async (c) => {
			const id = c.req.param("id");
			this.service.authorize(who(c), "transcript.read", id);
			return c.json(await this.service.git.pr(id, who(c)));
		});
		for (const [path, op, check] of [
			["commit", "git.commit", commitParams],
			["push", "git.push", pushParams],
			["pr", "git.pr", prParams],
		] as const)
			api.post(`/agents/:id/git/${path}`, async (c) => {
				const raw = await jsonBody(c);
				if (!raw || typeof raw !== "object" || Array.isArray(raw))
					throw new RpcError("bad_request", "the body must be an object");
				// The params go on exactly as sent: a remote proof covers them.
				const { assertion, ...params } = raw as Record<string, unknown>;
				check(params);
				return c.json(
					await this.service.acting.run(
						who(c),
						op,
						{ agent: c.req.param("id") },
						params,
						assertion,
					),
				);
			});
		api.get("/facets", (c) => {
			const q = parse(Q.facets, c.req.query());
			return c.json(svc.facets(who(c), q));
		});
		api.get("/search", (c) => {
			const q = parse(Q.search, c.req.query());
			return c.json(svc.search(who(c), q.q));
		});
		// Message search: transcript text, so the transcript.read rule; the
		// pool answers in parallel.
		api.get("/search/messages", async (c) => {
			const q = parse(Q.searchMessages, c.req.query());
			this.service.authorize(who(c), "transcript.read", q.agent);
			return c.json(
				await this.service.messages.search(q.q, who(c), {
					limit: q.limit,
					...(q.agent ? { agent: q.agent } : {}),
				}),
			);
		});
		api.post("/send", async (c) => {
			const body = parse(SendBody, await jsonBody(c));
			// A real send that names a session the daemon no longer knows (expired,
			// revoked) is refused, never silently sent unverified: the app proves
			// again first.
			if (
				!body.dryRun &&
				/^Bearer\s+\S+$/i.test(c.req.header("authorization") ?? "") &&
				!c.get("session")
			)
				requireSession(c);
			return c.json(await svc.send(who(c), body));
		});
		// Ask: answered from the registry and the touched-files index; nobody is woken.
		api.post("/ask", async (c) => {
			this.service.authorize(who(c), "lookup");
			const body = parse(AskBody, await jsonBody(c));
			return c.json(await this.service.askPool(body, who(c)));
		});
		// Token usage across the pool, priced here ("API estimate").
		api.get("/usage", async (c) => {
			const q = parse(Q.usage, c.req.query());
			this.service.authorize(who(c), "usage");
			if (q.refresh === "1") {
				const scan = this.service.usage.scanner.scan();
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					scan.catch(() => {}),
					new Promise((r) => {
						timer = setTimeout(r, USAGE_REFRESH_WAIT_MS);
					}),
				]);
				clearTimeout(timer);
			}
			return c.json(await this.service.usageReport(q.period, q.tz, who(c)));
		});
		api.get("/agents/:id/usage", async (c) =>
			c.json(await this.service.agentUsage(c.req.param("id"), who(c))),
		);
		// Edit a model's price (or drop the edit): used for every machine's tokens.
		api.put("/usage/prices", async (c) => {
			this.service.authorize(who(c), "usage");
			const body = parse(UsagePriceBody, await jsonBody(c));
			return c.json({
				prices: this.service.usage.setPrice(body.model, body.price),
			});
		});
		api.get("/messages/:id/receipts", (c) => {
			const q = parse(Q.receipts, c.req.query());
			const offset = decodeCursor(q.cursor);
			const r = svc.receipts(who(c), c.req.param("id"), {
				...(q.state ? { state: q.state } : {}),
				offset,
				limit: q.limit,
			});
			const next = offset + r.items.length;
			return c.json({
				...r,
				nextCursor: next < r.total ? encodeCursor(next) : null,
			});
		});
		api.get("/qr", (c) =>
			c.body(renderSVG(this.url, { border: 2 }), 200, {
				"Content-Type": "image/svg+xml; charset=utf-8",
			}),
		);
		api.get("/events", (c) => {
			this.service.authorize(who(c), "subscribe");
			const body = this.hub.open(
				who(c).login,
				c.req.header("last-event-id") ?? null,
			);
			return new Response(body, {
				headers: {
					"Content-Type": "text/event-stream; charset=utf-8",
					"X-Accel-Buffering": "no",
				},
			});
		});
		api.put("/subscriptions/:streamId", async (c) => {
			this.service.authorize(who(c), "subscribe");
			const sub = parse(SubscriptionBody, await jsonBody(c));
			if (
				!this.hub.setSubscription(c.req.param("streamId"), who(c).login, sub, {
					opened: true,
				})
			)
				throw new RpcError("not_found", "no such stream; open /events again");
			return c.json({ ok: true });
		});
		app.route("/api/v1", api);
		app.all("/api/*", (c) =>
			c.json(
				{ error: { code: "not_found", message: "no such endpoint" } },
				404,
			),
		);

		app.get("*", (c) => this.staticFile(c));
	}

	/** The built app (see ./static.ts): precompressed, ETags, immutable `/_app/`. */
	private async staticFile(c: Context<Env>) {
		const root = await this.webRoot;
		if (!root) return c.text("the Pulsar app is not built on this node", 404);
		const r = await serveStatic(root, c.req.path, {
			acceptEncoding: c.req.header("accept-encoding"),
			ifNoneMatch: c.req.header("if-none-match"),
		});
		if (r.body === null) return c.body(null, 304, r.headers);
		return c.body(r.body, r.status as 200, r.headers);
	}
}
