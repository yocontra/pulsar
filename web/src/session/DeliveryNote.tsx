/**
 * Under the operator's last sent bubble, iMessage-style: "Delivered",
 * "Read", "Replied", or a red "Not delivered" with Retry. Reads the
 * message's receipts live. Loaded lazily by Transcript.tsx (it uses the
 * data layer, which the renderer itself must not import).
 */
import { useEffect, useState } from "react";
import { api } from "../api/client.ts";
import type { ReceiptsPage } from "../api/types.ts";
import { sendConfirmed } from "../components/Composer.tsx";
import { sentHere } from "../lib/sent.ts";
import { onReceipts, watchReceipts } from "../lib/store.ts";

const WORD: Record<string, string> = {
	queued: "Sent",
	sent: "Sent",
	delivered: "Delivered",
	read: "Read",
	replied: "Replied",
	held: "Held",
	refused: "Not delivered",
	failed: "Not delivered",
};

/**
 * The last receipts seen per message: the optimistic bubble's note and the
 * echo's (a new element, same message id) show the same state, no flash.
 */
const lastSeen = new Map<string, ReceiptsPage>();

export function DeliveryNote({ messageId }: { messageId: string }) {
	const [r, setSeen] = useState<ReceiptsPage | null>(
		() => lastSeen.get(messageId) ?? null,
	);
	const setR = (x: ReceiptsPage) => {
		lastSeen.set(messageId, x);
		if (lastSeen.size > 50) lastSeen.delete(lastSeen.keys().next().value!);
		setSeen(x);
	};
	const [retrying, setRetrying] = useState(false);
	const mine = sentHere(messageId);
	useEffect(() => {
		if (!mine) return;
		let live = true;
		api
			.receipts(messageId)
			.then((x) => live && setR(x))
			.catch(() => {});
		const unwatch = watchReceipts(messageId);
		const off = onReceipts((x) => {
			if (x.message.id === messageId) setR(x);
		});
		return () => {
			live = false;
			unwatch();
			off();
		};
	}, [messageId, mine]);
	// Accepted, receipts not loaded yet: the first step.
	if (!r)
		return mine ? (
			<p className="ds-delivery" aria-live="polite" data-state="sent">
				Sent
			</p>
		) : null;
	// A broadcast reaches many: its bubble keeps quiet (the results say it).
	if (r.total !== 1) return null;
	const one = r.items[0];
	if (!one) return null;
	const bad = one.state === "failed" || one.state === "refused";
	return (
		<p
			className={`ds-delivery${bad ? " is-failed" : ""}`}
			aria-live="polite"
			data-state={one.state}
		>
			{WORD[one.state] ?? one.state}
			{one.state === "failed" && (
				<button
					type="button"
					disabled={retrying}
					onClick={() => {
						setRetrying(true);
						void sendConfirmed({
							ids: [one.agentId],
							body: r.message.body,
							priority: r.message.priority,
							expectReply: r.message.expectReply,
						}).finally(() => setRetrying(false));
					}}
				>
					{retrying ? "Retrying…" : "Retry"}
				</button>
			)}
		</p>
	);
}
