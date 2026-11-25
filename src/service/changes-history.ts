import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	patchFiles,
	patchText,
	toolKind,
	toolPath,
} from "../transcripts/describe.ts";
import { obj } from "../transcripts/summary.ts";
import type { ResolvedTranscript } from "../transcripts/tailer.ts";
import { newParseState, type TranscriptEvent } from "../transcripts/types.ts";

const HISTORY_BYTES = 4 * 1024 * 1024;
const RECORD_BYTES = 256 * 1024;

function editedWorktree(
	event: TranscriptEvent,
	cwd: string,
	root: string,
	canonicalCwd: string,
): boolean {
	const tool = event.tool;
	if (
		event.kind !== "tool_call" ||
		!tool?.done ||
		tool.isError ||
		tool.detail?.denied ||
		tool.detail?.interrupted ||
		tool.detail?.timedOutMs !== undefined ||
		(tool.detail?.exitCode ?? 0) !== 0
	)
		return false;
	const kind = toolKind(tool.name);
	if (
		kind !== "edit" &&
		kind !== "write" &&
		kind !== "patch" &&
		kind !== "notebook"
	)
		return false;
	// Some versions of the editor tool handle read-only "view" too.
	if (obj(tool.input)?.command === "view") return false;
	const paths =
		kind === "patch"
			? patchFiles(patchText(tool.input)).flatMap((file) => [
					file.path,
					file.moveTo ?? "",
				])
			: [toolPath(tool.input)];
	return paths.some((path) => {
		if (!path || /^[a-z][\w+.-]*:\/\//i.test(path)) return false;
		const base = tool.cwd && tool.cwd !== cwd ? tool.cwd : canonicalCwd;
		const target = resolve(base, path);
		// Git reports the canonical worktree root, while tool paths can use the
		// original working folder's alias (for example /var on macOS).
		const normalized = target.startsWith(`${cwd}${sep}`)
			? resolve(canonicalCwd, relative(cwd, target))
			: target;
		const rel = relative(root, normalized);
		return (
			!!rel &&
			!isAbsolute(rel) &&
			!["..", ".git"].includes(rel.split(sep, 1)[0] ?? "")
		);
	});
}

/** Bounded recent history for a proven local file, using each harness's parser. */
export async function hasHistoricalEdits(
	transcript: ResolvedTranscript | null,
	cwd: string,
	root: string,
): Promise<boolean | null> {
	const source = transcript?.source;
	if (!transcript || source?.kind !== "file" || source.guess) return false;
	const file = await open(source.path, "r");
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size === 0) return false;
		const size = Math.min(info.size, HISTORY_BYTES);
		const offset = info.size - size;
		let incomplete = offset > 0;
		const buffer = Buffer.allocUnsafe(size);
		const { bytesRead } = await file.read(buffer, 0, size, offset);
		const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
		const start =
			offset || source.headerLine
				? buffer.subarray(0, bytesRead).indexOf(10) + 1
				: 0;
		if ((offset || source.headerLine) && !start)
			return incomplete ? null : false;
		const state = newParseState({ atStart: offset === 0, cwd });
		const canonicalCwd = await realpath(cwd).catch(() => cwd);
		for (const line of buffer
			.subarray(start, Math.max(start, end))
			.toString("utf8")
			.split("\n")) {
			if (!line) continue;
			if (line.length > RECORD_BYTES) {
				incomplete = true;
				continue;
			}
			try {
				if (
					transcript
						.parse(line, state)
						.some((event) => editedWorktree(event, cwd, root, canonicalCwd))
				)
					return true;
			} catch {
				// A damaged record must not hide earlier or later edits.
			}
		}
		return incomplete ? null : false;
	} finally {
		await file.close();
	}
}
