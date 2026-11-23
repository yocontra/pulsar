import {
	BotIcon,
	BrainCircuitIcon,
	ChevronRightIcon,
	CircleHelpIcon,
	CircleSlashIcon,
	ClockIcon,
	CodeIcon,
	FilePenLineIcon,
	FilePlusIcon,
	FileTextIcon,
	FolderTreeIcon,
	GlobeIcon,
	ImageIcon,
	ListChecksIcon,
	MapIcon,
	NotebookPenIcon,
	PlugIcon,
	SearchIcon,
	SendIcon,
	SparklesIcon,
	SquareTerminalIcon,
	WrenchIcon,
	XIcon,
} from "lucide-react";
import { Collapsible } from "radix-ui";
import { lazy, type ReactNode, Suspense, useMemo } from "react";
import {
	describeCall,
	editStats,
	patchFiles,
	resultFacts,
	type ToolKind,
	type ToolLine,
	toolKind,
	toolLabel,
} from "../../../src/transcripts/describe.ts";
import type { TranscriptEvent } from "../api/types.ts";
import { harnessUi } from "../harnesses/index.ts";
import { sentence } from "../lib/format.ts";
import { InlineCode } from "./highlight.tsx";
import type { Item } from "./items.ts";
import { SubagentDot } from "./subagent-colors.tsx";
import { stripAnsi } from "./tools/ansi.ts";
import type { BodyProps } from "./tools/bodies.tsx";
import { pulsarCard } from "./tools/PulsarHead.tsx";

export { type ToolKind, toolKind, toolLabel };

const ICON: Record<ToolKind, ReactNode> = {
	shell: <SquareTerminalIcon />,
	code: <CodeIcon />,
	read: <FileTextIcon />,
	image: <ImageIcon />,
	edit: <FilePenLineIcon />,
	patch: <FilePenLineIcon />,
	write: <FilePlusIcon />,
	notebook: <NotebookPenIcon />,
	search: <SearchIcon />,
	list: <FolderTreeIcon />,
	websearch: <GlobeIcon />,
	fetch: <GlobeIcon />,
	todo: <ListChecksIcon />,
	plan: <MapIcon />,
	question: <CircleHelpIcon />,
	task: <BotIcon />,
	message: <SendIcon />,
	wait: <ClockIcon />,
	skill: <SparklesIcon />,
	tools: <WrenchIcon />,
	mcp: <PlugIcon />,
	advisor: <BrainCircuitIcon />,
	other: <WrenchIcon />,
};

/** Card bodies load when a card first opens (or is hovered or focused). */
const loadBody = () => import("./tools/bodies.tsx");
const ToolBody = lazy(loadBody);

/** A path with its folder quiet and its file name prominent. */
export function PathText({ path }: { path: string }) {
	const i = path.lastIndexOf("/");
	return (
		<span className="ds-path" title={path}>
			{i >= 0 && <span className="ds-path-dir">{path.slice(0, i + 1)}</span>}
			<span className="ds-path-base">{path.slice(i + 1)}</span>
		</span>
	);
}

/** A URL as its host (prominent) and path (quiet). */
function UrlText({ url }: { url: string }) {
	try {
		const u = new URL(url);
		return (
			<span className="ds-path" title={url}>
				<span className="ds-path-base">{u.hostname.replace(/^www\./, "")}</span>
				<span className="ds-path-dir">
					{u.pathname === "/" ? "" : u.pathname}
					{u.search}
				</span>
			</span>
		);
	} catch {
		return <span>{url}</span>;
	}
}

function Target({ line }: { line: ToolLine }) {
	const t = line.target;
	if (!t) return null;
	const first = t.text.split("\n")[0]!;
	switch (t.as) {
		case "cmd":
			return (
				<InlineCode
					code={first + (t.text.includes("\n") ? " …" : "")}
					lang="bash"
					className="ds-tool-cmd"
				/>
			);
		case "path":
			return (
				<span className="ds-tool-target mono">
					<PathText path={first} />
				</span>
			);
		case "url":
			return (
				<span className="ds-tool-target mono">
					<UrlText url={first} />
				</span>
			);
		case "query":
			return (
				<span className="ds-tool-target">
					<code className="ds-tool-q">{first}</code>
				</span>
			);
		case "name":
			return <span className="ds-tool-target mono">{first}</span>;
		default:
			return <span className="ds-tool-target">{first}</span>;
	}
}

/** "+12 −3" with color; the text stays "+12 -3"-shaped for screen readers. */
export function DiffStat({
	added,
	removed,
}: {
	added: number;
	removed: number;
}) {
	return (
		<span className="ds-diffstat" title={`${added} added, ${removed} removed`}>
			<span className="add">+{added}</span>
			{removed > 0 && (
				<>
					{" "}
					<span className="del">−{removed}</span>
				</>
			)}
		</span>
	);
}

