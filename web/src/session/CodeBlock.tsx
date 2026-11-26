import { CheckIcon, ChevronDownIcon, CopyIcon, FolderIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { plural } from "../lib/format.ts";
import { useFormatted } from "./format.ts";
import { LineTokens, langLabel, useTokens } from "./highlight.tsx";
import { hasAnsi, stripAnsi } from "./tools/ansi.ts";

/** ANSI colors load only for output that has escape codes. */
const AnsiText = lazy(() => import("./tools/Ansi.tsx"));

/** Output rows as text, colored when they carry ANSI codes. */
function OutputRows({ rows }: { rows: string[] }) {
	const text = rows.join("\n");
	if (!hasAnsi(text))
		return (
			<>
				{rows.map((r, i) => (
					<span key={i} className="ds-code-line">
						{r}
						{"\n"}
					</span>
				))}
			</>
		);
	return (
		<Suspense fallback={stripAnsi(text)}>
			<AnsiText text={text} />
		</Suspense>
	);
}

export type CodeTone = "code" | "terminal" | "error";

/** "Show all N lines" / "Show less" under folded content. */
function FoldButton({
	open,
	onToggle,
	lines,
}: {
	open: boolean;
	onToggle: () => void;
	lines: number;
}) {
	return (
		<button
			type="button"
			className="ds-code-more"
			aria-expanded={open}
			onClick={onToggle}
		>
			<ChevronDownIcon aria-hidden="true" className={open ? "flip" : ""} />
			{open ? "Show less" : `Show all ${plural(lines, "line")}`}
		</button>
	);
}

/** "Original" / "Formatted": which text a formatted block shows. */
function FormatToggle({
	original,
	onToggle,
}: {
	original: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			className="ds-code-fmt"
			aria-pressed={original}
			title={
				original ? "Show formatted" : "Show the code as the agent wrote it"
			}
			onClick={(e) => {
				e.stopPropagation();
				onToggle();
			}}
		>
			{original ? "Formatted" : "Original"}
		</button>
	);
}

/** Copy to the clipboard with a check for 1.5 s. */
export function CopyButton({
	text,
	label = "Copy",
	className,
}: {
	text: string;
	label?: string;
	className?: string;
}) {
	const [done, setDone] = useState(false);
	return (
		<button
			type="button"
			className={`ds-icon-btn ds-copy${done ? " is-done" : ""}${className ? ` ${className}` : ""}`}
			aria-label={done ? "Copied" : label}
			title={done ? "Copied" : label}
			onClick={(e) => {
				e.stopPropagation();
				void navigator.clipboard?.writeText(text).catch(() => {});
				setDone(true);
				setTimeout(() => setDone(false), 1500);
			}}
		>
			{done ? (
				<CheckIcon aria-hidden="true" />
			) : (
				<CopyIcon aria-hidden="true" />
			)}
		</button>
	);
}

/**
 * A code block: Shiki tokens in the app's palette, a header with the
 * language (or file name) and Copy, soft wrapping at 80 columns, and
 * long content folded behind "Show all N lines".
 *
 * `tone="terminal"` is the calm dark-on-light output style for command
 * output; `tone="error"` tints it red. Both skip highlighting.
 */
export function CodeBlock({
	code,
	lang,
	title,
	tone = "code",
	maxLines,
	lineNumbers,
	startLine = 1,
	header = true,
	format = false,
	className,
}: {
	code: string;
	/**
	 * Format the code for display (TypeScript, JavaScript, JSON; see
	 * format.ts), with "Original" to see it as written. Copy copies it as
	 * written.
	 */
	format?: boolean;
	/** Shiki language id or alias; null or unknown renders plain. */
	lang?: string | null;
	/** Shown in the header instead of the language: a file name, "Output". */
	title?: string;
	tone?: CodeTone;
	/** Fold after this many lines (with a "Show all" control). */
	maxLines?: number;
	lineNumbers?: boolean;
	startLine?: number;
	header?: boolean;
	className?: string;
}) {
	const written = code.replace(/\n$/, "");
	const fmt = useFormatted(
		written,
		lang,
		format && tone === "code" && !lineNumbers,
	);
	const raw = fmt.shown;
	const ansi = tone !== "code" && hasAnsi(raw);
	const text = ansi ? stripAnsi(raw) : raw;
	const rows = raw.split("\n");
	const [open, setOpen] = useState(false);
	const folded = !!maxLines && rows.length > maxLines + 2 && !open;
	const shown = folded ? rows.slice(0, maxLines) : rows;
	const tokens = useTokens(text, tone === "code" ? (lang ?? null) : null);
	return (
		<div
			className={`ds-code tone-${tone}${fmt.formatted ? " is-formatted" : ""}${className ? ` ${className}` : ""}`}
			data-lang={lang ?? undefined}
		>
			{header && (
				<div className="ds-code-head">
					<span className="ds-code-label">
						{title ?? (tone === "code" ? langLabel(lang) : "Output")}
					</span>
					{fmt.canFormat && (
						<FormatToggle
							original={fmt.original}
							onToggle={() => fmt.setOriginal(!fmt.original)}
						/>
					)}
					<CopyButton
						text={ansi ? stripAnsi(written) : written}
						label={`Copy ${title ?? "code"}`}
					/>
				</div>
			)}
			<pre
				className={`ds-code-pre${lineNumbers ? " has-nums" : ""}`}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-reachable
				tabIndex={0}
			>
				<code>
					{ansi && !lineNumbers ? (
						<OutputRows rows={shown} />
					) : (
						shown.map((r, i) => (
							<span key={i} className="ds-code-line">
								{lineNumbers && (
									<span className="ds-ln" aria-hidden="true">
										{startLine + i}
									</span>
								)}
								<span className="ds-lc">
									<LineTokens
										tokens={tokens?.[i]}
										text={ansi ? stripAnsi(r) : r}
									/>
								</span>
								{"\n"}
							</span>
						))
					)}
				</code>
			</pre>
			{maxLines && rows.length > maxLines + 2 && (
				<FoldButton
					open={open}
					onToggle={() => setOpen(!open)}
					lines={rows.length}
				/>
			)}
		</div>
	);
}

/**
 * A command and its output as one terminal: the command highlighted as
 * Bash after a `$` prompt, then the output, folded after `maxLines`. Dark
 * in both color schemes (the syntax tokens switch to their dark values
 * inside it). `failed` tints the output and marks the header.
 */
export function TerminalBlock({
	command,
	output,
	title,
	failed,
	status,
	folder,
	formatCommand = false,
	maxLines = 14,
	className,
}: {
	command: string;
	/**
	 * Break a long one-line `a && b; c` chain onto lines for display, with
	 * "Original" to see it as written. Copy copies it as written.
	 */
	formatCommand?: boolean;
	/** Where it ran: a short label, the absolute path as its tooltip. */
	folder?: { text: string; title: string } | null;
	output?: string;
	/** Header label: the agent's description of the command, or "Shell". */
	title?: string;
	failed?: boolean;
	/** Header status words ("Exit 1", "41 passed"). */
	status?: string;
	maxLines?: number;
	className?: string;
}) {
	const out = (output ?? "").replace(/\n$/, "");
	const rows = out ? out.split("\n") : [];
	const [open, setOpen] = useState(false);
	const fold = rows.length > maxLines + 2 && !open;
	const fmt = useFormatted(command, "bash", formatCommand);
	const shownCmd = fmt.shown;
	const tokens = useTokens(shownCmd, "bash");
	const cmdRows = shownCmd.split("\n");
	return (
		<div
			className={`ds-term${failed ? " is-failed" : ""}${className ? ` ${className}` : ""}`}
		>
			<div className="ds-code-head ds-term-head">
				<span className="ds-code-label">{title || "Shell"}</span>
				{folder && (
					<span className="ds-term-dir" title={folder.title}>
						<FolderIcon aria-hidden="true" />
						<span className="sr-only">in </span>
						{folder.text}
					</span>
				)}
				{status && (
					<span className={`ds-term-status${failed ? " is-failed" : ""}`}>
						{status}
					</span>
				)}
				{fmt.canFormat && (
					<FormatToggle
						original={fmt.original}
						onToggle={() => fmt.setOriginal(!fmt.original)}
					/>
				)}
				<CopyButton text={command} label="Copy command" />
			</div>
			<pre
				className="ds-code-pre ds-term-pre"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-reachable
				tabIndex={0}
			>
				<code>
					{cmdRows.map((r, i) => (
						<span key={`c${i}`} className="ds-code-line ds-term-cmd">
							<span className="ds-term-prompt" aria-hidden="true">
								{i === 0 ? "$" : " "}
							</span>
							<LineTokens tokens={tokens?.[i]} text={r} />
							{"\n"}
						</span>
					))}
					{rows.length > 0 && (
						<span className="ds-term-out tool-output">
							<OutputRows rows={fold ? rows.slice(0, maxLines) : rows} />
						</span>
					)}
				</code>
			</pre>
			{rows.length > maxLines + 2 && (
				<FoldButton
					open={open}
					onToggle={() => setOpen(!open)}
					lines={rows.length}
				/>
			)}
		</div>
	);
}
