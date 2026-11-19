import { writeFile } from "node:fs/promises";
import type { Identity } from "../http/identity.ts";
import type { PoolMemberRow, Store } from "../store.ts";
import type { TailnetNode } from "./tailnet.ts";

const OWNER_KEY = "pool_owner";

/**
 * Who may be in the pool, held by the daemon (the store, cached in memory).
 *
 * - Untagged nodes of the pool owner's login join on their own, unless denied.
 * - Other nodes (tagged servers) join only when allowed.
 * - Entries match a node by its Tailscale stable id, never by its name (a
 *   node can rename itself; a freed name can go to another node). An allow
 *   entry also remembers the login the node had and must still have.
 *
 * Changes come only through the daemon (`pulsar mesh allow|deny|forget|owner`, confirmed at the
 * terminal like passkey enrollment); nothing is re-read from disk per
 * request.
 */
/**
 * The pool owner: the same login, and the same user id when both are known
 * (logins are unique on tailscale.com, not always on Headscale).
 */
export function isOwner(
	who: { login?: string | null; userId?: string | null },
	owner: string,
	ownerId: string | null = null,
): boolean {
	if (who.login?.toLowerCase() !== owner.toLowerCase()) return false;
	return !ownerId || who.userId === ownerId;
}

export class PoolMembers {
	private readonly store: Store | null;
	private rows: PoolMemberRow[];
	private ownerLogin: string | null;
	/** Where a read-only copy for `pulsar doctor` is written (names only). */
	private readonly mirror: string | null;

	constructor(store: Store | null, mirror: string | null = null) {
		this.store = store;
		this.mirror = mirror;
		this.rows = store?.poolMembers() ?? [];
		this.ownerLogin = store?.metaGet(OWNER_KEY) ?? null;
	}

	/** The owner set on a tagged node (`pulsar mesh owner`); null on a user's node. */
	get owner(): string | null {
		return this.ownerLogin;
	}

	entries(): PoolMemberRow[] {
		return [...this.rows];
	}

	entry(nodeId: string): PoolMemberRow | undefined {
		return this.rows.find((r) => r.nodeId === nodeId);
	}

	set(row: PoolMemberRow) {
		this.rows = [...this.rows.filter((r) => r.nodeId !== row.nodeId), row];
		this.store?.setPoolMember(row);
		this.writeMirror();
	}

	remove(nodeId: string) {
		this.rows = this.rows.filter((r) => r.nodeId !== nodeId);
		this.store?.removePoolMember(nodeId);
		this.writeMirror();
	}

	setOwner(login: string | null) {
		this.ownerLogin = login;
		if (login === null) this.store?.metaDelete(OWNER_KEY);
		else this.store?.metaSet(OWNER_KEY, login);
		this.writeMirror();
	}

	private allowed(nodeId: string, login: string | null) {
		const e = this.entry(nodeId);
		return (
			e?.verdict === "allow" &&
			(e.login === null ||
				e.login.toLowerCase() === (login ?? "").toLowerCase())
		);
	}

	private denied(nodeId: string) {
		return this.entry(nodeId)?.verdict === "deny";
	}

	/**
	 * A tailnet node may be in the pool (discovery). With `ownerId` (the
	 * owner's user id, known on the owner's own nodes) the node's user id
	 * must match too: on a self-hosted control server two users can share a
	 * login name.
	 */
	admits(
		node: Pick<TailnetNode, "nodeId" | "login" | "tags"> & {
			userId?: string | null;
		},
		owner: string | null,
		ownerId: string | null = null,
	): boolean {
		if (this.denied(node.nodeId)) return false;
		const owned =
			owner !== null && node.tags.length === 0 && isOwner(node, owner, ownerId);
		return owned || this.allowed(node.nodeId, node.login);
	}

	/** A connection's `whois` identity may use `/fed` at all. */
	admitsCaller(
		who: Identity,
		owner: string,
		ownerId: string | null = null,
	): boolean {
		if (this.denied(who.nodeId)) return false;
		return isOwner(who, owner, ownerId) || this.allowed(who.nodeId, who.login);
	}

	/** A display copy (`pool.json`): names only; the daemon never reads it back. */
	private writeMirror() {
		const mirror = this.mirror;
		if (!mirror) return;
		const text = `${JSON.stringify(
			{
				"//": "Written by the pulsar daemon for display. Change it with `pulsar mesh`; edits here do nothing.",
				allow: this.rows
					.filter((r) => r.verdict === "allow")
					.map((r) => r.name),
				deny: this.rows.filter((r) => r.verdict === "deny").map((r) => r.name),
				...(this.ownerLogin ? { owner: this.ownerLogin } : {}),
			},
			null,
			"\t",
		)}\n`;
		// In order, in the background: a display copy never holds up the pool.
		this.mirrorWrite = this.mirrorWrite
			.then(() => writeFile(mirror, text, { mode: 0o600 }))
			.catch(() => {});
	}

	private mirrorWrite: Promise<void> = Promise.resolve();

	/** Resolves once the display copy written so far is on disk. */
	flushMirror(): Promise<void> {
		return this.mirrorWrite;
	}
}
