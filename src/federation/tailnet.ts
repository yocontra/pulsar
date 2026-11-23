import { getPublicSuffix } from "tldts";
import {
	isTailscaleAddr,
	runTailscale,
	type TailscaleRunner,
} from "../http/identity.ts";

/** A node on the tailnet, as `tailscale status --json` lists it. */
export interface TailnetNode {
	/** Stable node id (`StableID`); `whois` names the same id. */
	nodeId: string;
	/** Short name ("studio"). */
	name: string;
	/**
	 * MagicDNS name without the trailing dot: `studio.tail1234.ts.net` on
	 * tailscale.com, `studio.<dns.base_domain>` on Headscale.
	 */
	dnsName: string;
	/** The owning user's id; tagged nodes are owned by the tag, not a user. */
	userId: string | null;
	/** The owning user's login (`tagged-devices` for tagged nodes). */
	login: string | null;
	tags: string[];
	online: boolean;
	/** The port its pulsar serves on, once a probe found it. */
	port?: number;
	/** Its Tailscale addresses (`TailscaleIPs`), when status listed them. */
	ips?: string[];
}

export interface TailnetStatus {
	self: TailnetNode & { ownerLogin: string | null };
	peers: TailnetNode[];
}

/** The login Tailscale and Headscale give every tagged node. */
const TAGGED_LOGIN = "tagged-devices";

/**
 * The network federation runs on. The real one is Tailscale; tests use an
 * in-process fake. `fetch` reaches only a tailnet node's pulsar, by its
 * MagicDNS name, never an arbitrary URL.
 */
export interface Tailnet {
	status(): Promise<TailnetStatus | null>;
	fetch(node: TailnetNode, path: string, init?: RequestInit): Promise<Response>;
}

function str(v: unknown): string | null {
	return typeof v === "string" && v ? v : null;
}

function idOf(v: unknown): string | null {
	return typeof v === "number" || (typeof v === "string" && v)
		? String(v)
		: null;
}

/** One DNS label: letters, digits and inner hyphens. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

function dnsLabels(name: string): string[] | null {
	const l = name.toLowerCase().replace(/\.$/, "").split(".");
	return name.length < 254 && l.every((x) => LABEL.test(x)) ? l : null;
}

/**
 * The tailnet's MagicDNS suffix from a node's name: everything after the
 * first label (`studio.tail1234.ts.net` → `tail1234.ts.net`; on Headscale
 * the configured `dns.base_domain`). Null for a one-label name.
 */
export function magicDnsSuffix(dnsName: string): string | null {
	const l = dnsLabels(dnsName);
	return l && l.length >= 2 ? l.slice(1).join(".") : null;
}

/** True when `domain` is itself a public suffix (PSL, private section too) or one label. */
function isPublicSuffix(domain: string): boolean {
	const d = domain.toLowerCase().replace(/\.$/, "");
	if (!d.includes(".")) return true;
	return getPublicSuffix(d, { allowPrivateDomains: true }) === d;
}

/**
 * The WebAuthn RP id for a node: the tailnet's MagicDNS suffix, shared by
 * every node, so a ceremony relayed through another node's app verifies.
 * `node.tail1234.ts.net` → `tail1234.ts.net`; on Headscale
 * `node.mesh.corp.example` → `mesh.corp.example` (never the broader
 * registrable domain `corp.example`: other sites there must not get these
 * passkeys). When the suffix is itself a public suffix or one label
 * (`*.c.ts.net`, a base domain like `internal` or `home.arpa`), browsers
 * refuse it as an RP id, so the node's own name is used: passkeys then work
 * per machine only.
 *
 * `override` (the `rpId` setting) must be the node's name or a suffix of it
 * and not a public suffix; anything else throws.
 */
export function tailnetRpId(dnsName: string, override?: string | null): string {
	const name = dnsName.toLowerCase().replace(/\.$/, "");
	if (override) {
		const o = override.trim().toLowerCase().replace(/\.$/, "");
		if (!dnsLabels(o) || (o !== name && !name.endsWith(`.${o}`)))
			throw new Error(
				`rpId setting ${override} is not ${name} or a domain it is under`,
			);
		if (isPublicSuffix(o))
			throw new Error(
				`rpId setting ${override} is a public suffix; browsers refuse it`,
			);
		return o;
	}
	const suffix = magicDnsSuffix(name);
	if (isPublicSuffix(name)) return name;
	return suffix && !isPublicSuffix(suffix) ? suffix : name;
}

