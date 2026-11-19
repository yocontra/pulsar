/**
 * The expanded view of each kind of tool call: the right shape for what the
 * tool did (a terminal, a diff per file, a checklist, search results, the
 * questions asked, a JSON tree), never a raw argument dump. Heavy views
 * (notebooks, JSON trees, ANSI colors) load lazily.
 */
import {
	CheckIcon,
	CircleCheckIcon,
	CircleDashedIcon,
	CircleIcon,
	CircleSlashIcon,
	ExternalLinkIcon,
	FileIcon,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useMemo } from "react";
import { commandRun } from "../../../../src/transcripts/command.ts";
import {
	type PatchFile,
	patchFiles,
	type Question,
	questions,
	shellCommand,
	type Todo,
	type ToolKind,
	todos,
	toolPath,
} from "../../../../src/transcripts/describe.ts";
import type { ToolDetail } from "../../api/types.ts";
import { MessageResponse } from "../../components/ai-elements/message.tsx";
import { plural } from "../../lib/format.ts";
import { CodeBlock, TerminalBlock } from "../CodeBlock.tsx";
import { Diff } from "../Diff.tsx";
import { langForPath } from "../highlight.tsx";
import { CommandBody } from "./CommandBody.tsx";
import { readCells } from "./notebook.ts";

export { CommandBody } from "./CommandBody.tsx";

const JsonView = lazy(() => import("./JsonView.tsx"));
const NotebookCells = lazy(() => import("./Notebook.tsx"));

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};

export interface BodyProps {
	name: string;
	input: unknown;
	/** The result's text (without the `[image]` placeholders). */
	output: string;
	detail?: ToolDetail;
	isError: boolean;
	layout: "split" | "unified";
	done: boolean;
	/** The agent's project folder (its cwd), when known. */
	agentCwd?: string | null;
	/** The folder the log recorded for this call, when it says. */
	callCwd?: string;
}

/** Quiet loading line while a lazy view loads. */
function Loading() {
	return <div className="ds-tool-note">Loading…</div>;
}

/** The JSON value in a string, when the whole string is JSON. */
export function asJson(text: string): unknown {
	const t = text.trim();
	if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
	try {
		return JSON.parse(t) as unknown;
	} catch {
		return undefined;
	}
}

/** `<tool_use_error>…</tool_use_error>` → its message. */
export function errorText(text: string): string {
	return text
		.replace(/<\/?tool_use_error>/g, "")
		.replace(/^Error:\s*/i, "")
		.trim();
}

// ------------------------------------------------------------------ states

/** A refused, stopped or failed call, in words. */
export function StateNote({
	detail,
	isError,
	output,
}: Pick<BodyProps, "detail" | "isError" | "output">) {
	if (detail?.denied)
		return (
			<p className="ds-tool-state-note is-denied" role="note">
				<CircleSlashIcon aria-hidden="true" />
				Not run: permission was denied.
			</p>
		);
	if (detail?.interrupted)
		return (
			<p className="ds-tool-state-note is-stopped" role="note">
				<CircleSlashIcon aria-hidden="true" />
				Stopped before it finished.
			</p>
		);
	if (isError && output.trim())
		return (
			<CodeBlock
				className="tool-out"
				code={errorText(output)}
				tone="error"
				title="Error"
				maxLines={14}
			/>
		);
	return null;
}

/** True when the state note already says everything about the result. */
const settled = (p: BodyProps) =>
	!!p.detail?.denied || !!p.detail?.interrupted || p.isError;

// ------------------------------------------------------------------ shell

export function shellStatus(p: BodyProps): string | undefined {
	const d = p.detail;
	if (d?.denied) return "Denied";
	if (d?.interrupted) return "Interrupted";
	if (d?.timedOutMs)
		return d.timedOutMs % 60_000 === 0
			? `Timed out after ${d.timedOutMs / 60_000} min`
			: `Timed out after ${Math.round(d.timedOutMs / 1000)} s`;
	if (d?.background) return "In background";
	if (d?.exitCode !== undefined && d.exitCode !== 0)
		return `Exit ${d.exitCode}`;
	if (p.isError) return "Failed";
	return undefined;
}

