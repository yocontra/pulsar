/**
 * What an approval asks, shared by the phone sheet and the desktop card:
 * who asks and for which tool, the tool's input (ToolInput: Bash's
 * description then the highlighted command, a diff for edits, a path or
 * URL line), where it runs (the project, the full path on hover) and the
 * session rule "Allow for session" adds. Hidden characters stay visible as
 * red tags everywhere, inside the highlighting too: the exact rendering is
 * the safety feature. The decision flow stays in ApprovalCard.
 */
import { FolderIcon, GitBranchIcon } from "lucide-react";
import { Fragment } from "react";
import type { Approval } from "../api/types.ts";
import { AgentAvatar } from "../components/ui/agent-avatar.tsx";
import { Exact, Marked } from "./exact.tsx";
import { ToolInput } from "./ToolInput.tsx";

export { Exact, Marked };

/** The project's name for a card: the agent's project, else the folder's name. */
export function projectName(
	project: string | null | undefined,
	cwd: string | null | undefined,
): string | null {
	if (project) return project;
	const base = cwd
		?.replace(/[\\/]+$/, "")
		.split(/[\\/]/)
		.pop();
	return base || null;
}

/** "studio-app · main": where a prompt runs, with the full path on hover. */
export function WhereLine({
	project,
	cwd,
	branch,
	className = "ds-ap-meta",
}: {
	project: string | null | undefined;
	cwd: string | null | undefined;
	branch: string | null | undefined;
	className?: string;
}) {
	const name = projectName(project, cwd);
	if (!name && !branch) return null;
	return (
		<p className={className}>
			{name && (
				<span className="ds-ap-where-item" title={cwd ?? undefined}>
					<FolderIcon aria-hidden="true" />
					<Marked text={name} />
				</span>
			)}
			{branch && (
				<span className="ds-ap-where-item">
					<GitBranchIcon aria-hidden="true" />
					<Marked text={branch} />
				</span>
			)}
		</p>
	);
}

export function ApprovalDetails({
	approval: ap,
	agent,
	variant,
	showRules = true,
	readOnly = false,
}: {
	approval: Approval;
	agent: {
		name: string;
		machine?: string | null;
		harness?: string | null;
		project?: string | null;
	};
	variant: "phone" | "desktop";
	/** Show what "Allow for session" adds (the phone sheet; desktop shows it by the button). */
	showRules?: boolean;
	/** Shown only (the terminal answers it): "asked to run", no rules, no race. */
	readOnly?: boolean;
}) {
	const rules = ap.sessionRules?.length && !readOnly ? ap.sessionRules : null;
	return (
		<div className={`ds-approval ds-approval--${variant}`}>
			<p className="ds-ap-who">
				<AgentAvatar harness={agent.harness} size="xs" />
				<span>
					<span className="ds-ap-name">
						<Marked text={agent.name} />
					</span>{" "}
					on <Marked text={agent.machine ?? "?"} />{" "}
					{readOnly ? "asks to run" : "wants to run"}{" "}
					<strong className="ds-ap-tool">
						<Marked text={ap.tool} />
					</strong>
				</span>
			</p>

			<section
				className="ds-ap-input"
				aria-label="Exactly what it runs"
				// The input's hash, to compare with the agent's own screen.
				title={readOnly ? undefined : `Input ${ap.inputHash}`}
			>
				<ToolInput tool={ap.tool} input={ap.input} />
			</section>

			<WhereLine project={agent.project} cwd={ap.cwd} branch={ap.branch} />

			{showRules && rules && (
				<p className="ds-ap-foot ds-ap-rules">
					Allow for session adds{" "}
					{rules.map((r, i) => (
						<Fragment key={i}>
							{i ? ", " : ""}
							<code>
								<Marked text={r} />
							</code>
						</Fragment>
					))}
				</p>
			)}
		</div>
	);
}
