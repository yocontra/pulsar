/**
 * A git unified diff → the rows `DiffBody` renders (session/Diff.tsx), with
 * a hunk header between hunks. Row `a` / `b` index the old-side and
 * new-side texts (`before` / `after`: every hunk's lines, in order), which
 * the highlighter tokenizes once each.
 */
import type { DiffItem, DiffRow } from "../session/Diff.tsx";

export interface ParsedPatch {
	items: DiffItem[];
	before: string;
	after: string;
	/** What the header says beyond the lines: "Renamed from x", "Mode 100644 → 100755". */
	notes: string[];
	added: number;
	removed: number;
	hunks: number;
}

export function parsePatch(patch: string): ParsedPatch {
	const items: DiffItem[] = [];
	const before: string[] = [];
	const after: string[] = [];
	const notes: string[] = [];
	let added = 0;
	let removed = 0;
	let hunks = 0;
	let inHunk = false;
	let oldMode = "";
	// The file's line numbers, from each hunk header ("@@ -12,7 +12,9 @@").
	let oldLine = 0;
	let newLine = 0;
	const lines = patch.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	for (const line of lines) {
		if (line.startsWith("@@")) {
			inHunk = true;
			const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			oldLine = m ? Number(m[1]) : 0;
			newLine = m ? Number(m[2]) : 0;
			items.push({ hunk: line, key: `h${hunks++}` });
			continue;
		}
		if (!inHunk || line.startsWith("diff --git ")) {
			inHunk = false;
			if (line.startsWith("rename from "))
				notes.push(`Renamed from ${line.slice(12)}`);
			else if (line.startsWith("copy from "))
				notes.push(`Copied from ${line.slice(10)}`);
			else if (line.startsWith("old mode ")) oldMode = line.slice(9);
			else if (line.startsWith("new mode "))
				notes.push(`Mode ${oldMode} → ${line.slice(9)}`);
			else if (line.startsWith("new file mode 120000"))
				notes.push("New symbolic link");
			else if (line.startsWith("deleted file mode")) notes.push("Deleted file");
			else if (/^Binary files .* differ$/.test(line))
				notes.push("Binary file changed");
			continue;
		}
		const sign = line[0];
		const text = line.slice(1);
		if (sign === "+") {
			const row: DiffRow = {
				sign: "+",
				b: after.length,
				text,
				newLine: newLine++,
			};
			after.push(text);
			items.push(row);
			added++;
		} else if (sign === "-") {
			const row: DiffRow = {
				sign: "-",
				a: before.length,
				text,
				oldLine: oldLine++,
			};
			before.push(text);
			items.push(row);
			removed++;
		} else if (sign === " " || line === "") {
			items.push({
				sign: " ",
				a: before.length,
				b: after.length,
				text,
				oldLine: oldLine++,
				newLine: newLine++,
			});
			before.push(text);
			after.push(text);
		}
		// "\ No newline at end of file": nothing to show.
	}
	return {
		items,
		before: before.join("\n"),
		after: after.join("\n"),
		notes,
		added,
		removed,
		hunks,
	};
}
