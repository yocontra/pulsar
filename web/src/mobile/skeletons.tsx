/**
 * Skeletons render the real row and page structure (RowShell, IonItem,
 * section headers) with placeholder bars, so the loaded layout lands on the
 * same pixels. e2e/phone.e2e.ts compares their boxes.
 */

import { observer } from "../lib/signals.ts";
import {
	IonContent,
	IonHeader,
	IonItem,
	IonTitle,
	IonToolbar,
} from "./ionic.ts";
import { RowShell } from "./rows.tsx";

/** Widths that look like names without repeating (deterministic). */
const W = [46, 34, 58, 40, 52, 30, 44, 62, 38, 50];

function SkeletonRowsImpl({
	count,
	depth = 0,
	section = false,
	last = true,
	kind = "group",
}: {
	count: number;
	depth?: number;
	section?: boolean;
	last?: boolean;
	kind?: "group" | "agent";
}) {
	const rows = Array.from({ length: count }, (_, i) => i);
	const cells = rows.map((i) => {
		const isLast = i === count - 1 && last;
		const lead =
			kind === "agent" ? (
				<span className="p-avatar p-sk" aria-hidden="true" />
			) : (
				<span className="p-icon p-sk" aria-hidden="true" />
			);
		return (
			<IonItem
				key={i}
				lines={isLast ? "none" : "inset"}
				detail={false}
				className="p-sk-item"
			>
				<RowShell
					kind={kind}
					depth={depth}
					lead={lead}
					title=""
					sk={{ title: W[i % W.length]!, sub: W[(i + 3) % W.length]! + 20 }}
				/>
			</IonItem>
		);
	});
	if (!section) return <>{cells}</>;
	return (
		<div
			className="p-list is-static"
			role="status"
			aria-busy="true"
			aria-label="Loading"
		>
			<div className="p-vrow is-static" data-sk="section">
				<div className="p-section is-first" role="presentation">
					<h2>Machines</h2>
				</div>
			</div>
			{rows.map((i) => (
				<div
					key={i}
					className={`p-vrow is-static${i === 0 ? " gf" : ""}${i === count - 1 ? " gl" : ""}`}
					data-sk="row"
				>
					<div className="p-cell">{cells[i]}</div>
				</div>
			))}
		</div>
	);
}
export const SkeletonRows = observer(SkeletonRowsImpl);

/** A page that hasn't loaded: its bar and a few skeleton rows. */
export function PageSkeleton({ title }: { title: string }) {
	return (
		<>
			<IonHeader>
				<IonToolbar>
					<IonTitle>{title}</IonTitle>
				</IonToolbar>
			</IonHeader>
			<IonContent>
				<SkeletonRows count={6} section />
			</IonContent>
		</>
	);
}
