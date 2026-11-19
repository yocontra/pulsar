import type { MessageHit } from "./api.ts";

const WHO: Record<MessageHit["role"], string> = {
	user: "You:",
	agent: "Agent:",
	peer: "Message:",
	tool: "Tool:",
};

/**
 * A hit's snippet: who wrote it ("You:" or "Agent:"), then the text with the
 * matched words bold. The text is plain (agent-written); only the ranges
 * the server sent are marked.
 */
export function Snippet({ hit }: { hit: MessageHit }) {
	const parts: React.ReactNode[] = [];
	let at = 0;
	for (const [a, b] of hit.marks) {
		if (a < at || b > hit.snippet.length) continue;
		if (a > at) parts.push(hit.snippet.slice(at, a));
		parts.push(<mark key={a}>{hit.snippet.slice(a, b)}</mark>);
		at = b;
	}
	if (at < hit.snippet.length) parts.push(hit.snippet.slice(at));
	return (
		<span className="msr-snip">
			<span className={`msr-who is-${hit.role}`}>
				{hit.role === "peer" && hit.from ? `${hit.from}:` : WHO[hit.role]}
			</span>{" "}
			{parts}
		</span>
	);
}
