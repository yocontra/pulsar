/**
 * A prompt only the agent's own terminal can answer (needs-you reason
 * `terminal`), shown where the prompt card would be: never answerable here.
 * When the app relayed it but its time ran out, the details are that
 * prompt's (the exact command, hidden characters marked); otherwise the
 * harness's own line ("permission prompt"). One line says why the app can't
 * answer it.
 */
import { CopyIcon, SquareTerminalIcon } from "lucide-react";
import type { AttentionItem } from "../api/types.ts";
import { showToast } from "../lib/store.ts";
import { ApprovalDetails } from "./ApprovalDetails.tsx";
import { terminalTitle, terminalWaitingFor, terminalWhy } from "./terminal.ts";

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		showToast("Copied command");
	} catch {
		showToast("Couldn't copy the command", "warn");
	}
}

export default function TerminalCard({
	item,
	mobile,
}: {
	item: AttentionItem;
	mobile: boolean;
}) {
	const a = item.agent;
	const ap = item.terminal?.approval;
	const why = terminalWhy(item);
	const waiting = terminalWaitingFor(item);
	const command =
		ap && typeof ap.input.command === "string" ? ap.input.command : null;
	const title = terminalTitle(a.machine);
	return (
		<div
			className={`prompt-inline${mobile ? " prompt-inline--phone" : ""}`}
			data-terminal-card=""
		>
			<article
				className="approval-card terminal-card"
				aria-label={`${title}: ${a.name}`}
			>
				<header>
					<SquareTerminalIcon size={16} aria-hidden="true" />
					<strong>{title}</strong>
				</header>
				{why && <p className="terminal-why">{why}</p>}
				{ap ? (
					<ApprovalDetails
						approval={ap}
						agent={a}
						variant={mobile ? "phone" : "desktop"}
						showRules={false}
						readOnly
					/>
				) : (
					<p className="terminal-what">
						{a.name} is waiting in its terminal
						{waiting ? `: ${waiting}` : ""}.
					</p>
				)}
				{command && (
					<div className="terminal-actions">
						<button
							type="button"
							className="btn"
							onClick={() => void copy(command)}
						>
							<CopyIcon size={14} aria-hidden="true" /> Copy command
						</button>
					</div>
				)}
			</article>
		</div>
	);
}
