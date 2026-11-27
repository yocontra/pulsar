/**
 * The mock's attachments and `@` files (src/service/attachments.ts,
 * src/service/files.ts): the same manifest checks and hashes, files kept in
 * memory. A file named `flaky…` fails its first upload (the Retry tests).
 */
import { createHash, randomBytes } from "node:crypto";
import type {
	AttachmentPut,
	AttachmentUpload,
	FileHit,
} from "../../src/http/wire.ts";
import { RpcError } from "../../src/rpc.ts";
import { parseManifest, safeName } from "../../src/service/attachments.ts";
import { FILES_MAX, rankFiles } from "../../src/service/files.ts";
import { sniffImage } from "../../src/transcripts/tailer.ts";

interface MockUpload {
	agent: string;
	files: { name: string; type: string; size: number; sha256: string }[];
	saved: Set<number>;
}

const uploads = new Map<string, MockUpload>();
const flaked = new Set<string>();

export function openUpload(agent: string, params: unknown): AttachmentUpload {
	const m = parseManifest(params);
	const id = randomBytes(12).toString("base64url");
	uploads.set(id, { agent, files: m.files, saved: new Set() });
	return {
		upload: id,
		expiresAt: Date.now() + 15 * 60_000,
		files: m.files.map((f, index) => ({ index, name: safeName(f.name) })),
	};
}

export function putFile(
	agent: string,
	upload: string,
	index: number,
	bytes: Uint8Array,
): AttachmentPut {
	const u = uploads.get(upload);
	if (!u || u.agent !== agent)
		throw new RpcError("not_found", "no such upload");
	const f = u.files[index];
	if (!f) throw new RpcError("not_found", "no such file in the upload");
	if (f.name.startsWith("flaky") && !flaked.has(`${upload}/${index}`)) {
		flaked.add(`${upload}/${index}`);
		throw new RpcError("unreachable", "the connection dropped");
	}
	if (bytes.length !== f.size)
		throw new RpcError(
			"bad_request",
			"the upload ended before the whole file arrived",
		);
	if (createHash("sha256").update(bytes).digest("hex") !== f.sha256)
		throw new RpcError(
			"bad_request",
			`'${safeName(f.name)}' changed in transit; attach it again`,
		);
	u.saved.add(index);
	if (u.saved.size === u.files.length) uploads.delete(upload);
	const image = sniffImage(bytes);
	const name = safeName(f.name);
	const id = randomBytes(18).toString("base64url");
	return {
		received: bytes.length,
		file: {
			...(image && { imageRef: id }),
			name,
			type:
				image ??
				(f.type && !f.type.startsWith("image/")
					? f.type
					: "application/octet-stream"),
			size: f.size,
			path: `/Users/mock/.local/state/pulsar/attachments/${agent.replace(/[^\w.-]/g, "_")}/up_${id}-${name}`,
		},
	};
}

const PATHS = [
	"README.md",
	"CHANGELOG.md",
	"package.json",
	"docs/app.md",
	"docs/delivery.md",
	"src/cli.ts",
	"src/service/index.ts",
	"src/service/attachments.ts",
	"src/transport/http.ts",
	"web/src/components/Composer.tsx",
	"web/src/components/DesktopLayout.tsx",
	"web/src/lib/registry.tsx",
	"web/src/session/Transcript.tsx",
	"web/src/styles/app.css",
	"test/attachments.test.ts",
];
const ITEMS: FileHit[] = (() => {
	const dirs = new Set<string>();
	for (const p of PATHS) {
		const segs = p.split("/");
		for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
	}
	return [
		...[...dirs].map((path) => ({ path, kind: "dir" as const })),
		...PATHS.map((path) => ({ path, kind: "file" as const })),
	];
})();

export const searchFiles = (q: string): FileHit[] =>
	rankFiles(ITEMS, q).slice(0, FILES_MAX);
