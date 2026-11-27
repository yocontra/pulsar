import type {
	AttachmentSaved,
	FileContent,
	FileEntry,
	FileSearch,
	FileTree,
} from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Principal } from "../service/caller.ts";
// The viewer's own caps, so a peer can't send more.
import { IMAGE_MAX, TEXT_MAX, TREE_MAX } from "../service/files.ts";
import type { RemoteAttachments } from "../service/pool.ts";
import { UPLOAD_IMAGE_ID } from "../upload-images.ts";
import type { Federation } from "./index.ts";

/** A home node too old for these ops. */
const OLD_NODE = new Set(["unsupported", "bad_request"]);

/** Image types the viewer shows (what the home node sniffed). */
const VIEW_IMAGES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);
const CONTENT_KINDS = new Set([
	"text",
	"image",
	"binary",
	"too_large",
	"sensitive",
]);

const str = (v: unknown, max: number) =>
	typeof v === "string" ? v.slice(0, max) : undefined;

/**
 * The file viewer of agents on other machines: reads forwarded to the
 * home node (it checks `transcript.read` for the user), replies checked
 * for shape and clamped to this node's own limits.
 */
export class RemoteFilesRelay {
	protected readonly fed: Federation;

	constructor(fed: Federation) {
		this.fed = fed;
	}

	async tree(address: string, path: string, as?: Principal): Promise<FileTree> {
		const r = await this.ask(address, { op: "files.tree", path }, as);
		if (!r)
			return {
				agent: address,
				path,
				available: false,
				reason: "unsupported",
				entries: [],
			};
		const t = (r.tree ?? {}) as Record<string, unknown>;
		const entries: FileEntry[] = Array.isArray(t.entries)
			? (t.entries as Record<string, unknown>[])
					.filter(
						(e) =>
							e &&
							typeof e.name === "string" &&
							typeof e.path === "string" &&
							(e.kind === "file" || e.kind === "dir"),
					)
					.slice(0, TREE_MAX)
					.map((e) => ({
						name: (e.name as string).slice(0, 1024),
						path: (e.path as string).slice(0, 4096),
						kind: e.kind as "file" | "dir",
					}))
			: [];
		return {
			agent: address,
			path: str(t.path, 4096) ?? path,
			available: t.available === true,
			...(t.reason ? { reason: String(t.reason).slice(0, 40) } : {}),
			entries,
			...(t.truncated === true ? { truncated: true } : {}),
		};
	}

	async read(
		address: string,
		path: string,
		as?: Principal,
		reveal = false,
	): Promise<FileContent> {
		const r = await this.ask(
			address,
			{ op: "files.read", path, ...(reveal ? { reveal } : {}) },
			as,
		);
		if (!r)
			return { agent: address, path, available: false, reason: "unsupported" };
		const c = (r.content ?? {}) as Record<string, unknown>;
		const kind = CONTENT_KINDS.has(String(c.kind))
			? (c.kind as FileContent["kind"])
			: undefined;
		return {
			agent: address,
			path: str(c.path, 4096) ?? path,
			available: c.available === true,
			...(c.reason ? { reason: String(c.reason).slice(0, 40) } : {}),
			...(kind ? { kind } : {}),
			...(typeof c.size === "number" ? { size: c.size } : {}),
			...(kind === "text" && typeof c.text === "string"
				? { text: c.text.slice(0, TEXT_MAX) }
				: {}),
			...(c.truncated === true ? { truncated: true } : {}),
			...(kind === "image" && VIEW_IMAGES.has(String(c.mediaType))
				? { mediaType: String(c.mediaType) }
				: {}),
			repoPath: str(c.repoPath, 4096) ?? null,
		};
	}

	async image(
		address: string,
		path: string,
		as?: Principal,
	): Promise<{ mediaType: string; data: Buffer }> {
		const r = await this.ask(
			address,
			{ op: "files.read", path, raw: true },
			as,
		);
		if (!r)
			throw new RpcError("unsupported", "that machine runs an older pulsar");
		const data =
			typeof r.data === "string" ? Buffer.from(r.data, "base64") : null;
		if (
			!data ||
			!VIEW_IMAGES.has(String(r.mediaType)) ||
			data.length > IMAGE_MAX
		)
			throw new RpcError("unsupported_media", "the home node sent no image");
		return { mediaType: String(r.mediaType), data };
	}

	/** The home node's reply; null when it is too old for these ops. */
	private async ask(
		address: string,
		action:
			| { op: "files.tree"; path: string }
			| { op: "files.read"; path: string; raw?: boolean; reveal?: boolean },
		as?: Principal,
	): Promise<Record<string, unknown> | null> {
		try {
			return await this.fed.act(
				address,
				{ ...action, agent: localId(address) },
				as,
			);
		} catch (e) {
			if (e instanceof RpcError && OLD_NODE.has(e.code)) return null;
			throw e;
		}
	}
}

/**
 * Attachments and the `@` file list of agents on other machines: forwarded
 * actions (`act` frames, carrying the user) to the agent's home node.
 */
export class RemoteAttachmentsRelay
	extends RemoteFilesRelay
	implements RemoteAttachments
{
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
		...(typeof f.imageRef === "string" && UPLOAD_IMAGE_ID.test(f.imageRef)
			? { imageRef: f.imageRef }
			: {}),
		name: f.name.slice(0, 200),
		type: f.type.slice(0, 130),
		size: f.size,
		path: f.path.slice(0, 4096),
	};
}
