/**
 * The phone's command sheet (Konsta in a SheetShell): a search field pinned
 * under the header, then grouped lists (Recent, Commands, Skills), or one
 * list by best match while searching. The list is the sheet's one scroller.
 * Tap a row to put `/name ` in the composer; Run sends a command that takes
 * no arguments at once.
 */
import { ListItem, Searchbar } from "konsta/react";
import { useRef } from "react";
import type { CommandCatalog, CommandEntry } from "../../api/types.ts";
import { needsTerminal, runsInOneTap } from "../../lib/slash.ts";
import { GroupedList } from "../../mobile/ui/GroupedList.tsx";
import { SheetShell } from "../../mobile/ui/SheetShell.tsx";

const SOURCE: Record<CommandEntry["source"], string> = {
	builtin: "Built-in",
	project: "Project",
	user: "User",
	plugin: "Plugin",
	agent: "Agent",
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
	const modal = useRef<HTMLIonModalElement>(null);
	const runnable = p.cat?.runnable ?? false;
	const rest = p.items.filter((c) => !p.recent.includes(c));
	// No query: grouped. A query: one list, best match first.
	const groups: Array<[string, CommandEntry[]]> = p.q
		? [["Best matches", p.items]]
		: [
				["Recent", p.recent],
				["Commands", rest.filter((c) => !c.skill)],
				["Skills", rest.filter((c) => c.skill)],
			];
	const rows = (list: CommandEntry[]) =>
		list.map((c) => (
			<Row
				key={c.name}
				c={c}
				runnable={runnable}
				onInsert={p.onInsert}
				onRun={p.onRun}
			/>
		));
	return (
		<SheetShell
			open={p.open}
			onClose={p.onClose}
			onClosed={p.onClosed}
			title="Skills & Commands"
			detents={[0, 0.7, 1]}
			initial={0.7}
			scrollBody
			grabber
			modalRef={modal}
			className="slash-modal"
			testId="slash-sheet"
			toolbar={
				<div className="slash-search">
					<Searchbar
						placeholder="Search commands and skills"
						value={p.q}
						onInput={(e: React.FormEvent<HTMLInputElement>) =>
							p.onQuery(e.currentTarget.value.replace(/^\//, ""))
						}
						onClear={() => p.onQuery("")}
						// Typing wants the whole height (the keyboard takes the bottom).
						onFocus={() =>
							void modal.current?.setCurrentBreakpoint(1).catch(() => {})
						}
					/>
				</div>
			}
		>
			<div className="slash-sheet">
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
					groups.map(
						([title, list]) =>
							list.length > 0 && (
								<GroupedList key={title} title={title} className="slash-list">
									{rows(list)}
								</GroupedList>
							),
					)
				)}
			</div>
		</SheetShell>
	);
}
