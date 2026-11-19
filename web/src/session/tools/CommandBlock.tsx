import { folderLabel } from "../../../../src/transcripts/command.ts";
import { TerminalBlock } from "../CodeBlock.tsx";

/**
 * One shell command as a terminal: the command highlighted as Bash, where
 * it ran ("web/", the project's name at its root, "~/…" elsewhere; the
 * absolute path as a tooltip), the agent's description as the header,
 * status words, and the output (ANSI colors, folded past `maxLines`).
 *
 * Shared by every harness's shell tools; the approval card can reuse it to
 * show a command exactly as it will run (nothing here reformats it).
 */
export function CommandBlock({
	command,
	cwd,
	project,
	description,
	output,
	status,
	failed,
	formatCommand = false,
	maxLines,
	className,
}: {
	command: string;
	/**
	 * Break a long one-line `&&` / `;` chain onto lines for display. Off by
	 * default: an approval must show the command exactly as it will run.
	 */
	formatCommand?: boolean;
	/** The folder it ran in, as the call or the log gave it. */
	cwd?: string | null;
	/** The agent's project folder, to show `cwd` relative to it. */
	project?: string | null;
	description?: string;
	output?: string;
	/** "Exit 1", "In background", "0.4 s". */
	status?: string;
	failed?: boolean;
	maxLines?: number;
	className?: string;
}) {
	return (
		<TerminalBlock
			command={command}
			output={output}
			title={description}
			folder={folderLabel(cwd, project)}
			status={status}
			failed={failed}
			formatCommand={formatCommand}
			maxLines={maxLines}
			className={`ds-cmd${className ? ` ${className}` : ""}`}
		/>
	);
}
