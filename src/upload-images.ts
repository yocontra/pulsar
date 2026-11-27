import { splitAttached } from "./attached-text.ts";
// Opaque IDs, issued only after an image matches the signed upload manifest.
export const UPLOAD_IMAGE_ID = /^[A-Za-z0-9_-]{24}$/;
export const MAX_UPLOAD_IMAGES = 10;
export function validImageRefs(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= MAX_UPLOAD_IMAGES &&
		value.every((id) => typeof id === "string" && UPLOAD_IMAGE_ID.test(id)) &&
		new Set(value).size === value.length
	);
}

/** Issued by the home daemon only, never accepted from a message sender. */
export interface UploadedImage {
	path: string;
	expiresAt: number;
	mimeType: string;
	size: number;
	sha256: string;
}

/** A queue edit can discard existing upload references. Text can never add one. */
export function retainedImageRefs(
	refs: string[],
	oldBody: string,
	newBody: string,
): string[] {
	const oldPaths = new Set(
		splitAttached(oldBody).files.map((file) => file.path),
	);
	const retained = new Set<string>();
	for (const file of splitAttached(newBody).files) {
		if (!oldPaths.has(file.path)) continue;
		const id = /^(?:.*[/\\])?up_([\w-]{24})-/.exec(file.path)?.[1];
		if (id) retained.add(id);
	}
	return refs.filter((id) => retained.has(id));
}
