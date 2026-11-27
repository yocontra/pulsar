import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { UploadedImage } from "../upload-images.ts";

/** Paths come only from the home daemon's completed uploads, outside the message body. */
export async function acpPrompt(
	text: string,
	images?: UploadedImage[],
): Promise<ContentBlock[]> {
	const content: ContentBlock[] = [{ type: "text", text }];
	for (const image of images ?? []) {
		if (image.expiresAt <= Date.now())
			throw new Error("An uploaded image expired. Attach it again.");
		const file = await open(
			image.path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		).catch(() => {
			throw new Error("An uploaded image is unavailable. Attach it again.");
		});
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size !== image.size)
				throw new Error("An uploaded image changed. Attach it again.");
			const bytes = Buffer.alloc(image.size);
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesRead } = await file.read(
					bytes,
					offset,
					bytes.length - offset,
					offset,
				);
				if (!bytesRead) break;
				offset += bytesRead;
			}
			if (
				offset !== bytes.length ||
				createHash("sha256").update(bytes).digest("hex") !== image.sha256
			)
				throw new Error("An uploaded image changed. Attach it again.");
			content.push({
				type: "image",
				mimeType: image.mimeType,
				data: bytes.toString("base64"),
			});
		} finally {
			await file.close();
		}
	}
	return content;
}
