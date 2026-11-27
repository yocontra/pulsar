import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.ts";
import { useAgent, useAgents } from "../data/hooks.ts";
import { keys } from "../data/keys.ts";
import { queryClient } from "../data/runtime.ts";
import { addAgentDraftText } from "../lib/composer-draft.ts";
import { backBy, navigate, stack } from "../lib/router.ts";
import { showToast } from "../lib/store.ts";
import { messagesViaParent } from "../lib/subagents.ts";

/** File line numbers are 1-based. A diff supplies only one side of one hunk. */
export function ReviewLines({
	agentId,
	path,
	source,
	first = 1,
	at,
	through = at,
	lines,
	onClose,
}: {
	agentId: string;
	path: string;
	source: string;
	first?: number;
	at: number;
	through?: number;
	lines: string[];
	onClose: () => void;
}) {
	const [start, setStart] = useState(String(at));
	const [end, setEnd] = useState(String(through));
	const [error, setError] = useState("");
	const firstInput = useRef<HTMLInputElement>(null);
	useEffect(() => firstInput.current?.focus(), []);
	const pages = stack.peek();
	const found = pages.findLastIndex(
		(r) => r.view === "agent" || r.view === "subagent",
	);
	const origin = pages[found];
	const childId =
		typeof history.state?.reviewChild === "string"
			? (history.state.reviewChild as string)
			: origin?.view === "subagent"
				? origin.id
				: "";
	const child = useQuery(
		{
			queryKey: keys.subagent(childId),
			queryFn: () => api.subagent(childId),
			enabled: !!childId,
		},
		queryClient,
	).data;
	const [chooseChat, setChooseChat] = useState(false);
	const [otherId, setOtherId] = useState("");
	const agents = useAgents({ selector: "", sort: "name", enabled: chooseChat });
	const sourceAgent = useAgent(chooseChat ? agentId : null).data;
	const last = first + lines.length - 1;
	function reviewText() {
		const lo = Number(start),
			hi = Number(end);
		if (
			!Number.isSafeInteger(lo) ||
			!Number.isSafeInteger(hi) ||
			lo < first ||
			hi > last ||
			lo > hi
		)
			return null;
		const snippet = lines.slice(lo - first, hi - first + 1).join("\n");
		// Indented Markdown quotes preserve code containing its own fences.
		return `${path}:${lo}${hi === lo ? "" : `-${hi}`} (${source})\n\n${snippet
			.split("\n")
			.map((l) => `    ${l}`)
			.join("\n")}\n\n`;
	}

	return (
		<form
			className="review-lines"
			aria-label="Review lines"
			onSubmit={(e) => {
				e.preventDefault();
				const quote = reviewText();
				if (!quote) return;
				const destination = chooseChat ? otherId : "";
				if (
					destination &&
					!agents.items.some((a) => a.id === destination && !a.archived)
				) {
					setError("Choose an open chat.");
					return;
				}
				const recipient =
					!destination && child?.parentId === agentId ? child : null;
				if (
					(!destination && childId && !recipient) ||
					(recipient && !recipient.messaging)
				) {
					setError("Open the chat again to check where this review will go.");
					return;
				}
				const sourceLocation = sourceAgent
					? [sourceAgent.name, sourceAgent.machineId, sourceAgent.cwd]
							.filter(Boolean)
							.join(" · ")
					: agentId;
				const issue = addAgentDraftText(
					destination || recipient?.id || agentId,
					destination && destination !== agentId
						? `From ${sourceLocation}\n${quote}`
						: quote,
					recipient ? messagesViaParent(recipient) : false,
				);
				if (issue) {
					setError(issue);
					return;
				}
				onClose();
				if (
					!destination &&
					(recipient || (origin?.view === "agent" && origin.id === agentId)) &&
					found >= 0 &&
					found < pages.length - 1
				)
					backBy(pages.length - 1 - found);
				else
					navigate(
						recipient
							? { view: "subagent", id: recipient.id }
							: { view: "agent", id: destination || agentId },
					);
			}}
		>
			<span>{source}</span>
			<label>
				From{" "}
				<input
					ref={firstInput}
					aria-label="First review line"
					type="number"
					inputMode="numeric"
					required
					min={first}
					max={last}
					value={start}
					onChange={(e) => {
						setStart(e.target.value);
						if (Number(end) < Number(e.target.value)) setEnd(e.target.value);
					}}
				/>
			</label>
			<label>
				To{" "}
				<input
					aria-label="Last review line"
					type="number"
					inputMode="numeric"
					required
					min={Math.max(first, Number(start))}
					max={last}
					value={end}
					onChange={(e) => setEnd(e.target.value)}
				/>
			</label>
			{chooseChat ? (
				<>
					<select
						aria-label="Destination chat"
						value={otherId}
						onChange={(e) => {
							setOtherId(e.target.value);
							setError("");
						}}
					>
						<option value="">Current chat</option>
						{agents.items
							.filter((a) => !a.archived)
							.map((a) => (
								<option key={a.id} value={a.id}>
									{a.name} · {a.project || a.harness} · {a.machineId}
								</option>
							))}
					</select>
					{agents.hasNextPage && (
						<button
							type="button"
							className="d-btn sm"
							disabled={agents.isFetchingNextPage}
							onClick={() => void agents.fetchNextPage()}
						>
							More chats
						</button>
					)}
					{agents.isError && (
						<button
							type="button"
							className="d-btn sm"
							onClick={() => void agents.refetch()}
						>
							Retry loading chats
						</button>
					)}
				</>
			) : (
				<button
					type="button"
					className="d-btn sm"
					onClick={() => setChooseChat(true)}
				>
					Choose another chat
				</button>
			)}
			<button type="submit" className="d-btn sm">
				Add to chat
			</button>
			<button
				type="button"
				className="d-btn sm"
				onClick={async (e) => {
					if (!e.currentTarget.form?.reportValidity()) return;
					const quote = reviewText();
					if (!quote) return;
					try {
						await navigator.clipboard.writeText(quote);
						showToast("Review lines copied");
					} catch {
						setError("Clipboard access is unavailable.");
					}
				}}
			>
				Copy quote
			</button>
			<button type="button" className="d-btn sm" onClick={onClose}>
				Cancel
			</button>
			{error && <span role="alert">{error}</span>}
		</form>
	);
}