/** Output without the exit-code line the harness appended. */
export function shellOutput(text: string): string {
	return text.replace(/\n?Exit code:? -?\d+\s*$/i, "");
}

export function ShellBody(p: BodyProps) {
	const a = rec(p.input);
	const cmd = shellCommand(p.input);
	const title = str(a.description) || str(a.i);
	if (p.detail?.denied || p.detail?.interrupted)
		return (
			<>
				{cmd && (
					<TerminalBlock command={cmd} title={title} status={shellStatus(p)} />
				)}
				<StateNote {...p} />
			</>
		);
	if (!cmd)
		return p.output ? (
			<CodeBlock
				className="tool-out"
				code={p.output}
				tone={p.isError ? "error" : "terminal"}
				title={p.isError ? "Error" : "Output"}
				maxLines={14}
			/>
		) : null;
	return (
		<TerminalBlock
			command={cmd}
			output={shellOutput(p.output)}
			title={title}
			failed={p.isError}
			status={shellStatus(p)}
		/>
	);
}

// ------------------------------------------------------------------ code

/** Codex code mode prints a header before the script's own output. */
function scriptOutput(text: string): string {
	return text.replace(/^Script completed\nWall time [^\n]*\nOutput:\n?/, "");
}

export function CodeBody(p: BodyProps) {
	// A Codex script that runs commands: shown as those commands.
	if (typeof p.input === "string" && commandRun(p.name, p.input))
		return <CommandBody {...p} />;
	const bare = typeof p.input === "string";
	const a = rec(p.input);
	const script = typeof p.input === "string" ? p.input : str(a.code);
	const lang = bare ? "javascript" : str(a.language) || null;
	return (
		<>
			{script && (
				<CodeBlock
					code={script}
					lang={lang}
					title={bare ? "Script" : undefined}
					maxLines={14}
					format
				/>
			)}
			{settled(p) ? (
				<StateNote {...p} />
			) : p.output.trim() ? (
				<CodeBlock
					className="tool-out"
					code={scriptOutput(p.output)}
					tone="terminal"
					title="Output"
					maxLines={14}
				/>
			) : null}
		</>
	);
}

// ------------------------------------------------------------------ files

/** Read output as file text: reminders dropped, `   12\t` prefixes as line numbers. */
export function fileText(output: string): { text: string; start: number } {
	const clean = output
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\n?/g, "")
		.replace(/\n$/, "");
	const lines = clean.split("\n");
	const num = /^\s*(\d+)(?:\t|→)/;
	if (lines.length && lines.every((l) => num.test(l) || l === "")) {
		const first = num.exec(lines[0] ?? "");
		return {
			text: lines.map((l) => l.replace(num, "")).join("\n"),
			start: first ? Number(first[1]) : 1,
		};
	}
	return { text: clean, start: 1 };
}

export function ReadBody(p: BodyProps) {
	const path = toolPath(p.input);
	if (settled(p)) return <StateNote {...p} />;
	if (!p.output.trim()) return null;
	if (/\.ipynb$/i.test(path)) {
		const cells = readCells(p.output);
		if (cells.length)
			return (
				<Suspense fallback={<Loading />}>
					<NotebookCells cells={cells} />
				</Suspense>
			);
	}
	const { text, start } = fileText(p.output);
	return (
		<CodeBlock
			className="tool-out"
			code={text}
			lang={langForPath(path)}
			title={path.split("/").pop() || "File"}
			lineNumbers
			startLine={start}
			maxLines={16}
		/>
	);
}

interface EditPair {
	before: string;
	after: string;
}

