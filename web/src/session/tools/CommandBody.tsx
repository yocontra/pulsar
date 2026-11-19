import { ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
	type CommandRun,
	commandRun,
	isShell,
	scriptResult,
} from "../../../../src/transcripts/command.ts";
import { duration } from "../../lib/format.ts";
import { CodeBlock } from "../CodeBlock.tsx";
import {
	type BodyProps,
	CodeBody,
	ShellBody,
	StateNote,
	shellOutput,
	shellStatus,
} from "./bodies.tsx";
import { CommandBlock } from "./CommandBlock.tsx";

/**
 * Every harness's shell call as commands: what ran (Bash, highlighted),
 * where (the call's workdir, else the folder the log recorded, else the
 * agent's), why (the agent's description), and what came back. A Codex
 * script shows each `tools.exec_command` it makes, then the script itself
 * under "Show script". Calls with no command fall back to the plain views.
 */
export function CommandBody(p: BodyProps) {
	const run = useMemo(() => commandRun(p.name, p.input), [p.name, p.input]);
	if (!run)
		return typeof p.input === "string" ? (
			<CodeBody {...p} />
		) : (
			<ShellBody {...p} />
		);
	return run.script ? (
		<ScriptRun run={run} p={p} />
	) : (
		<SingleRun run={run} p={p} />
	);
}

const settled = (p: BodyProps) => !!p.detail?.denied || !!p.detail?.interrupted;

function SingleRun({ run, p }: { run: CommandRun; p: BodyProps }) {
	const step = run.steps[0];
	if (!step || !isShell(step)) return null;
	const status =
		shellStatus(p) ?? (run.background && p.done ? "In background" : undefined);
	return (
		<>
			<CommandBlock
				command={step.cmd}
				cwd={step.cwd ?? p.callCwd ?? p.agentCwd}
				project={p.agentCwd}
				description={run.description}
				output={settled(p) ? undefined : shellOutput(p.output)}
				status={status}
				failed={p.isError}
				formatCommand
			/>
			{settled(p) && <StateNote {...p} />}
		</>
	);
}

function ScriptRun({ run, p }: { run: CommandRun; p: BodyProps }) {
	const [open, setOpen] = useState(false);
	const res = useMemo(() => scriptResult(p.output), [p.output]);
	const shells = run.steps.filter(isShell).length;
	// One exec_command result per command: each shows under its command.
	const perStep = res.parts?.length === shells ? res.parts : undefined;
	let k = 0;
	return (
		<>
			{run.steps.map((step, i) => {
				if (!isShell(step))
					return (
						<CodeBlock
							key={i}
							code={step.call}
							lang="typescript"
							title="Script call"
							format
							className="ds-cmd-call"
						/>
					);
				const part = perStep?.[k++];
				const exit = part?.exitCode;
				return (
					<CommandBlock
						key={i}
						command={step.cmd}
						cwd={step.cwd ?? p.callCwd ?? p.agentCwd}
						project={p.agentCwd}
						output={part?.output}
						status={
							exit !== undefined && exit !== 0 ? `Exit ${exit}` : undefined
						}
						failed={exit !== undefined && exit !== 0}
						formatCommand
					/>
				);
			})}
			{run.script && (
				<div className="ds-cmd-script">
					<button
						type="button"
						className="ds-code-more ds-cmd-script-toggle"
						aria-expanded={open}
						onClick={() => setOpen((o) => !o)}
					>
						<ChevronDownIcon
							aria-hidden="true"
							className={open ? "flip" : ""}
						/>
						{open ? "Hide script" : "Show script"}
						{res.wallMs !== undefined && (
							<span className="ds-cmd-wall"> · {duration(res.wallMs)}</span>
						)}
					</button>
					{open && (
						<CodeBlock
							code={run.script.code}
							lang={run.script.lang}
							title="Script"
							maxLines={30}
							format
						/>
					)}
				</div>
			)}
			{settled(p) || p.isError ? (
				<StateNote {...p} />
			) : !perStep && res.output.trim() ? (
				<CodeBlock
					className="tool-out"
					code={res.output}
					tone="terminal"
					title="Output"
					maxLines={14}
				/>
			) : null}
		</>
	);
}
