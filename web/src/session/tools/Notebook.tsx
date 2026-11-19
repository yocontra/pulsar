/**
 * Lazy: notebook cells, each with its kind and source: code highlighted,
 * Markdown rendered through the same sanitized Markdown as chat text.
 */
import { MessageResponse } from "../../components/ai-elements/message.tsx";
import { CodeBlock } from "../CodeBlock.tsx";
import type { Cell } from "./notebook.ts";

export default function NotebookCells({
	cells,
	lang = "python",
	mode,
}: {
	cells: Cell[];
	lang?: string;
	/** NotebookEdit's `edit_mode`: replace, insert or delete. */
	mode?: string;
}) {
	return (
		<ol className="ds-nb">
			{cells.map((c, i) => (
				<li key={c.id ?? i} className={`ds-nb-cell t-${c.type}`}>
					<div className="ds-nb-head">
						<span className="ds-nb-kind">
							{c.type === "markdown"
								? "Markdown"
								: c.type === "raw"
									? "Raw"
									: "Code"}
						</span>
						{c.id && <span className="ds-nb-id mono">{c.id}</span>}
						{mode && mode !== "replace" && (
							<span className="ds-nb-mode">
								{mode === "insert"
									? "New cell"
									: mode === "delete"
										? "Deleted"
										: mode}
							</span>
						)}
					</div>
					{mode === "delete" ? null : c.type === "markdown" ? (
						<div className="ds-nb-md">
							<MessageResponse>{c.source}</MessageResponse>
						</div>
					) : (
						<CodeBlock
							code={c.source}
							lang={c.type === "code" ? lang : null}
							header={false}
							maxLines={20}
						/>
					)}
				</li>
			))}
		</ol>
	);
}