/** The edits in an Edit/MultiEdit/str_replace call, any harness's names. */
export function editPairs(input: unknown): EditPair[] {
	const a = rec(input);
	const list = Array.isArray(a.edits) ? a.edits : [a];
	return list.map((e) => {
		const o = rec(e);
		return {
			before:
				str(o.old_string) ||
				str(o.oldText) ||
				str(o.old_str) ||
				str(o.oldString),
			after:
				str(o.new_string) ||
				str(o.newText) ||
				str(o.new_str) ||
				str(o.newString),
		};
	});
}

export function EditBody(p: BodyProps) {
	const path = toolPath(p.input);
	const lang = langForPath(path);
	const pairs = useMemo(() => editPairs(p.input), [p.input]);
	return (
		<>
			{settled(p) && <StateNote {...p} />}
			{pairs.map((e, i) => (
				<div key={i} className="ds-edit">
					{pairs.length > 1 && (
						<div className="ds-edit-label">
							Edit {i + 1} of {pairs.length}
						</div>
					)}
					<Diff
						before={e.before}
						after={e.after}
						lang={lang}
						layout={p.layout}
					/>
				</div>
			))}
		</>
	);
}

export function WriteBody(p: BodyProps) {
	const path = toolPath(p.input);
	const content = str(rec(p.input).content);
	return (
		<>
			{settled(p) && <StateNote {...p} />}
			<CodeBlock
				code={content}
				lang={langForPath(path)}
				title={path || "New file"}
				lineNumbers
				maxLines={16}
			/>
		</>
	);
}

/** A file's patch lines as before/after text for the diff view. */
function patchSides(f: PatchFile): { before: string; after: string } {
	const before: string[] = [];
	const after: string[] = [];
	for (const line of f.lines) {
		if (line.startsWith("@@")) continue;
		const sign = line[0];
		const text = line.slice(1);
		if (sign === "-") before.push(text);
		else if (sign === "+") after.push(text);
		else {
			before.push(text);
			after.push(text);
		}
	}
	return { before: before.join("\n"), after: after.join("\n") };
}

const OP: Record<PatchFile["op"], string> = {
	add: "Added",
	update: "Changed",
	delete: "Deleted",
};

export function PatchBody(p: BodyProps) {
	const a = rec(p.input);
	const patch =
		typeof p.input === "string" ? p.input : str(a.input) || str(a.patch);
	const files = useMemo(() => patchFiles(patch), [patch]);
	return (
		<>
			{settled(p) && <StateNote {...p} />}
			{files.map((f) => {
				const sides = patchSides(f);
				return (
					<section key={f.path} className="ds-patch-file">
						<header className="ds-patch-head">
							<span className={`ds-patch-op op-${f.op}`}>
								{f.moveTo ? "Moved" : OP[f.op]}
							</span>
							<span className="ds-patch-path mono">
								{f.path}
								{f.moveTo ? ` → ${f.moveTo}` : ""}
							</span>
							{(f.added > 0 || f.removed > 0) && (
								<span className="ds-diffstat">
									<span className="add">+{f.added}</span>
									{f.removed > 0 && <span className="del">−{f.removed}</span>}
								</span>
							)}
						</header>
						{f.op === "delete" ? (
							<p className="ds-tool-note">The file was deleted.</p>
						) : f.op === "add" ? (
							<CodeBlock
								code={sides.after}
								lang={langForPath(f.path)}
								header={false}
								lineNumbers
								maxLines={16}
							/>
						) : (
							<Diff
								before={sides.before}
								after={sides.after}
								lang={langForPath(f.moveTo ?? f.path)}
								layout={p.layout}
							/>
						)}
					</section>
				);
			})}
		</>
	);
}

export function NotebookBody(p: BodyProps) {
	const a = rec(p.input);
	const type = str(a.cell_type);
	return (
		<>
			{settled(p) && <StateNote {...p} />}
			<Suspense fallback={<Loading />}>
				<NotebookCells
					cells={[
						{
							id: str(a.cell_id) || undefined,
							type: type === "markdown" || type === "raw" ? type : "code",
							source: str(a.new_source),
						},
					]}
					mode={str(a.edit_mode) || undefined}
				/>
			</Suspense>
		</>
	);
}

