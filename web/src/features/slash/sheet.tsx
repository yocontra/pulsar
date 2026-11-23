/**
 * The phone's command sheet (Konsta in a SheetShell): search, recent
 * commands, then everything by best match. Tap a row to put `/name ` in the
 * composer; Run sends a command that takes no arguments at once.
 */
import { List, ListItem, Searchbar } from "konsta/react";
import type { CommandCatalog, CommandEntry } from "../../api/types.ts";
import { needsTerminal, runsInOneTap } from "../../lib/slash.ts";
import { SheetShell } from "../../mobile/ui/SheetShell.tsx";

const SOURCE: Record<CommandEntry["source"], string> = {
	builtin: "Built-in",
	project: "Project",
	user: "User",
	plugin: "Plugin",
};

function Row({
	c,
	runnable,
	onInsert,
	onRun,
}: {
	c: CommandEntry;
	runnable: boolean;
	onInsert: (c: CommandEntry) => void;
	onRun: (c: CommandEntry) => void;
}) {
	const terminal = needsTerminal(c);
	// Nothing to type after it: one tap runs it.
	const direct = runnable && runsInOneTap(c);
	return (
		<ListItem
			className={terminal ? "slash-row is-off" : "slash-row"}
			title={
				<button
					type="button"
					className="slash-insert"
					disabled={terminal}
					onClick={() => onInsert(c)}
				>
					/{c.name}
				</button>
			}
			after={
				direct ? (
					<button
						type="button"
						className="slash-run"
						aria-label={`Run /${c.name}`}
						onClick={() => onRun(c)}
					>
						Run
					</button>
				) : undefined
			}
			subtitle={`${c.skill ? `${SOURCE[c.source]} skill` : SOURCE[c.source]}${c.args ? ` · ${c.args}` : ""}`}
			text={
				terminal ? "Opens a dialog only the terminal can answer" : c.description
			}
		/>
	);
}

export function CommandSheetView(p: {
	open: boolean;
	onClose: () => void;
	onClosed: () => void;
	q: string;
	onQuery: (q: string) => void;
	cat: CommandCatalog | null;
	error: string | null;
	items: CommandEntry[];
	recent: CommandEntry[];
	onInsert: (c: CommandEntry) => void;
	onRun: (c: CommandEntry) => void;
}) {
	const runnable = p.cat?.runnable ?? false;
	const rest = p.items.filter((c) => !p.recent.includes(c));
	return (
		<SheetShell
			open={p.open}
			onClose={p.onClose}
			onClosed={p.onClosed}
			title="Commands"
			detents={[0, 0.7, 1]}
			initial={0.7}
			className="slash-modal"
			testId="slash-sheet"
		>
			<div className="slash-sheet">
				<Searchbar
					placeholder="Search commands and skills"
					value={p.q}
					onInput={(e: React.FormEvent<HTMLInputElement>) =>
						p.onQuery(e.currentTarget.value.replace(/^\//, ""))
					}
					onClear={() => p.onQuery("")}
				/>
				{p.cat && !p.cat.runnable && (
					<p className="slash-empty slash-warn" role="status">
						{p.cat.reason ?? "Pulsar can't run commands for this agent."}
					</p>
				)}
				{p.error ? (
					<p className="slash-empty" role="alert">
						{p.error}
					</p>
				) : !p.cat ? (
					<p className="slash-empty" role="status">
						Loading commands…
					</p>
				) : !p.items.length ? (
					<p className="slash-empty">No matching commands.</p>
				) : (
					<>
						{p.recent.length > 0 && (
							<List strong inset className="slash-list" aria-label="Recent">
								{p.recent.map((c) => (
									<Row
										key={c.name}
										c={c}
										runnable={runnable}
										onInsert={p.onInsert}
										onRun={p.onRun}
									/>
								))}
							</List>
						)}
						<List strong inset className="slash-list" aria-label="Commands">
							{rest.map((c) => (
								<Row
									key={c.name}
									c={c}
									runnable={runnable}
									onInsert={p.onInsert}
									onRun={p.onRun}
								/>
							))}
						</List>
					</>
				)}
			</div>
		</SheetShell>
	);
}