/**
 * True for a MagicDNS name of this tailnet: one host label under `suffix`
 * (the tailnet's MagicDNS suffix). Federation requests go only to these.
 */
export function isTailnetName(name: string, suffix: string | null): boolean {
	if (!suffix) return false;
	const l = dnsLabels(name);
	const s = dnsLabels(suffix);
	return (
		!!l &&
		!!s &&
		l.length === s.length + 1 &&
		l.slice(1).join(".") === s.join(".")
	);
}

function node(
	raw: unknown,
	users: Record<string, { LoginName?: unknown }> | null | undefined,
): TailnetNode | null {
	if (!raw || typeof raw !== "object") return null;
	const n = raw as Record<string, unknown>;
	const dns = str(n.DNSName)?.replace(/\.$/, "");
	const nodeId = str(n.StableID) ?? idOf(n.ID);
	if (!dns || !nodeId) return null;
	const userId = idOf(n.UserID);
	const tags = Array.isArray(n.Tags)
		? (n.Tags as unknown[]).filter((t): t is string => typeof t === "string")
		: [];
	const login =
		userId && users && typeof users === "object"
			? str(users[userId]?.LoginName)
			: null;
	const ips = Array.isArray(n.TailscaleIPs)
		? (n.TailscaleIPs as unknown[])
				.filter((ip): ip is string => typeof ip === "string")
				.filter(isTailscaleAddr)
		: [];
	return {
		nodeId,
		name: dns.split(".")[0]!,
		dnsName: dns,
		userId,
		// A tagged node is owned by its tags, never by a user's login.
		login: tags.length > 0 ? TAGGED_LOGIN : login,
		tags,
		online: n.Online === true,
		...(ips.length ? { ips } : {}),
	};
}

/**
 * Self and peers from `tailscale status --json`:
 * `{ BackendState, Self: {...}, Peer: { [key]: { StableID, DNSName, UserID, Tags?, Online } }, User }`.
 * Null unless the backend is running.
 */
export function parseStatus(json: unknown): TailnetStatus | null {
	if (!json || typeof json !== "object") return null;
	const s = json as {
		BackendState?: unknown;
		Self?: unknown;
		Peer?: Record<string, unknown> | null;
		User?: Record<string, { LoginName?: unknown }> | null;
	};
	if (s.BackendState !== "Running") return null;
	const self = node(s.Self, s.User);
	if (!self) return null;
	// A tagged node has no owner of its own.
	const ownerLogin = self.tags.length === 0 ? self.login : null;
	const peers = Object.values(s.Peer ?? {})
		.map((p) => node(p, s.User))
		.filter((p): p is TailnetNode => p !== null);
	return { self: { ...self, online: true, ownerLogin }, peers };
}

/**
 * Tailscale (or Headscale; the client is the same): status from the CLI;
 * requests to `https://<dnsName>:<port>`, only for names under this
 * tailnet's MagicDNS suffix.
 */
export class TailscaleTailnet implements Tailnet {
	private readonly port: number;
	private readonly run: TailscaleRunner;
	/** This tailnet's MagicDNS suffix, from the last status. */
	private suffix: string | null = null;

	constructor(port: number, run: TailscaleRunner = runTailscale) {
		this.port = port;
		this.run = run;
	}

	async status(): Promise<TailnetStatus | null> {
		const r = await this.run(["status", "--json"], 5000);
		if (!r.ok) return null;
		try {
			const st = parseStatus(JSON.parse(r.stdout));
			if (st) this.suffix = magicDnsSuffix(st.self.dnsName);
			return st;
		} catch {
			return null;
		}
	}

	fetch(node: TailnetNode, path: string, init?: RequestInit) {
		if (!path.startsWith("/fed/v1/"))
			return Promise.reject(
				new Error("federation requests stay under /fed/v1"),
			);
		if (!isTailnetName(node.dnsName, this.suffix))
			return Promise.reject(
				new Error(`not a tailnet name: ${node.dnsName.slice(0, 80)}`),
			);
		const p = node.port ?? this.port;
		const port = p === 443 ? "" : `:${p}`;
		return fetch(`https://${node.dnsName}${port}${path}`, {
			...init,
			redirect: "error",
		});
	}
}