/** A status fact read on its own ("denied", "timed out after 2 min"): shown as a label. */
const STATUS_FACT =
	/^(denied|interrupted|timed out|failed|stopped|in background|running)\b/;

/** Short facts as quiet parts; a failure in red. */
function Facts({ parts, error }: { parts: string[]; error?: boolean }) {
	return (
		<span className={`ds-tool-sum${error ? " is-error" : ""}`}>
			{parts.map((p, i) => (
				<span key={i}>
					{(STATUS_FACT.test(p) ? sentence(p) : p).replace(
						/(\d)(ms|s)\b/,
						"$1 $2",
					)}
				</span>
			))}
		</span>
	);
}

/** Verbs a daemon summary starts with when it repeats the call ("Ran `x` · exit 0"). */
const CALL_VERB =
	/^(Ran|Running|Read|Edited|Wrote|Searched|Fetched|Subagent|Patched|Called|Updated|Asked|Proposed|Loaded|Messaged|Waited|Listed|Found|Viewed|Checked|Stopped|Watched|Created|Deleted|Added|Started|Sent)\b/;

/**
 * Result facts from a summary written without `detail` (older daemons, the
 * mock): the parts after a repeated call line, minus "exit 0".
 */
function summaryFacts(summary: string, name: string): string[] {
	const parts = summary.split(" · ").filter(Boolean);
	if (parts.length && (CALL_VERB.test(parts[0]!) || parts[0] === name))
		parts.shift();
	return parts.filter((p) => p !== "exit 0" && p !== "error");
}

/** The images-free text of an event. */
function textOf(ev: TranscriptEvent | undefined): string {
	if (!ev) return "";
	return ev.images?.length || ev.documents?.length
		? ev.text.replace(/\[(image|document)\]/g, "").trim()
		: ev.text;
}

type State = "running" | "done" | "error" | "denied" | "stopped";

/** What screen readers hear after the verb for each unfinished state. */
const STATE_SR: Record<Exclude<State, "done">, string> = {
	running: ", running",
	denied: ", denied",
	stopped: ", interrupted",
	error: ", failed",
};

function cardState(
	detail: BodyProps["detail"],
	isError: boolean,
	done: boolean,
): State {
	if (detail?.denied) return "denied";
	if (detail?.interrupted) return "stopped";
	if (isError) return "error";
	return done ? "done" : "running";
}

/**
 * A tool call as a compact card: icon + verb + target + key result on one
 * line ("Searched the web for "X" · 8 results"), expanding to the view that
 * fits the tool (see tools/bodies.tsx). Edits show a diff (`layout`:
 * "split" on desktop, "unified" on phone).
 *
 * `renderImages` lets the caller draw tool screenshots (they need the API).
 */
