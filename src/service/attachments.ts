import { createHash, type Hash, randomBytes } from "node:crypto";
import {
	type FileHandle,
	mkdir,
	open,
	readdir,
	rename,
	rmdir,
	stat,
	unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type {
	AttachmentFileSpec,
	AttachmentManifest,
	AttachmentSaved,
	AttachmentUpload,
} from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import { sniffImage } from "../transcripts/tailer.ts";
import type { ActingHandler } from "./acting.ts";
import type { Principal } from "./caller.ts";
import type { RemoteAttachments } from "./pool.ts";

/**
 * Files the operator attaches to a message, saved on the agent's own
 * machine so the agent reads them by path (Claude Code's inbox takes text
 * only: the message names each file with an `Attached:` line).
 *
 * One upload is two steps:
 * 1. `attachments.upload`, an acting op (Prove Human here; on another
 *    machine the home node checks its own passkey assertion). Its params are
 *    the manifest: every file's name, type, size and SHA-256, plus a nonce.
 *    One proof covers the whole upload. The home node opens a short-lived
 *    upload bound to the operator's login.
 * 2. The bytes, per file, in order: streamed straight to disk here, or
 *    forwarded in chunks by the node the browser talks to. A chunk grants
 *    nothing: it lands only in an open upload of the same login, at the
 *    next offset, and the file is kept only when its size and SHA-256 match
 *    the signed manifest.
 *
 * Files are 0600 in `<state>/attachments/<agent>/<id>-<name>` (folders
 * 0700), removed after `keepMs`.
 */

export const ATTACH_LIMITS = {
	files: 10,
	imageBytes: 10 * 1024 * 1024,
	fileBytes: 25 * 1024 * 1024,
	/** What a relaying node forwards per federation frame. */
	chunkBytes: 1024 * 1024,
	/** Saved files are removed after this long. */
	keepMs: 7 * 24 * 60 * 60 * 1000,
	/** An upload takes bytes this long after its proof, or after its last chunk. */
	uploadMs: 15 * 60 * 1000,
	nameChars: 120,
} as const;

/** A file name safe to keep: no folders, control or shell-special characters. */
export function safeName(name: string): string {
	const base = name.split(/[/\\]/).pop() ?? "";
	const clean = base
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/[^\p{L}\p{N}._\- ()+@,=]/gu, "_")
		.replace(/\s+/g, " ")
		.replace(/^[.\s]+/, "")
		.trim();
	if (!clean) return "file";
	if (clean.length <= ATTACH_LIMITS.nameChars) return clean;
	// Keep the extension when shortening.
	const dot = clean.lastIndexOf(".");
	const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : "";
	return clean.slice(0, ATTACH_LIMITS.nameChars - ext.length) + ext;
}

const TYPE_RE =
	/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

/** Checks an `attachments.upload` manifest; throws `bad_request` / `too_large`. */
export function parseManifest(params: unknown): AttachmentManifest {
	const p = params as Partial<AttachmentManifest> | null;
	if (!p || typeof p !== "object" || Array.isArray(p))
		throw new RpcError("bad_request", "attachments: a manifest is required");
	if (typeof p.nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(p.nonce))
		throw new RpcError("bad_request", "attachments: nonce");
	if (!Array.isArray(p.files) || p.files.length === 0)
		throw new RpcError("bad_request", "attachments: no files");
	if (p.files.length > ATTACH_LIMITS.files)
		throw new RpcError(
			"too_large",
			`You can attach up to ${ATTACH_LIMITS.files} files per message.`,
		);
	const files = p.files.map((f: Partial<AttachmentFileSpec>) => {
		if (!f || typeof f !== "object")
			throw new RpcError("bad_request", "attachments: file");
		const name = typeof f.name === "string" ? f.name.slice(0, 1000) : "";
		const type =
			typeof f.type === "string" && TYPE_RE.test(f.type.toLowerCase())
				? f.type.toLowerCase()
				: "";
		const size = f.size;
		if (typeof size !== "number" || !Number.isInteger(size) || size < 0)
			throw new RpcError("bad_request", "attachments: size");
		if (size === 0)
			throw new RpcError(
				"bad_request",
				`'${safeName(name)}' is empty or could not be read.`,
			);
		const limit = type.startsWith("image/")
			? ATTACH_LIMITS.imageBytes
			: ATTACH_LIMITS.fileBytes;
		if (size > limit) throw tooLarge(name, type.startsWith("image/"));
		if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256))
			throw new RpcError("bad_request", "attachments: sha256");
		return { name, type, size, sha256: f.sha256 };
	});
	return { nonce: p.nonce, files };
}

function tooLarge(name: string, image: boolean): RpcError {
	const mb = (image ? ATTACH_LIMITS.imageBytes : ATTACH_LIMITS.fileBytes) >> 20;
	return new RpcError(
		"too_large",
		`'${safeName(name)}' is too large to attach (${image ? "images" : "files"} up to ${mb} MB).`,
	);
}

