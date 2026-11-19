import type { AttachmentSaved, FileSearch } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Principal } from "../service/caller.ts";
import type { RemoteAttachments } from "../service/pool.ts";
import type { Federation } from "./index.ts";

/** A home node too old for these ops. */
const OLD_NODE = new Set(["unsupported", "bad_request"]);

/**
 * Attachments and the `@` file list of agents on other machines: forwarded
 * actions (`act` frames, carrying the user) to the agent's home node.
 */
export class RemoteAttachmentsRelay implements RemoteAttachments {
	private readonly fed: Federation;

	constructor(fed: Federation) {
		this.fed = fed;
	}

	async chunk(
		address: string,
		chunk: { upload: string; index: number; offset: number; data: Uint8Array },
		as: Principal,
	): Promise<{ received: number; file: AttachmentSaved | null }> {
		const r = await this.fed.act(
			address,
			{
				op: "attachments.chunk",
				agent: localId(address),
				upload: chunk.upload,
				index: chunk.index,
				offset: chunk.offset,
				data: Buffer.from(chunk.data).toString("base64"),
			},
			as,
		);
		return {
			received: Number(r.received) || 0,
			file: savedFile(r.file),
		};
	}

	async files(address: string, q: string, as?: Principal): Promise<FileSearch> {
		try {
			const r = await this.fed.act(
				address,
				{ op: "files.search", agent: localId(address), q },
				as,
			);
			const f = r.files as FileSearch | undefined;
			return {
				agent: address,
				available: f?.available === true,
				...(f?.reason ? { reason: String(f.reason) } : {}),
				...(f?.truncated === true ? { truncated: true } : {}),
				items: Array.isArray(f?.items)
					? f.items
							.filter(
								(h) =>
									h &&
									typeof h.path === "string" &&
									(h.kind === "file" || h.kind === "dir"),
							)
							.slice(0, 50)
							.map((h) => ({ path: h.path.slice(0, 4096), kind: h.kind }))
					: [],
			};
		} catch (e) {
			if (e instanceof RpcError && OLD_NODE.has(e.code))
				return {
					agent: address,
					available: false,
					reason: "unsupported",
					items: [],
				};
			throw e;
		}
	}
}

function localId(address: string): string {
	const slash = address.indexOf("/");
	if (slash <= 0) throw new RpcError("not_found", `no agent ${address}`);
	return address.slice(slash + 1);
}

/** A saved file as the home node reported it, checked for shape. */
function savedFile(v: unknown): AttachmentSaved | null {
	if (!v || typeof v !== "object") return null;
	const f = v as Record<string, unknown>;
	if (
		typeof f.path !== "string" ||
		typeof f.name !== "string" ||
		typeof f.type !== "string" ||
		typeof f.size !== "number"
	)
		return null;
	return {
		name: f.name.slice(0, 200),
		type: f.type.slice(0, 130),
		size: f.size,
		path: f.path.slice(0, 4096),
	};
}
