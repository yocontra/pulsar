import type { ChangesMode, ChangesSummary, FileDiff } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Principal } from "../service/caller.ts";
import type { RemoteChanges } from "../service/pool.ts";
import type { Federation } from "./index.ts";
import { readSse } from "./sse.ts";

/** What an older home node (no changes ops) looks like to the app. */
function unsupported(address: string, mode: ChangesMode): ChangesSummary {
	return {
		agent: address,
		mode,
		available: false,
		reason: "unsupported",
		repo: null,
		root: null,
		branch: null,
		head: null,
		upstream: null,
		base: null,
		files: [],
		total: 0,
		truncated: false,
		added: 0,
		removed: 0,
		stamp: "unsupported",
	};
}

interface Watch {
	fns: Set<(s: ChangesSummary) => void>;
	ac: AbortController;
	last: ChangesSummary | null;
}

/**
 * Worktree changes of agents on other machines: the summary and a file's
 * diff are forwarded actions (`act` frames, carrying the user), live
 * summaries one `/fed/v1/changes` stream per watched agent and mode,
 * shared by every viewer on this node and closed with the last one.
 */
export class RemoteChangesReader implements RemoteChanges {
	private readonly fed: Federation;
	private watches = new Map<string, Watch>();

	constructor(fed: Federation) {
		this.fed = fed;
	}

	private parts(address: string) {
		const slash = address.indexOf("/");
		if (slash <= 0) throw new RpcError("not_found", `no agent ${address}`);
		return {
			machineId: address.slice(0, slash),
			localId: address.slice(slash + 1),
		};
	}

	async summary(
		address: string,
		mode: ChangesMode,
		as?: Principal,
	): Promise<ChangesSummary> {
		const { localId } = this.parts(address);
		let r: Record<string, unknown>;
		try {
			r = await this.fed.act(
				address,
				{ op: "changes.summary", agent: localId, mode },
				as,
			);
		} catch (e) {
			if (e instanceof RpcError && e.code === "unsupported")
				return unsupported(address, mode);
			throw e;
		}
		const s = r.summary as ChangesSummary | undefined;
		if (!s || !Array.isArray(s.files))
			throw new RpcError("unreachable", "the home node sent no summary");
		return { ...s, agent: address };
	}

	async file(
		address: string,
		mode: ChangesMode,
		path: string,
		as?: Principal,
	): Promise<FileDiff> {
		const { localId } = this.parts(address);
		const r = await this.fed.act(
			address,
			{ op: "changes.file", agent: localId, mode, path },
			as,
		);
		const d = r.diff as FileDiff | undefined;
		if (!d || typeof d.path !== "string")
			throw new RpcError("unreachable", "the home node sent no diff");
		return d;
	}

	watch(
		address: string,
		mode: ChangesMode,
		fn: (s: ChangesSummary) => void,
	): () => void {
		const key = `${address}\u0000${mode}`;
		let w = this.watches.get(key);
		if (!w) {
			w = { fns: new Set(), ac: new AbortController(), last: null };
			this.watches.set(key, w);
			this.follow(address, mode, w);
		} else if (w.last) fn(w.last);
		w.fns.add(fn);
		return () => {
			const cur = this.watches.get(key);
			if (!cur) return;
			cur.fns.delete(fn);
			if (cur.fns.size === 0) {
				cur.ac.abort();
				this.watches.delete(key);
			}
		};
	}

	/** One live stream from the home node while anyone watches; reconnects after a drop. */
	private follow(address: string, mode: ChangesMode, w: Watch) {
		const { machineId, localId } = this.parts(address);
		const emit = (s: ChangesSummary) => {
			w.last = s;
			for (const fn of [...w.fns]) fn(s);
		};
		void (async () => {
			while (!w.ac.signal.aborted) {
				const peer = this.fed.state.peers.get(machineId);
				if (peer && peer.link === "tailnet") {
					try {
						const q = new URLSearchParams({
							agent: localId,
							mode,
							login: this.fed.ownerLogin ?? "",
							node: this.fed.nodeName,
						});
						const res = await this.fed.request(
							peer.node,
							`/fed/v1/changes?${q}`,
							{
								signal: w.ac.signal,
								stream: true,
								version: peer.version,
							},
						);
						if (res.ok && res.body)
							await readSse(
								res.body,
								(event, data) => {
									if (event !== "changes") return;
									try {
										const s = JSON.parse(data) as ChangesSummary;
										if (!Array.isArray(s.files)) return;
										emit({ ...s, agent: address });
									} catch {}
								},
								w.ac.signal,
							);
						else {
							const code = await res
								.json()
								.then((b) => (b as { error?: { code?: string } }).error?.code)
								.catch(() => null);
							// An older home node: say so once, and stop asking.
							if (code === "unsupported") {
								emit(unsupported(address, mode));
								return;
							}
						}
					} catch {}
				}
				if (w.ac.signal.aborted) return;
				await new Promise((r) => setTimeout(r, 2000).unref?.());
			}
		})();
	}

	close() {
		for (const w of this.watches.values()) w.ac.abort();
		this.watches.clear();
	}
}