interface UploadFile {
	spec: AttachmentFileSpec;
	path: string;
	received: number;
	hash: Hash | null;
	handle: FileHandle | null;
	/** Sniffed from the first bytes. */
	image: string | null;
	saved: AttachmentSaved | null;
	/** One write at a time per file. */
	busy: boolean;
}

interface Upload {
	id: string;
	agent: string;
	login: string;
	expiresAt: number;
	files: UploadFile[];
}

export interface AttachmentsOptions {
	/** The root folder (default `<state>/attachments`). */
	dir: () => string;
	/** True when the id is an agent of this machine. */
	isLocal: (agentId: string) => boolean;
	now?: () => number;
}

/** A folder name for an agent id (ids hold `:` and other characters). */
const agentFolder = (id: string) =>
	id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 200);

const randomId = (bytes: number) => randomBytes(bytes).toString("base64url");

export class Attachments {
	/** Agents of other machines: bytes go through their home node. */
	remote: RemoteAttachments | null = null;
	private uploads = new Map<string, Upload>();
	private readonly o: AttachmentsOptions;
	private readonly now: () => number;

	constructor(o: AttachmentsOptions) {
		this.o = o;
		this.now = o.now ?? Date.now;
	}

	/** The `attachments.upload` acting handler: opens an upload for a checked manifest. */
	readonly handler: ActingHandler = async ({ user, agent, params }) => {
		if (!agent)
			throw new RpcError("bad_request", "attachments: agent required");
		const manifest = parseManifest(params);
		return this.open(user.login, agent, manifest);
	};

	private async open(
		login: string,
		agent: string,
		manifest: AttachmentManifest,
	): Promise<AttachmentUpload> {
		await this.expire();
		const root = this.o.dir();
		const dir = join(root, agentFolder(agent));
		await mkdir(root, { recursive: true, mode: 0o700 });
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const upload: Upload = {
			id: randomId(18),
			agent,
			login,
			expiresAt: this.now() + ATTACH_LIMITS.uploadMs,
			files: manifest.files.map((spec) => ({
				spec,
				path: join(dir, `${randomId(6)}-${safeName(spec.name)}`),
				received: 0,
				hash: null,
				handle: null,
				image: null,
				saved: null,
				busy: false,
			})),
		};
		this.uploads.set(upload.id, upload);
		return {
			upload: upload.id,
			expiresAt: upload.expiresAt,
			files: upload.files.map((f, index) => ({
				index,
				name: safeName(f.spec.name),
			})),
		};
	}

	/**
	 * Writes one chunk of a file at `offset` (the bytes received so far; 0
	 * starts the file over). Returns the bytes received and, once the file
	 * is complete and matches its manifest entry, the saved file.
	 */
	async write(
		login: string,
		agent: string,
		uploadId: string,
		index: number,
		offset: number,
		data: Uint8Array,
	): Promise<{ received: number; file: AttachmentSaved | null }> {
		const upload = this.uploads.get(uploadId);
		if (!upload || upload.login !== login || upload.agent !== agent)
			throw new RpcError("not_found", "no such upload");
		if (upload.expiresAt <= this.now()) {
			await this.drop(upload);
			throw new RpcError("gone", "the upload expired; attach the files again");
		}
		const f = Number.isInteger(index) ? upload.files[index] : undefined;
		if (!f) throw new RpcError("not_found", "no such file in the upload");
		if (f.busy) throw new RpcError("bad_request", "that file is being written");
		if (f.saved) {
			if (offset === f.spec.size && data.length === 0)
				return { received: f.received, file: f.saved };
			throw new RpcError("bad_request", "that file is complete");
		}
		f.busy = true;
		try {
			if (offset === 0 && f.received > 0) await this.reset(f);
			if (offset !== f.received)
				throw new RpcError(
					"bad_request",
					`expected offset ${f.received}, not ${offset}`,
				);
			if (f.received + data.length > f.spec.size)
				throw tooLarge(f.spec.name, !!f.image);
			if (!f.handle) {
				f.handle = await open(`${f.path}.part`, "w", 0o600);
				f.hash = createHash("sha256");
			}
			if (f.received === 0 && data.length > 0) {
				f.image = sniffImage(data);
				if (f.image && f.spec.size > ATTACH_LIMITS.imageBytes) {
					await this.reset(f);
					throw tooLarge(f.spec.name, true);
				}
			}
			if (data.length) {
				await f.handle.write(data);
				f.hash!.update(data);
				f.received += data.length;
				// A slow link keeps its upload open while bytes still arrive.
				upload.expiresAt = this.now() + ATTACH_LIMITS.uploadMs;
			}
			if (f.received < f.spec.size) return { received: f.received, file: null };
			const digest = f.hash!.digest("hex");
			await f.handle.close();
			f.handle = null;
			f.hash = null;
			if (digest !== f.spec.sha256) {
				await unlink(`${f.path}.part`).catch(() => {});
				f.received = 0;
				throw new RpcError(
					"bad_request",
					`'${safeName(f.spec.name)}' changed in transit; attach it again`,
				);
			}
			await rename(`${f.path}.part`, f.path);
			f.saved = {
				name: safeName(f.spec.name),
				type: savedType(f.spec.type, f.image),
				size: f.spec.size,
				path: f.path,
			};
			if (upload.files.every((x) => x.saved)) this.uploads.delete(upload.id);
			return { received: f.received, file: f.saved };
		} finally {
			f.busy = false;
		}
	}

