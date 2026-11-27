export {
	type AttachedRef,
	attachedLine,
	humanSize,
	splitAttached,
} from "../../../src/attached-text.ts";

/** Previews of images this tab attached, by saved path (object URLs). */
export const attachedPreviews = new Map<string, string>();
