/** Notebook cells from a NotebookEdit call or a Read of an .ipynb file. */

export interface Cell {
	id?: string;
	type: "code" | "markdown" | "raw";
	source: string;
}

/** Claude's Read of a notebook: `<cell id="…">source</cell id="…">` blocks. */
export function readCells(text: string): Cell[] {
	const out: Cell[] = [];
	for (const m of text.matchAll(
		/<cell id="([^"]*)">(?:<cell_type>(\w+)<\/cell_type>)?([\s\S]*?)<\/cell id="[^"]*">/g,
	))
		out.push({
			id: m[1],
			type: m[2] === "markdown" ? "markdown" : m[2] === "raw" ? "raw" : "code",
			source: (m[3] ?? "").replace(/^\n|\n$/g, ""),
		});
	if (out.length) return out;
	// A whole .ipynb as JSON.
	try {
		const nb = JSON.parse(text) as { cells?: unknown[] };
		for (const c of nb.cells ?? []) {
			const cell = c as {
				cell_type?: string;
				source?: string | string[];
				id?: string;
			};
			out.push({
				id: cell.id,
				type:
					cell.cell_type === "markdown"
						? "markdown"
						: cell.cell_type === "raw"
							? "raw"
							: "code",
				source: Array.isArray(cell.source)
					? cell.source.join("")
					: (cell.source ?? ""),
			});
		}
	} catch {
		// Not a notebook.
	}
	return out;
}
