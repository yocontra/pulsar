/**
 * Prove Human once per browser session: the open tabs of this app (same
 * origin, so the same machine's app) share one passkey-session token over a
 * BroadcastChannel. The token never touches storage for this: a channel is
 * memory-to-memory inside the browser, only between pages of this origin,
 * which could already read each other's memory through the same scripts.
 *
 * - A tab that opens (or reloads) asks; a tab holding a token answers, and
 *   the new tab adopts it. `ready` settles at the first answer, or after
 *   `waitMs` when no tab answers, so a gated action waits for it before
 *   opening Prove Human.
 * - Proving in any tab hands the token to every other tab.
 * - Signing out, or a token the daemon no longer knows, drops that token in
 *   every tab that holds it (only that token: a newer one stays).
 */

export interface ChannelLike {
	postMessage(message: unknown): void;
	onmessage: ((e: { data: unknown }) => void) | null;
	close(): void;
}

type Msg =
	| { t: "ask" }
	| { t: "token"; token: string }
	| { t: "drop"; token: string };

export interface TokenShare {
	/** Settles once another tab answered, or nobody did within `waitMs`. */
	ready: Promise<void>;
	/** This tab proved (`next`) or dropped `prev` (`next` null): tell the others. */
	announce(next: string | null, prev: string | null): void;
	close(): void;
}

export const CHANNEL = "pulsar.session";

function isMsg(d: unknown): d is Msg {
	const m = d as Msg | null;
	if (!m || typeof m !== "object") return false;
	if (m.t === "ask") return true;
	return (
		(m.t === "token" || m.t === "drop") &&
		typeof m.token === "string" &&
		m.token.length > 0 &&
		m.token.length <= 200
	);
}

export function shareToken(opts: {
	/** The token this tab holds now. */
	get(): string | null;
	/** Take `token` from another tab (null: drop ours), without announcing it. */
	adopt(token: string | null): void;
	channel?: ChannelLike | null;
	waitMs?: number;
}): TokenShare {
	const ch =
		opts.channel === undefined
			? typeof BroadcastChannel === "function"
				? (new BroadcastChannel(CHANNEL) as unknown as ChannelLike)
				: null
			: opts.channel;
	let settle = () => {};
	const ready = ch
		? new Promise<void>((resolve) => {
				const t = setTimeout(resolve, opts.waitMs ?? 150);
				settle = () => {
					clearTimeout(t);
					resolve();
				};
			})
		: Promise.resolve();
	if (ch) {
		ch.onmessage = (e) => {
			const m = e.data;
			if (!isMsg(m)) return;
			const mine = opts.get();
			if (m.t === "ask") {
				if (mine) ch.postMessage({ t: "token", token: mine } satisfies Msg);
			} else if (m.t === "token") {
				if (m.token !== mine) opts.adopt(m.token);
				settle();
			} else if (m.token === mine) opts.adopt(null);
		};
		ch.postMessage({ t: "ask" } satisfies Msg);
	}
	return {
		ready,
		announce(next, prev) {
			if (!ch) return;
			if (next) ch.postMessage({ t: "token", token: next } satisfies Msg);
			else if (prev) ch.postMessage({ t: "drop", token: prev } satisfies Msg);
		},
		close() {
			settle();
			ch?.close();
		},
	};
}
