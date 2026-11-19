/**
 * How a message names the files attached to it: one `Attached: <path>
 * (<type>, <size>)` line each, after the text (the daemon saved them on the
 * agent's machine; every harness reads them by path). The bubble shows those
 * lines as chips.
 */

export interface AttachedRef {
	path: string;
	name: string;
	type: string;
	size: string;
}

export function humanSize(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const attachedLine = (f: { path: string; type: string; size: number }) =>
	`Attached: ${f.path} (${f.type}, ${humanSize(f.size)})`;

const LINE =
	/^Attached: (.+) \(([\w.+-]+\/[\w.+-]+), (\d+(?:\.\d+)? (?:B|KB|MB))\)$/;

/** The text without its trailing `Attached:` lines, and those files. */
export function splitAttached(text: string): {
	text: string;
	files: AttachedRef[];
} {
	const lines = text.split("\n");
	const files: AttachedRef[] = [];
	let end = lines.length;
	while (end > 0) {
		const m = LINE.exec(lines[end - 1]!.trim());
		if (!m) break;
		const path = m[1]!;
		files.unshift({
			path,
			// Saved as `<id>-<name>`.
			name: (path.split(/[/\\]/).pop() ?? path).replace(/^[\w-]{8}-/, ""),
			type: m[2]!,
			size: m[3]!,
		});
		end--;
	}
	if (!files.length) return { text, files };
	return { text: lines.slice(0, end).join("\n").trimEnd(), files };
}

/** Previews of images this tab attached, by saved path (object URLs). */
export const attachedPreviews = new Map<string, string>();
