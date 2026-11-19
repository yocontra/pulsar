/**
 * What a permission prompt asks, per tool: Bash as its description then the
 * highlighted command, Edit/Write as a diff, Read as a path, WebFetch as a
 * URL and prompt, MCP tools as JSON. Every view runs under MarkHidden, so
 * control, zero-width and bidi characters stay visible as red tags inside
 * the highlighting. Every input key is shown: the keys a view does not
 * render go to the "Other arguments" list, exactly.
 */
import { lazy, type ReactNode, Suspense } from "react";
import { InlineCode, langForPath, MarkHidden } from "../session/highlight.tsx";
import { Exact, Marked } from "./exact.tsx";
import { visible } from "./visible.ts";

const Diff = lazy(() =>
	import("../session/Diff.tsx").then((m) => ({ default: m.Diff })),
);

type Input = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);

interface View {
	/** The lead line (Bash's description). */
	lead?: string | null;
	body: ReactNode;
	/** Keys the view shows; the rest are listed exactly. */
	used: string[];
}

function Code({ code, lang }: { code: string; lang: string }) {
	return (
		<pre className="ds-ap-code">
			<InlineCode code={code} lang={lang} />
		</pre>
	);
}

function PathLine({ label, value }: { label: string; value: string }) {
	return (
		<p className="ds-ap-line">
			<span className="ds-ap-line-k">{label}</span>
			<code className="ds-ap-line-v">
				<Marked text={value} />
			</code>
		</p>
	);
}

function DiffView({
	path,
	before,
	after,
}: {
	path: string;
	before: string;
	after: string;
}) {
	return (
		<Suspense fallback={<Code code={after} lang="text" />}>
			<Diff
				before={before}
				after={after}
				lang={langForPath(path)}
				className="ds-ap-diff"
			/>
		</Suspense>
	);
}

function viewFor(tool: string, input: Input): View | null {
	const path = str(input.file_path) ?? str(input.notebook_path);
	switch (tool) {
		case "Bash": {
			const command = str(input.command);
			if (command === null) return null;
			return {
				lead: str(input.description),
				body: <Code code={command} lang="bash" />,
				used: ["command", "description"],
			};
		}
		case "Edit": {
			const before = str(input.old_string);
			const after = str(input.new_string);
			if (!path || before === null || after === null) return null;
			return {
				body: (
					<>
						<PathLine label="File" value={path} />
						<DiffView path={path} before={before} after={after} />
					</>
				),
				used: ["file_path", "old_string", "new_string"],
			};
		}
		case "Write": {
			const content = str(input.content);
			if (!path || content === null) return null;
			return {
				body: (
					<>
						<PathLine label="New file" value={path} />
						<DiffView path={path} before="" after={content} />
					</>
				),
				used: ["file_path", "content"],
			};
		}
		case "MultiEdit": {
			const edits = Array.isArray(input.edits)
				? (input.edits as { old_string?: unknown; new_string?: unknown }[])
				: null;
			if (
				!path ||
				!edits?.every(
					(e) =>
						typeof e?.old_string === "string" &&
						typeof e?.new_string === "string" &&
						Object.keys(e).every((k) =>
							["old_string", "new_string"].includes(k),
						),
				)
			)
				return null;
			return {
				body: (
					<>
						<PathLine label="File" value={path} />
						{edits.map((e, i) => (
							<DiffView
								key={i}
								path={path}
								before={e.old_string as string}
								after={e.new_string as string}
							/>
						))}
					</>
				),
				used: ["file_path", "edits"],
			};
		}
		case "Read":
		case "NotebookRead": {
			if (!path) return null;
			return {
				body: <PathLine label="File" value={path} />,
				used: ["file_path", "notebook_path"],
			};
		}
		case "WebFetch": {
			const url = str(input.url);
			if (!url) return null;
			const prompt = str(input.prompt);
			return {
				body: (
					<>
						<PathLine label="URL" value={url} />
						{prompt !== null && (
							<p className="ds-ap-prose">
								<Marked text={prompt} />
							</p>
						)}
					</>
				),
				used: ["url", "prompt"],
			};
		}
		case "WebSearch": {
			const q = str(input.query);
			if (!q) return null;
			return {
				body: <PathLine label="Search" value={q} />,
				used: ["query"],
			};
		}
		case "Grep":
		case "Glob": {
			const pattern = str(input.pattern);
			if (pattern === null) return null;
			const where = str(input.path);
			return {
				body: (
					<>
						<PathLine label="Pattern" value={pattern} />
						{where && <PathLine label="In" value={where} />}
					</>
				),
				used: ["pattern", "path"],
			};
		}
	}
	if (tool.startsWith("mcp__") && Object.keys(input).length)
		return {
			body: <Code code={JSON.stringify(input, null, 2)} lang="json" />,
			used: Object.keys(input),
		};
	return null;
}

/** The tool's input: its own view when it has one, then any other keys exactly. */
export function ToolInput({ tool, input }: { tool: string; input: Input }) {
	const view = viewFor(tool, input);
	const rest = Object.entries(input).filter(([k]) => !view?.used.includes(k));
	return (
		<MarkHidden.Provider value>
			{view?.lead && (
				<p className="ds-ap-lead">
					<Marked text={view.lead} />
				</p>
			)}
			{view?.body}
			{rest.length > 0 && (
				<dl className="args ds-ap-args">
					{rest.map(([k, v]) => (
						<div key={k} className="ds-ap-arg">
							<dt>
								<Marked text={k} />
							</dt>
							<dd>
								<Exact value={v} />
							</dd>
						</div>
					))}
				</dl>
			)}
		</MarkHidden.Provider>
	);
}

/** True when any key or string in the input has a hidden character or a tab (the legend then explains the tags). */
export function hasHidden(v: unknown): boolean {
	if (typeof v === "string")
		return visible(v).some((p) => p.mark === "ctl" || p.mark === "tab");
	if (Array.isArray(v)) return v.some(hasHidden);
	if (v && typeof v === "object")
		return Object.entries(v).some(([k, x]) => hasHidden(k) || hasHidden(x));
	return false;
}
