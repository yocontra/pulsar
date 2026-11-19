/**
 * omp's own result formats, turned into the shapes the shared bodies show:
 * a read selector (`a.ts:10-40`) as the file and its line numbers, grep's
 * grouped matches (`# root` / `## file` / `*12|text`) as `file:line:text`,
 * and glob's grouped listing as plain paths.
 */
import {
	pathSelector,
	toolPath,
} from "../../../../src/transcripts/describe.ts";
import { type BodyProps, ListBody, ReadBody, SearchBody } from "./bodies.tsx";

const rec = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};

/** `a.ts:10-40` → the file, with its excerpt numbered from line 10. */
export function ompRead(p: BodyProps): BodyProps {
	const raw = toolPath(p.input);
	const sel = raw.includes(", ") ? null : pathSelector(raw);
	if (!sel) return p;
	const input = { ...rec(p.input), path: sel.path };
	const start = sel.ranges.length === 1 ? sel.ranges[0]!.start : 0;
	if (start <= 1) return { ...p, input };
	const lines = p.output.replace(/\n$/, "").split("\n");
	// Already numbered (`  12\t…`): leave it.
	if (lines.every((l) => /^\s*\d+(?:\t|→)/.test(l) || l === ""))
		return { ...p, input };
	const output = lines.map((l, i) => `${start + i}\t${l}`).join("\n");
	return { ...p, input, output };
}

/** A grouped header's name, without a trailing "(2 matches)". */
const header = (line: string) =>
	line
		.replace(/^#+\s+/, "")
		.replace(/\s+\([^)]*\)\s*$/, "")
		.trim();

/**
 * omp grep output as `file:line:text` rows; null when it has no match rows.
 * Headers nest: `# /root/`, then `## dir/` or `## file`, then `### file`.
 */
export function ompGrepRows(
	output: string,
	fallbackPath: string,
): string | null {
	const levels: string[] = [];
	const rows: string[] = [];
	for (const line of output.split("\n")) {
		const h = /^(#{1,3})\s/.exec(line);
		if (h) {
			const depth = h[1]!.length;
			levels.length = depth - 1;
			levels[depth - 1] = header(line);
			continue;
		}
		const m = /^\*\s*(\d+)\|(.*)$/.exec(line);
		if (!m) continue;
		// The root (`# /work/demo/`) is where the search ran; files are shown under it.
		const parts = levels.slice(1).filter(Boolean);
		const file = parts.length ? parts.join("") : fallbackPath;
		rows.push(`${file}:${m[1]}:${m[2]}`);
	}
	return rows.length ? rows.join("\n") : null;
}

/** omp glob output as one path per line, directory headers folded in. */
export function ompGlobRows(output: string): string {
	let dir = "";
	const rows: string[] = [];
	for (const line of output.split("\n")) {
		if (/^#\s/.test(line)) continue;
		if (/^##\s/.test(line)) {
			dir = header(line);
			continue;
		}
		if (line.trim())
			rows.push(dir.endsWith("/") ? dir + line.trim() : line.trim());
	}
	return rows.join("\n");
}

export function OmpReadBody(p: BodyProps) {
	return <ReadBody {...ompRead(p)} />;
}

export function OmpGrepBody(p: BodyProps) {
	const raw = toolPath(p.input);
	const rows = ompGrepRows(
		p.output,
		(pathSelector(raw)?.path ?? raw).split("/").pop() || "file",
	);
	return <SearchBody {...p} output={rows ?? p.output} />;
}

export function OmpGlobBody(p: BodyProps) {
	return <ListBody {...p} output={ompGlobRows(p.output)} />;
}