// ------------------------------------------------------------------ search

interface Match {
	line?: number;
	text: string;
}

/** `path:line:text` grep output grouped by file; null when it isn't shaped so. */
export function grepGroups(
	output: string,
): Array<{ path: string; matches: Match[] }> | null {
	const rows = output.split("\n").filter((l) => l.trim());
	if (!rows.length) return null;
	const groups = new Map<string, Match[]>();
	for (const row of rows) {
		const m = /^([^:\n]+?):(\d+)[:-](.*)$/.exec(row);
		if (!m) return null;
		const list = groups.get(m[1]!) ?? [];
		list.push({ line: Number(m[2]), text: m[3]! });
		groups.set(m[1]!, list);
	}
	return [...groups].map(([path, matches]) => ({ path, matches }));
}

const MAX_ROWS = 40;

export function SearchBody(p: BodyProps) {
	if (settled(p)) return <StateNote {...p} />;
	if (!p.output.trim() || p.detail?.count === 0)
		return <p className="ds-tool-note">No matches.</p>;
	const groups = grepGroups(p.output);
	if (!groups) return <ListBody {...p} />;
	return (
		<div className="ds-matches">
			{groups.slice(0, MAX_ROWS).map((g) => (
				<section key={g.path} className="ds-match-file">
					<div className="ds-match-path mono">
						<FileIcon aria-hidden="true" />
						{g.path}
						<span className="ds-match-count">
							{plural(g.matches.length, "match", "matches")}
						</span>
					</div>
					<ol className="ds-match-lines mono">
						{g.matches.map((m, i) => (
							<li key={i}>
								<span className="ds-ln">{m.line}</span>
								<span className="ds-match-text">{m.text}</span>
							</li>
						))}
					</ol>
				</section>
			))}
		</div>
	);
}

/** One path per line (Glob, LS, find): a file list, the rest folded. */
export function ListBody(p: BodyProps) {
	if (settled(p)) return <StateNote {...p} />;
	const rows = p.output
		.split("\n")
		.map((l) => l.replace(/^\s*-\s+/, "").trimEnd())
		.filter((l) => l.trim());
	if (!rows.length) return <p className="ds-tool-note">No files.</p>;
	const shown = rows.slice(0, MAX_ROWS);
	return (
		<div className="ds-files">
			<ul className="mono">
				{shown.map((r, i) => (
					<li key={i}>
						<FileIcon aria-hidden="true" />
						{r}
					</li>
				))}
			</ul>
			{rows.length > shown.length && (
				<p className="ds-tool-note">and {rows.length - shown.length} more</p>
			)}
		</div>
	);
}

// ------------------------------------------------------------------ web

