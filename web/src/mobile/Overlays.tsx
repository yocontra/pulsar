/**
 * Overlay routes as sheets (ui/SheetShell.tsx, each body with its own
 * header): approval (card sheet over its agent's
 * page), broadcast (card sheet) and the group composer (sheet with medium
 * and large detents). The route is the source of truth: a route that leaves
 * the stack dismisses its sheet; a sheet the operator swipes down, or closes with
 * its X or a tap on the backdrop, pops its route. Every sheet closes with
 * the X in its corner (Android adds Material's grabber). A swipe or a backdrop tap waits while an
 * action is in flight (a passkey ceremony, a send).
 */
import { useRef, useState } from "react";
import { inFlight } from "../lib/inflight.ts";
import { lazy } from "../lib/lazy.tsx";
import { back, navigate, type Route, stack } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import { approvalItem } from "../lib/store.ts";

const Builder = lazy(() => import("../builder/Builder.tsx"));
const ApprovalCard = lazy(() => import("../approval/ApprovalCard.tsx"));
const ScopeView = lazy<{ id: string; mobile: boolean }>(() =>
	import("../components/ScopeView.tsx").then((m) => ({ default: m.ScopeView })),
);

import { isOverlay } from "./stack.tsx";
import { SheetShell } from "./ui/SheetShell.tsx";

/** The overlay routes on top of the stack, bottom first. */
function overlays(s: Route[]): { route: Route; depth: number }[] {
	const out: { route: Route; depth: number }[] = [];
	for (let i = s.length - 1; i > 0 && isOverlay(s[i]!); i--)
		out.unshift({ route: s[i]!, depth: i });
	return out;
}

/** Close an overlay the operator dismissed (swipe down, backdrop, the X). */
export function closeOverlay(r: Route) {
	// A deep-linked prompt has no page under it: land on Home.
	if (r.view === "approval" && stack.peek().length < 2)
		navigate({ view: "home" }, { replace: true });
	else back({ animated: false });
}

type Entry = { route: Route; depth: number };
const keyOf = (o: Entry) =>
	`${o.depth}:${o.route.view}:${"id" in o.route ? o.route.id : ""}`;

function OverlaysImpl() {
	const list = overlays(stack.value);
	// Keep a dismissed sheet mounted (closed) until its dismiss animation
	// ends: computed during render, so React never unmounts it early.
	const [closing, setClosing] = useState<Entry[]>([]);
	const prev = useRef(list);
	/** Sheets the operator dismissed (already animated out): no closing pass. */
	const dismissed = useRef(new Set<string>());
	const now = new Set(list.map(keyOf));
	const gone = prev.current.filter(
		(o) =>
			!now.has(keyOf(o)) &&
			!dismissed.current.delete(keyOf(o)) &&
			!closing.some((c) => keyOf(c) === keyOf(o)),
	);
	prev.current = list;
	if (gone.length) setClosing((c) => [...c, ...gone]);
	const leaving = [...closing, ...gone].filter((o) => !now.has(keyOf(o)));
	const all = [
		...list.map((o) => ({ ...o, open: true })),
		...leaving.map((o) => ({ ...o, open: false })),
	];
	return (
		<>
			{all.map((o) => (
				<SheetShell
					key={keyOf(o)}
					open={o.open}
					title={labelOf(o.route)}
					head={false}
					{...sheetProps(o.route)}
					canDismiss={canDismiss}
					className="p-overlay"
					// Ionic dismisses (swipe, backdrop, Esc); the route follows below.
					onClose={() => {}}
					onClosed={() => {
						setClosing((l) => l.filter((x) => keyOf(x) !== keyOf(o)));
						if (o.open) {
							dismissed.current.add(keyOf(o));
							closeOverlay(o.route);
						}
					}}
				>
					<OverlayBody route={o.route} />
				</SheetShell>
			))}
		</>
	);
}

function labelOf(r: Route) {
	if (r.view === "approval") return "Approval";
	if (r.view === "broadcast") return "Broadcast";
	return "Message group";
}

/** A swipe or backdrop tap doesn't drop an action in flight. */
const canDismiss = async (_data?: unknown, role?: string) =>
	(role !== "gesture" && role !== "backdrop") || inFlight.peek() === 0;

/** The node composer: medium and large detents; the others: card sheets. */
function sheetProps(r: Route) {
	return r.view === "node"
		? { detents: [0, 0.6, 1], initial: 0.6 }
		: { card: true };
}

/** A prompt with no conversation (approval/sessionless.ts): the card as a sheet. */
function ApprovalBodyImpl({ id }: { id: string }) {
	const item = approvalItem(id);
	if (!item) return null;
	return <ApprovalCard item={item} mobile />;
}
const ApprovalBody = observer(ApprovalBodyImpl);

function OverlayBody({ route }: { route: Route }) {
	switch (route.view) {
		case "approval":
			return <ApprovalBody id={route.id} />;
		case "broadcast":
			return <Builder selector={route.selector} mobile />;
		case "node":
			return <ScopeView id={route.id} mobile />;
		default:
			return null;
	}
}

export default observer(OverlaysImpl);
