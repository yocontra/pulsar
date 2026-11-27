import { sessionNotice } from "../harnesses/acp-session-info.ts";
import type { ServerEvents } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Principal } from "../service/caller.ts";
import type { RemoteTranscripts } from "../service/pool.ts";
import {
	TRANSCRIPT_MISSING,
	type TranscriptMissing,
	type TranscriptPageResult,
} from "../service/transcripts.ts";
import { gapEvent, type TranscriptListener } from "../transcripts/tailer.ts";
import type {
	ImageType,
	MediaType,
	TranscriptEvent,
} from "../transcripts/types.ts";
import type { Federation } from "./index.ts";
import { readSse } from "./sse.ts";

const IMAGE_TYPES = new Set<ImageType>([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as ImageType[]);

/** Image and document URLs point at this node's API with the agent's pool address. */
function rewrite(
	address: string,
	events: TranscriptEvent[],
): TranscriptEvent[] {
	const url = (id: string) =>
		`/api/v1/agents/${encodeURIComponent(address)}/transcript/images/${encodeURIComponent(id)}`;
	return events.map((e) =>
		e.images?.length || e.documents?.length
			? {
					...e,
					...(e.images
						? { images: e.images.map((img) => ({ ...img, url: url(img.id) })) }
						: {}),
					...(e.documents
						? { documents: e.documents.map((d) => ({ ...d, url: url(d.id) })) }
						: {}),
				}
			: e,
	);
}

interface Watch {
	fns: Set<TranscriptListener>;
	ac: AbortController;
}

/**
 * Transcripts of agents on other machines: pages and images are forwarded
 * actions (`act` frames, carrying the user), live events one
 * `/fed/v1/transcript` stream per watched agent, shared by every viewer on
 * this node and closed with the last one.
 */
export class RemoteTranscriptReader implements RemoteTranscripts {
	private readonly fed: Federation;
	private watches = new Map<string, Watch>();

	private readonly onNotice?: (notice: ServerEvents["sessionNotice"]) => void;

	constructor(
		fed: Federation,
		onNotice?: (notice: ServerEvents["sessionNotice"]) => void,
	) {
		this.onNotice = onNotice;
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

	async page(
		address: string,
		cursor: string | null,
		as?: Principal,
	): Promise<TranscriptPageResult> {
		const { localId } = this.parts(address);
		const r = await this.fed.act(
			address,
			{ op: "transcript.page", agent: localId, cursor },
			as,
		);
		const page = r.page as TranscriptPageResult | undefined;
		if (!page || !Array.isArray(page.events))
			throw new RpcError("unreachable", "the home node sent no page");
		return {
			events: rewrite(address, page.events),
			cursor: typeof page.cursor === "string" ? page.cursor : null,
			available: page.available !== false,
			// An older home node says only `available: false`: a miss, never "none".
			...(page.available === false
				? {
						missing: TRANSCRIPT_MISSING.includes(
							page.missing as TranscriptMissing,
						)
							? page.missing
							: "not_found",
					}
				: {}),
		};
	}

	async image(address: string, imageId: string, as?: Principal) {
		const { localId } = this.parts(address);
		const r = await this.fed.act(
			address,
			{ op: "transcript.image", agent: localId, imageId },
			as,
		);
		const mediaType = r.mediaType as MediaType;
		if (
			!(
				IMAGE_TYPES.has(mediaType as ImageType) ||
				mediaType === "application/pdf"
			) ||
			typeof r.data !== "string"
		)
			throw new RpcError("unsupported_media", "the home node sent no image");
		return { mediaType, data: Buffer.from(r.data, "base64") };
	}

	subscribe(address: string, fn: TranscriptListener): () => void {
		let w = this.watches.get(address);
		if (!w) {
			w = { fns: new Set(), ac: new AbortController() };
			this.watches.set(address, w);
			this.follow(address, w);
		}
		w.fns.add(fn);
		return () => {
			const cur = this.watches.get(address);
			if (!cur) return;
			cur.fns.delete(fn);
			if (cur.fns.size === 0) {
				cur.ac.abort();
				this.watches.delete(address);
			}
		};
	}

	/**
	 * Keeps one live stream from the home node while anyone watches;
	 * reconnects after a drop. The home node sends only live events, so a
	 * reconnect after any miss starts with a gap marker (viewers re-page).
	 */
	private follow(address: string, w: Watch) {
		const { machineId, localId } = this.parts(address);
		void (async () => {
			let missed = false;
			while (!w.ac.signal.aborted) {
				const peer = this.fed.state.peers.get(machineId);
				if (peer && peer.link === "tailnet") {
					try {
						const q = new URLSearchParams({
							agent: localId,
							login: this.fed.ownerLogin ?? "",
							node: this.fed.nodeName,
						});
						const res = await this.fed.request(
							peer.node,
							`/fed/v1/transcript?${q}`,
							{
								signal: w.ac.signal,
								stream: true,
								version: peer.version,
							},
						);
						if (res.ok && res.body && missed)
							for (const fn of [...w.fns]) fn([gapEvent()]);
						if (res.ok && res.body)
							await readSse(
								res.body,
								(event, data) => {
									if (event === "sessionNotice") {
										if (w.ac.signal.aborted || !w.fns.size) return;
										try {
											// Bind to the watch's authenticated peer and target; the payload supplies only display text.
											const notice = sessionNotice(address, JSON.parse(data));
											if (notice) this.onNotice?.(notice);
										} catch {}
										return;
									}
									if (event !== "transcript") return;
									try {
										const { events } = JSON.parse(data) as {
											events: TranscriptEvent[];
										};
										if (!Array.isArray(events)) return;
										const out = rewrite(address, events);
										for (const fn of [...w.fns]) fn(out);
									} catch {}
								},
								w.ac.signal,
							);
						else await res.body?.cancel();
					} catch {}
				}
				if (w.ac.signal.aborted) return;
				missed = true;
				await new Promise((r) => setTimeout(r, 1000).unref?.());
			}
		})();
	}

	close() {
		for (const w of this.watches.values()) w.ac.abort();
		this.watches.clear();
	}
}