function domain(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

/** Claude's web search text after the query line and the Links JSON. */
function searchProse(output: string): string {
	return output
		.replace(/^Web search results for query:[^\n]*\n*/i, "")
		.replace(/Links:\s*\[[\s\S]*?\]\s*(?:\n|$)/, "")
		.trim();
}

export function WebSearchBody(p: BodyProps) {
	if (settled(p)) return <StateNote {...p} />;
	const links = p.detail?.links ?? [];
	const prose = searchProse(p.output);
	if (!links.length && !prose)
		return p.done ? (
			<p className="ds-tool-note">The search returned no list of results.</p>
		) : null;
	return (
		<>
			{links.length > 0 && (
				<ol className="ds-results">
					{links.map((l) => (
						<li key={l.url}>
							<a
								href={l.url}
								target="_blank"
								rel="noopener noreferrer nofollow"
							>
								<span className="ds-result-title">{l.title}</span>
								<span className="ds-result-domain">
									{domain(l.url)}
									<ExternalLinkIcon aria-hidden="true" />
								</span>
							</a>
						</li>
					))}
				</ol>
			)}
			{prose && (
				<div className="ds-tool-prose">
					<MessageResponse>{prose}</MessageResponse>
				</div>
			)}
		</>
	);
}

export function FetchBody(p: BodyProps) {
	const prompt = str(rec(p.input).prompt);
	return (
		<>
			{prompt && <p className="ds-tool-desc">Looked for: {prompt}</p>}
			{settled(p) ? (
				<StateNote {...p} />
			) : p.output.trim() ? (
				<div className="ds-tool-prose is-folded">
					<MessageResponse>{p.output}</MessageResponse>
				</div>
			) : null}
		</>
	);
}

// ------------------------------------------------------------------ plans

const TODO_ICON: Record<Todo["status"], ReactNode> = {
	done: <CircleCheckIcon aria-label="Done" />,
	active: <CircleDashedIcon aria-label="In progress" />,
	todo: <CircleIcon aria-label="To do" />,
	cancelled: <CircleSlashIcon aria-label="Cancelled" />,
};

export function Checklist({ items }: { items: Todo[] }) {
	return (
		<ul className="ds-todos">
			{items.map((t, i) => (
				<li key={i} className={`t-${t.status}`}>
					{TODO_ICON[t.status]}
					<span>{t.text}</span>
				</li>
			))}
		</ul>
	);
}

export function TodoBody(p: BodyProps) {
	const list = todos(p.input);
	const why = str(rec(p.input).explanation);
	return (
		<>
			{why && <p className="ds-tool-desc">{why}</p>}
			{list?.length ? (
				<Checklist items={list} />
			) : p.output.trim() ? (
				<CodeBlock code={p.output} tone="terminal" title="Plan" maxLines={14} />
			) : null}
		</>
	);
}

/** ExitPlanMode: the plan as Markdown, and whether you approved it. */
export function PlanBody(p: BodyProps) {
	const plan = str(rec(p.input).plan);
	const approved = /\bapproved\b/i.test(p.output) && !p.isError;
	const rejected = p.isError || /doesn't want|rejected|denied/i.test(p.output);
	return (
		<>
			{plan && (
				<div className="ds-plan">
					<MessageResponse>{plan}</MessageResponse>
				</div>
			)}
			{p.done && (
				<p
					className={`ds-plan-verdict ${approved ? "is-yes" : rejected ? "is-no" : ""}`}
				>
					{approved ? (
						<>
							<CheckIcon aria-hidden="true" />
							You approved the plan.
						</>
					) : rejected ? (
						<>
							<CircleSlashIcon aria-hidden="true" />
							You did not approve the plan.
						</>
					) : (
						"The plan was shown to you."
					)}
				</p>
			)}
		</>
	);
}

/** The answer pulsar can show for a question: from the detail, else omp's JSON reply. */
function answerFor(q: Question, i: number, p: BodyProps): string | undefined {
	const found =
		p.detail?.answers?.find((a) => a.question === q.question) ??
		p.detail?.answers?.[i];
	if (found) return found.answer;
	const json = asJson(p.output.replace(/^User response:\s*/i, ""));
	const o = rec(json);
	const v = Object.values(o)[0];
	return typeof v === "string" ? v : undefined;
}

export function QuestionBody(p: BodyProps) {
	const a = rec(p.input);
	const list = questions(p.input);
	// omp asks in HTML: show its plain intent, never the markup.
	const asked = list.length
		? list
		: str(a.i)
			? [{ question: str(a.i), options: [] }]
			: [];
	return (
		<>
			{asked.map((q, i) => {
				const answer = answerFor(q, i, p);
				const picked = answer ? answer.split(", ") : [];
				return (
					<section key={i} className="ds-question">
						{q.header && <span className="ds-question-tag">{q.header}</span>}
						<p className="ds-question-text">{q.question}</p>
						{q.options.length > 0 && (
							<ul className="ds-options">
								{q.options.map((o) => {
									const chosen = picked.includes(o.label);
									return (
										<li
											key={o.label}
											className={chosen ? "is-chosen" : undefined}
										>
											<span className="ds-option-mark" aria-hidden="true">
												{chosen ? <CheckIcon /> : null}
											</span>
											<span className="ds-option-label">{o.label}</span>
											{o.description && (
												<span className="ds-option-desc">{o.description}</span>
											)}
											{chosen && <span className="sr-only">(your answer)</span>}
										</li>
									);
								})}
							</ul>
						)}
						{answer && !q.options.some((o) => picked.includes(o.label)) && (
							<p className="ds-answer">
								<span className="ds-answer-label">You answered</span> {answer}
							</p>
						)}
					</section>
				);
			})}
			{settled(p) && <StateNote {...p} />}
		</>
	);
}

// ------------------------------------------------------------------ agents

export function TaskBody(p: BodyProps) {
	const a = rec(p.input);
	const tasks = Array.isArray(a.tasks) ? a.tasks.map(rec) : [];
	const prompt =
		str(a.prompt) || str(a.message) || str(a.context) || str(a.task);
	return (
		<>
			{prompt && (
				<div className="ds-tool-prose is-folded">
					<MessageResponse>{prompt}</MessageResponse>
				</div>
			)}
			{tasks.length > 0 && (
				<ul className="ds-subtasks">
					{tasks.map((t, i) => (
						<li key={i}>
							<span className="ds-subtask-name mono">
								{str(t.name) || `Task ${i + 1}`}
							</span>
							<span className="ds-subtask-text">{str(t.task)}</span>
						</li>
					))}
				</ul>
			)}
			<ResultProse {...p} />
		</>
	);
}

/** A result written for people (Markdown), or the state note. */
function ResultProse(p: BodyProps) {
	if (settled(p)) return <StateNote {...p} />;
	const t = p.output.trim();
	if (!t) return null;
	const json = asJson(t);
	if (json !== undefined) return <JsonBlock value={json} title="Result" />;
	return (
		<div className="ds-tool-prose is-folded">
			<MessageResponse>{t}</MessageResponse>
		</div>
	);
}

export function MessageBody(p: BodyProps) {
	const a = rec(p.input);
	const body = str(a.message) || str(a.content) || str(a.text) || str(a.body);
	const json = rec(asJson(p.output));
	return (
		<>
			{body && (
				<div className="ds-sent">
					<MessageResponse>{body}</MessageResponse>
				</div>
			)}
			{settled(p) ? (
				<StateNote {...p} />
			) : json.success === true ? (
				<p className="ds-tool-note">Delivered.</p>
			) : p.output.trim() && !Object.keys(json).length ? (
				<p className="ds-tool-note">{p.output.trim().split("\n")[0]}</p>
			) : null}
		</>
	);
}

export function ToolsBody(p: BodyProps) {
	const names = p.output
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (settled(p)) return <StateNote {...p} />;
	if (!names.length) return <p className="ds-tool-note">No tools matched.</p>;
	return (
		<ul className="ds-chips">
			{names.map((n) => (
				<li key={n} className="mono">
					{n}
				</li>
			))}
		</ul>
	);
}

/** A skill's result: only what the header doesn't already say. */
export function SkillBody(p: BodyProps) {
	if (settled(p)) return <StateNote {...p} />;
	const args = str(rec(p.input).args);
	const t = p.output.trim();
	return (
		<>
			{args && <p className="ds-tool-desc">With: {args}</p>}
			{t && !/^Launching skill:/i.test(t) ? (
				<ResultProse {...p} />
			) : (
				<p className="ds-tool-note">
					The skill's instructions went to the agent.
				</p>
			)}
		</>
	);
}

export function AdvisorBody(p: BodyProps) {
	if (settled(p)) return <StateNote {...p} />;
	return p.output.trim() ? (
		<ResultProse {...p} />
	) : (
		<p className="ds-tool-note">The advice went to the agent only.</p>
	);
}

// ------------------------------------------------------------------ generic

/** A JSON value as a lazy collapsible tree, under a header. */
export function JsonBlock({ value, title }: { value: unknown; title: string }) {
	return (
		<div className="ds-code tone-code ds-json-block">
			<div className="ds-code-head">
				<span className="ds-code-label">{title}</span>
			</div>
			<Suspense fallback={<Loading />}>
				<JsonView value={value} />
			</Suspense>
		</div>
	);
}

const isScalar = (v: unknown) =>
	v === null || ["string", "number", "boolean"].includes(typeof v);

/** Arguments: short scalars as a key–value list, anything else as a JSON tree. */
export function Args({ input }: { input: unknown }) {
	if (input === undefined) return null;
	if (typeof input === "string")
		return input.trim() ? (
			<CodeBlock code={input} title="Input" maxLines={12} />
		) : null;
	const a = rec(input);
	const entries = Object.entries(a);
	if (!entries.length) return null;
	const simple = entries.every(
		([, v]) =>
			isScalar(v) && String(v).length <= 160 && !String(v).includes("\n"),
	);
	if (!simple || Array.isArray(input))
		return <JsonBlock value={input} title="Arguments" />;
	return (
		<dl className="ds-args">
			{entries.map(([k, v]) => (
				<div key={k}>
					<dt>{k}</dt>
					<dd className={typeof v === "string" ? undefined : "mono"}>
						{String(v)}
					</dd>
				</div>
			))}
		</dl>
	);
}

/** The result of an unknown or MCP tool: a JSON tree, else text. */
export function Result(p: BodyProps & { truncated?: boolean }) {
	if (settled(p)) return <StateNote {...p} />;
	const t = p.output.trim();
	if (!t) return null;
	const json = asJson(t);
	if (json !== undefined) return <JsonBlock value={json} title="Result" />;
	const cutJson = !!p.truncated && /^[[{]/.test(t);
	return (
		<CodeBlock
			// JSON cut at 4 KB can't be parsed into a tree: highlighted text.
			className={`tool-out${cutJson ? " is-cut-json" : ""}`}
			code={p.output}
			lang={cutJson ? "json" : null}
			tone="terminal"
			title="Result"
			maxLines={14}
		/>
	);
}

export function GenericBody(p: BodyProps & { truncated?: boolean }) {
	return (
		<>
			<Args input={p.input} />
			<Result {...p} />
		</>
	);
}

const BODY: Partial<Record<ToolKind, (p: BodyProps) => ReactNode>> = {
	shell: CommandBody,
	code: CodeBody,
	read: ReadBody,
	edit: EditBody,
	patch: PatchBody,
	write: WriteBody,
	notebook: NotebookBody,
	search: SearchBody,
	list: ListBody,
	websearch: WebSearchBody,
	fetch: FetchBody,
	todo: TodoBody,
	plan: PlanBody,
	question: QuestionBody,
	task: TaskBody,
	message: MessageBody,
	tools: ToolsBody,
	skill: SkillBody,
	// Viewed images render below the card; only a text reply goes here.
	image: ResultProse,
	advisor: AdvisorBody,
};

/**
 * The expanded view for a call of `kind` (lazy: loads when a card first
 * opens). A result without its call (an older page holds the call) shows
 * only the result; unknown tools show their arguments and result.
 */
export default function ToolBody({
	kind,
	hasCall,
	truncated,
	...p
}: BodyProps & { kind: ToolKind; hasCall: boolean; truncated?: boolean }) {
	if (!hasCall) return <Result {...p} truncated={truncated} />;
	const Body = BODY[kind];
	return Body ? <Body {...p} /> : <GenericBody {...p} truncated={truncated} />;
}
