import type {
	Tailnet,
	TailnetNode,
	TailnetStatus,
} from "../src/federation/tailnet.ts";
import type { Identity, IdentityProvider } from "../src/http/identity.ts";

/** What serves a node's pulsar: a Hono app (the HTTP transport's) or a simulated peer. */
export interface FakeApp {
	fetch(req: Request, env?: unknown): Response | Promise<Response>;
}

export interface FakeNode extends TailnetNode {
	ip: string;
	app: FakeApp | null;
	/** The real port in the Host header the app expects. */
	port: number;
	/** The port its pulsar serves on in this fake tailnet. */
	tsPort: number;
}

interface Live {
	pair: string;
	kill: () => void;
}

function pairKey(a: string, b: string) {
	return [a, b].sort().join("|");
}

/**
 * An in-process tailnet. Each node has its own address (in 127.64.x: the
 * test transports are plain HTTP, which identifies loopback callers only); a request from
 * node A to node B runs B's app in-process with A's address as the remote
 * address, so B's `identity` (a fake `whois`) names A exactly as Tailscale
 * would. Links can be cut (open streams error at once) and healed.
 */
export class FakeTailnet {
	readonly nodes = new Map<string, FakeNode>();
	private partitions = new Set<string>();
	private dropNext = new Set<string>();
	private live = new Set<Live>();
	private port = 30_000;
	/** Requests made. */
	requests = 0;
	/** `deliver` frames sent (messages handed to a peer). */
	deliveries = 0;

	add(
		name: string,
		opts: {
			login?: string;
			tags?: string[];
			online?: boolean;
			userId?: string;
		} = {},
	): FakeNode {
		const i = this.nodes.size + 1;
		const tagged = (opts.tags ?? []).length > 0;
		const node: FakeNode = {
			nodeId: `n-${name}`,
			name,
			dnsName: `${name}.tail-fake.ts.net`,
			userId: tagged
				? "tagged"
				: (opts.userId ?? `u-${opts.login ?? "me@example.com"}`),
			login: tagged ? "tagged-devices" : (opts.login ?? "me@example.com"),
			tags: opts.tags ?? [],
			online: opts.online ?? true,
			ip: `127.${64 + Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}`,
			app: null,
			port: 0,
			tsPort: 7337,
		};
		this.nodes.set(name, node);
		return node;
	}

	serve(name: string, app: FakeApp, port = 7337, tsPort = 7337) {
		const node = this.nodes.get(name)!;
		node.app = app;
		node.port = port;
		node.tsPort = tsPort;
	}

	setOnline(name: string, online: boolean) {
		this.nodes.get(name)!.online = online;
		if (!online)
			for (const l of [...this.live])
				if (l.pair.split("|").includes(name)) l.kill();
	}

	partition(a: string, b: string) {
		const key = pairKey(a, b);
		this.partitions.add(key);
		for (const l of [...this.live]) if (l.pair === key) l.kill();
	}

	heal(a: string, b: string) {
		this.partitions.delete(pairKey(a, b));
	}

	/** The next request from `a` to `b` runs on `b`, but `a` never sees the answer. */
	dropNextResponse(a: string, b: string) {
		this.dropNext.add(`${a}>${b}`);
	}

	/** `whois` by remote address. */
	readonly identity: IdentityProvider = {
		identify: async (addr: string): Promise<Identity | null> => {
			for (const n of this.nodes.values())
				if (n.ip === addr)
					return {
						login: n.login ?? "",
						node: n.name,
						nodeId: n.nodeId,
						...(n.userId ? { userId: n.userId } : {}),
					};
			return null;
		},
	};

	private public(n: FakeNode): TailnetNode {
		return {
			nodeId: n.nodeId,
			name: n.name,
			dnsName: n.dnsName,
			userId: n.userId,
			login: n.login,
			tags: n.tags,
			online: n.online,
		};
	}

	/** The tailnet as one node sees it. */
	view(name: string): Tailnet {
		return {
			status: async (): Promise<TailnetStatus | null> => {
				const self = this.nodes.get(name)!;
				return {
					self: {
						...this.public(self),
						ownerLogin: self.tags.length ? null : self.login,
					},
					peers: [...this.nodes.values()]
						.filter((n) => n.name !== name)
						.map((n) => this.public(n)),
				};
			},
			fetch: (target, path, init) =>
				this.request(name, target.name, path, init, target.port ?? 7337),
		};
	}

	/** A request from one node (a peer daemon, or the user's browser there) to another's pulsar. */
	async request(
		from: string,
		to: string,
		path: string,
		init: RequestInit = {},
		port?: number,
	): Promise<Response> {
		const src = this.nodes.get(from)!;
		const dst = this.nodes.get(to);
		const pair = pairKey(from, to);
		if (port !== undefined && dst && port !== dst.tsPort)
			throw new TypeError(`fetch failed: connection refused on ${to}:${port}`);
		if (!dst?.online || !dst.app || !src.online || this.partitions.has(pair))
			throw new TypeError(`fetch failed: ${to} is unreachable from ${from}`);
		if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
		this.requests++;
		if (typeof init.body === "string")
			this.deliveries += init.body.split('"type":"deliver"').length - 1;
		const headers = new Headers(init.headers);
		headers.set("host", `127.0.0.1:${dst.port}`);
		const req = new Request(`http://127.0.0.1:${dst.port}${path}`, {
			...init,
			headers,
		});
		const env = {
			incoming: {
				socket: {
					remoteAddress: src.ip,
					remotePort: 40_000 + (this.requests % 20_000),
				},
			},
			outgoing: {},
		};
		const app = dst.app;
		// Like fetch: an aborted signal (a timeout) rejects at once.
		const signal = init.signal;
		const res = await new Promise<Response>((resolve, reject) => {
			const onAbort = () =>
				reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
			signal?.addEventListener("abort", onAbort, { once: true });
			Promise.resolve(app.fetch(req, env)).then(
				(r) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(r);
				},
				(e) => {
					signal?.removeEventListener("abort", onAbort);
					reject(e);
				},
			);
		});
		if (this.dropNext.delete(`${from}>${to}`)) {
			await res.body?.cancel().catch(() => {});
			throw new TypeError("fetch failed: connection reset");
		}
		if (this.partitions.has(pair)) {
			await res.body?.cancel().catch(() => {});
			throw new TypeError("fetch failed: link dropped");
		}
		if (
			!res.body ||
			!(res.headers.get("content-type") ?? "").includes("event-stream")
		)
			return res;
		// A stream: cut it when the link drops.
		const reader = res.body.getReader();
		let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
		const entry: Live = {
			pair,
			kill: () => {
				this.live.delete(entry);
				try {
					ctl?.error(new TypeError("link dropped"));
				} catch {}
				void reader.cancel().catch(() => {});
			},
		};
		this.live.add(entry);
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				ctl = c;
			},
			async pull(c) {
				try {
					const { done, value } = await reader.read();
					if (done) c.close();
					else c.enqueue(value);
				} catch (e) {
					try {
						c.error(e);
					} catch {}
				}
			},
			cancel: (reason) => {
				this.live.delete(entry);
				return reader.cancel(reason).catch(() => {});
			},
		});
		return new Response(body, { status: res.status, headers: res.headers });
	}
}