export function ToolCard({
	item,
	layout = "unified",
	renderImages,
	defaultOpen,
	harness,
	agentCwd,
}: {
	item: Extract<Item, { t: "tool" }>;
	/** The agent's folder: commands show where they ran relative to it. */
	agentCwd?: string | null;
	/** The agent's harness: its UI adapter may render this tool its own way. */
	harness?: string | null;
	layout?: "split" | "unified";
	renderImages?: (ev: TranscriptEvent) => ReactNode;
	defaultOpen?: boolean;
}) {
	const call = item.call;
	const res = item.result;
	const name = call?.tool?.name ?? res?.tool?.name ?? "tool";
	const input = call?.tool?.input;
	const detail = res?.tool?.detail ?? call?.tool?.detail;
	const isError = !!(res?.tool?.isError ?? call?.tool?.isError);
	// A live call can arrive again with its result folded in (`done`).
	const done = !!res || !!call?.tool?.done || call?.tool?.isError !== undefined;
	const line = useMemo(
		() =>
			call
				? describeCall(name, input, {
						// A refused or stopped call didn't run, and a failed edit changed
						// nothing; a command that exited non-zero still ran.
						done:
							done &&
							!(
								isError && /^(edit|patch|write|notebook)$/.test(toolKind(name))
							) &&
							!detail?.denied &&
							!detail?.interrupted,
					})
				: ({
						kind: toolKind(name),
						verb: name === "tool" ? "Tool result" : toolLabel(name),
						facts: [],
					} as ToolLine),
		[call, name, input, done, isError, detail?.denied, detail?.interrupted],
	);
	// A harness's own card, else a card shared by every harness (Pulsar's tools).
	const custom = harnessUi(harness).toolCards?.[name] ?? pulsarCard(name);
	const kind = custom?.kind ?? line.kind;
	const out = textOf(res);
	const summary = res?.tool?.summary ?? call?.tool?.summary ?? "";
	const state = cardState(detail, isError, done);

	const stat = useMemo(() => {
		if (!call || (kind !== "edit" && kind !== "patch" && kind !== "write"))
			return null;
		if (kind === "patch") {
			const a =
				input && typeof input === "object"
					? (input as Record<string, unknown>)
					: {};
			const files = patchFiles(
				typeof input === "string" ? input : String(a.input ?? a.patch ?? ""),
			);
			return {
				added: files.reduce((n, f) => n + f.added, 0),
				removed: files.reduce((n, f) => n + f.removed, 0),
			};
		}
		if (kind === "write") {
			const c = (input as Record<string, unknown> | undefined)?.content;
			const n =
				typeof c === "string" && c
					? c.replace(/\n$/, "").split("\n").length
					: 0;
			return { added: n, removed: 0 };
		}
		return editStats(input);
	}, [call, kind, input]);

	// Key result: worst news first, else what the tool found.
	const facts = detail
		? resultFacts(kind, detail, isError)
		: done && res
			? summaryFacts(summary, name)
			: [];
	const callFacts = line.facts.filter(
		(f) => !/^[+]\d+ −\d+$/.test(f) && !/^\d+ lines?$/.test(f),
	);
	// Result facts the call line already shows; a Read range already says which lines.
	const resultOnly = facts.filter(
		(f) =>
			!callFacts.includes(f) &&
			!(
				callFacts.some((c) => c.startsWith("lines ")) && /^\d+ lines?$/.test(f)
			),
	);
	const meta =
		state === "denied" || state === "stopped" || state === "error"
			? facts.length
				? facts
				: [state === "error" ? "failed" : state]
			: [...callFacts, ...resultOnly];
	const props: BodyProps = {
		name,
		input,
		output: kind === "shell" || kind === "code" ? out : stripAnsi(out),
		detail,
		isError,
		layout,
		done,
		agentCwd,
		...(call?.tool?.cwd ? { callCwd: call.tool.cwd } : {}),
	};

	return (
		<Collapsible.Root
			className={`ev tool ds-tool k-${kind} is-${state}${isError ? " is-error" : ""}${custom?.className ? ` ${custom.className}` : ""}`}
			data-tool={name}
			defaultOpen={defaultOpen}
		>
			<Collapsible.Trigger
				className="ds-tool-head"
				onPointerEnter={loadBody}
				onFocus={loadBody}
			>
				<span className="ds-tool-icon" aria-hidden="true">
					{state === "denied" || state === "stopped" ? (
						<CircleSlashIcon />
					) : (
						(custom?.icon ?? ICON[kind])
					)}
				</span>
				{custom?.Head && call ? (
					<custom.Head
						name={name}
						input={input}
						output={props.output}
						isError={isError}
						done={done}
						{...(res && call.ts && res.ts >= call.ts
							? { ms: res.ts - call.ts }
							: {})}
						{...(state === "denied" || state === "stopped"
							? { stateFacts: meta.map((f) => sentence(f)) }
							: {})}
					/>
				) : (
					<>
						<span className="ds-tool-verb">{line.verb}</span>
						<span className="ds-tool-main">
							{kind === "message" && line.target?.as === "name" && (
								// A message to a subagent: its color (only a known one).
								<SubagentDot name={line.target.text} knownOnly />
							)}
							<Target line={line} />
						</span>
						<span className="ds-tool-meta tool-summary">
							{stat && (stat.added || stat.removed) && state === "done" ? (
								<DiffStat added={stat.added} removed={stat.removed} />
							) : meta.length ? (
								<Facts parts={meta} error={state === "error"} />
							) : null}
						</span>
					</>
				)}
				<span className="ds-tool-state" aria-hidden="true">
					{state === "running" ? (
						<span className="ds-spin" />
					) : state === "error" && !meta.length ? (
						<XIcon />
					) : null}
				</span>
				{state !== "done" && <span className="sr-only">{STATE_SR[state]}</span>}
				<ChevronRightIcon className="ds-tool-chev" aria-hidden="true" />
			</Collapsible.Trigger>
			<Collapsible.Content className="ds-tool-body">
				<Suspense fallback={<div className="ds-tool-note">Loading…</div>}>
					{custom?.Body && call ? (
						<custom.Body {...props} />
					) : (
						<ToolBody
							{...props}
							kind={kind}
							hasCall={!!call}
							truncated={res?.tool?.truncated}
						/>
					)}
				</Suspense>
				{res?.tool?.truncated && (
					<p className="ds-tool-note">
						Output was cut to the first 4 KB by the agent's machine.
					</p>
				)}
			</Collapsible.Content>
			{(res?.images?.length || res?.documents?.length) && renderImages ? (
				<div className="tool-images ds-tool-images">{renderImages(res)}</div>
			) : null}
		</Collapsible.Root>
	);
}