	/**
	 * `PUT /agents/:id/attachments/:upload/:index`: one file's bytes from the
	 * browser. Here: straight to disk. Another machine's agent: forwarded in
	 * chunks of `chunkBytes` to its home node. Reading stops (`too_large`)
	 * past the largest file allowed, whatever the request claims.
	 */
	async receive(
		as: Principal,
		agentId: string,
		uploadId: string,
		index: number,
		body: ReadableStream<Uint8Array> | null,
	): Promise<{ received: number; file: AttachmentSaved }> {
		if (as.kind !== "human")
			throw new RpcError("forbidden", "only the human operator attaches files");
		const local = this.o.isLocal(agentId);
		if (!local && !(this.remote && agentId.includes("/")))
			throw new RpcError("not_found", `no agent ${agentId}`);
		const send = async (offset: number, data: Uint8Array) =>
			local
				? this.write(as.login, agentId, uploadId, index, offset, data)
				: this.remote!.chunk(
						agentId,
						{ upload: uploadId, index, offset, data },
						as,
					);
		let offset = 0;
		let last: { received: number; file: AttachmentSaved | null } = {
			received: 0,
			file: null,
		};
		let pending: Uint8Array[] = [];
		let pendingBytes = 0;
		const flush = async () => {
			if (!pendingBytes) return;
			const data =
				pending.length === 1
					? pending[0]!
					: Buffer.concat(pending, pendingBytes);
			pending = [];
			pendingBytes = 0;
			last = await send(offset, data);
			offset = last.received;
		};
		const reader = body?.getReader();
		try {
			while (reader) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value?.length) continue;
				if (offset + pendingBytes + value.length > ATTACH_LIMITS.fileBytes)
					throw new RpcError("too_large", "the file is over 25 MB");
				// Here every piece goes to disk as it comes; a relay batches.
				pending.push(value);
				pendingBytes += value.length;
				if (local || pendingBytes >= ATTACH_LIMITS.chunkBytes) await flush();
			}
			await flush();
		} finally {
			reader?.releaseLock();
		}
		if (!last.file) {
			// An empty body for a complete file answers what was saved.
			if (offset === 0) last = await send(0, new Uint8Array(0));
			if (!last.file)
				throw new RpcError(
					"bad_request",
					"the upload ended before the whole file arrived",
				);
		}
		return { received: last.received, file: last.file };
	}

	/** Removes saved files older than `keepMs` and forgets expired uploads. */
	async gc(): Promise<number> {
		await this.expire();
		const root = this.o.dir();
		const before = this.now() - ATTACH_LIMITS.keepMs;
		const partBefore = this.now() - ATTACH_LIMITS.uploadMs * 2;
		let removed = 0;
		let agents: string[];
		try {
			agents = await readdir(root);
		} catch {
			return 0;
		}
		for (const a of agents) {
			const dir = join(root, a);
			let names: string[];
			try {
				names = await readdir(dir);
			} catch {
				continue;
			}
			let left = names.length;
			for (const n of names) {
				const file = join(dir, n);
				const st = await stat(file).catch(() => null);
				if (!st?.isFile()) continue;
				const cutoff = n.endsWith(".part") ? partBefore : before;
				if (st.mtimeMs < cutoff) {
					await unlink(file).catch(() => {});
					removed++;
					left--;
				}
			}
			if (left === 0) await rmdir(dir).catch(() => {});
		}
		return removed;
	}

	/** Uploads past their time: close and remove their partial files. */
	private async expire() {
		const now = this.now();
		for (const u of [...this.uploads.values()])
			if (u.expiresAt <= now) await this.drop(u);
	}

	private async drop(u: Upload) {
		this.uploads.delete(u.id);
		for (const f of u.files) if (!f.saved) await this.reset(f);
	}

	private async reset(f: UploadFile) {
		await f.handle?.close().catch(() => {});
		f.handle = null;
		f.hash = null;
		f.received = 0;
		f.image = null;
		await unlink(`${f.path}.part`).catch(() => {});
	}
}

/** The type to report: the sniffed image type, else the browser's (never an image it isn't). */
function savedType(declared: string, image: string | null): string {
	if (image) return image;
	if (!declared || declared.startsWith("image/"))
		return "application/octet-stream";
	return declared;
}
