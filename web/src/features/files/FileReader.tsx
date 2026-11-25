import {
	ChevronDownIcon,
	ChevronUpIcon,
	HashIcon,
	SearchIcon,
	XIcon,
} from "lucide-react";
import {
	type KeyboardEvent,
	memo,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { CodeBlock } from "../../session/CodeBlock.tsx";
import { langForPath } from "../../session/highlight.tsx";

const HIGHLIGHT_MAX = 256 * 1024;
const FileCode = memo(CodeBlock);

type Tool = "find" | "line";

export function FileReader({
	path,
	text,
	size,
	line,
}: {
	path: string;
	text: string;
	size: number;
	line?: number;
}) {
	const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
	const clamp = (n: number) => Math.min(lines.length, Math.max(1, n));
	const [activeLine, setActiveLine] = useState(line ?? 1);
	const selected = clamp(activeLine);
	const [tool, setTool] = useState<Tool | null>(null);
	const [query, setQuery] = useState("");
	const [lineInput, setLineInput] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const code = useRef<HTMLDivElement>(null);
	const helpId = useId();
	const title = path.split("/").at(-1) ?? path;

	const matches = useMemo(() => {
		if (!query) return [];
		const needle = query.toLowerCase();
		return lines.flatMap((row, i) =>
			row.toLowerCase().includes(needle) ? [i + 1] : [],
		);
	}, [lines, query]);
	const hit = matches.indexOf(selected);
	const matchLabel = !query
		? ""
		: !matches.length
			? "No match"
			: hit < 0
				? `${matches.length} matching lines`
				: `${hit + 1} of ${matches.length} matching lines`;

	useEffect(() => {
		setActiveLine(line ?? 1);
	}, [line]);
	useEffect(() => {
		const row = code.current?.querySelector("code")?.children[selected - 1];
		if (!row) return;
		row.classList.add("fv-hl");
		if (
			selected !== 1 ||
			line ||
			code.current?.contains(document.activeElement)
		)
			row.scrollIntoView({ block: "nearest", inline: "nearest" });
		return () => row.classList.remove("fv-hl");
	}, [line, selected, text]);
	useEffect(() => {
		if (tool) {
			input.current?.focus();
			if (tool === "find") input.current?.select();
		}
	}, [tool]);

	function openTool(next: Tool) {
		if (next === "line") setLineInput(String(selected));
		if (tool === next) {
			input.current?.focus();
			if (tool === "find") input.current?.select();
		} else setTool(next);
	}

	function closeTool() {
		setTool(null);
		code.current?.querySelector("pre")?.focus({ preventScroll: true });
	}

	function nextMatch(direction: 1 | -1) {
		if (!matches.length) return;
		const next =
			direction === 1
				? (matches.find((n) => n > selected) ?? matches[0])
				: (matches.findLast((n) => n < selected) ?? matches.at(-1));
		if (next !== undefined) setActiveLine(next);
	}

	function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
		if (e.defaultPrevented || e.altKey || e.nativeEvent.isComposing) return;
		if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
			const k = e.key.toLowerCase();
			if (k !== "f" && k !== "g") return;
			e.preventDefault();
			openTool(k === "f" ? "find" : "line");
			return;
		}
		if (e.target === input.current && e.key === "Escape") {
			e.preventDefault();
			closeTool();
			return;
		}
		if (
			e.target !== code.current?.querySelector("pre") ||
			e.shiftKey ||
			e.ctrlKey ||
			e.metaKey
		)
			return;
		const next =
			e.key === "ArrowDown"
				? selected + 1
				: e.key === "ArrowUp"
					? selected - 1
					: e.key === "Home"
						? 1
						: e.key === "End"
							? lines.length
							: null;
		if (next === null) return;
		e.preventDefault();
		setActiveLine(clamp(next));
	}

	return (
		<div className="fv-reader" onKeyDown={onKeyDown}>
			<div className="fv-reader-tools">
				<div
					className="fv-reader-top"
					role="group"
					aria-label="File navigation"
				>
					<button
						type="button"
						className="fv-btn"
						aria-expanded={tool === "find"}
						aria-keyshortcuts="Control+F Meta+F"
						onClick={() => openTool("find")}
					>
						<SearchIcon aria-hidden="true" /> Find
					</button>
					<button
						type="button"
						className="fv-btn"
						aria-expanded={tool === "line"}
						aria-keyshortcuts="Control+G Meta+G"
						onClick={() => openTool("line")}
					>
						<HashIcon aria-hidden="true" /> Go to line
					</button>
					<span className="fv-line-position" role="status">
						Line {selected} of {lines.length}
					</span>
				</div>
				{tool && (
					<form
						className="fv-reader-form"
						onSubmit={(e) => {
							e.preventDefault();
							if (tool === "find") nextMatch(1);
							else {
								const n = Number(lineInput);
								if (Number.isSafeInteger(n) && n >= 1 && n <= lines.length) {
									setActiveLine(n);
									closeTool();
								}
							}
						}}
					>
						{tool === "find" ? (
							<>
								<input
									ref={input}
									type="search"
									aria-label="Find in file"
									placeholder="Find in file"
									value={query}
									onChange={(e) => {
										const next = e.target.value;
										setQuery(next);
										if (next) {
											const needle = next.toLowerCase();
											const i = lines.findIndex((row) =>
												row.toLowerCase().includes(needle),
											);
											if (i >= 0) setActiveLine(i + 1);
										}
									}}
									onKeyDown={(e) => {
										if (e.key !== "Enter" || !e.shiftKey) return;
										e.preventDefault();
										nextMatch(-1);
									}}
								/>
								<button
									type="button"
									className="fv-btn"
									disabled={!matches.length}
									aria-label="Previous match"
									onClick={() => nextMatch(-1)}
								>
									<ChevronUpIcon aria-hidden="true" />
								</button>
								<button
									type="submit"
									className="fv-btn"
									disabled={!matches.length}
									aria-label="Next match"
								>
									<ChevronDownIcon aria-hidden="true" />
								</button>
								<span className="fv-match-count" role="status">
									{matchLabel}
								</span>
							</>
						) : (
							<>
								<input
									ref={input}
									type="number"
									aria-label="Line number"
									inputMode="numeric"
									min={1}
									max={lines.length}
									required
									value={lineInput}
									onChange={(e) => setLineInput(e.target.value)}
								/>
								<button type="submit" className="fv-btn">
									Go
								</button>
							</>
						)}
						<button
							type="button"
							className="fv-btn"
							aria-label="Close file navigation"
							onClick={closeTool}
						>
							<XIcon aria-hidden="true" />
						</button>
					</form>
				)}
			</div>
			<p id={helpId} className="fv-sr">
				Read-only. Use Up and Down to move by line, Home and End to move to the
				first or last line, and Control or Command with F or G to find text or
				go to a line.
			</p>
			<div
				ref={code}
				role="region"
				aria-label={`File contents: ${title}`}
				aria-describedby={helpId}
			>
				<FileCode
					code={text}
					lang={size > HIGHLIGHT_MAX ? null : langForPath(path)}
					title={title}
					lineNumbers
				/>
			</div>
		</div>
	);
}
