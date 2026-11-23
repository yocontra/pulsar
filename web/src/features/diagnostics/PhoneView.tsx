/**
 * The Diagnostics page body on the phone, as Konsta grouped inset lists:
 * a Machines list (each machine's state, version and when it was checked;
 * a tap scrolls to it), then a section per machine with its problems and
 * notes first, the checks that passed folded into one row, and its facts.
 * The desktop's layout is DiagnosticsView.tsx; both use parts.tsx.
 */
import { BlockTitle, List, ListItem } from "konsta/react";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/client.ts";
import { GroupedList } from "../../mobile/ui/GroupedList.tsx";
import {
	attention,
	type Diagnostics,
	GROUP_LABEL,
	grouped,
	health,
	type MachineRow,
	passed,
} from "./model.ts";
import {
	CheckBody,
	CheckStatus,
	factRows,
	LevelIcon,
	machineAnchor,
	machineLine,
	passedLabel,
	StatusIcon,
	showMachine,
	skewText,
	Text,
	useNow,
} from "./parts.tsx";

function Summary({ d }: { d: Diagnostics }) {
	const now = useNow();
	if (!d.machines.length) return null;
	return (
		<GroupedList
			title="Machines"
			footer={<CheckStatus d={d} />}
			className="diag-summary"
		>
			{d.machines.map((m) => {
				const h = health(m);
				return (
					<ListItem
						key={m.machineId}
						link
						linkComponent="button"
						chevron={false}
						contentClassName="p-li-button diag-sum-row"
						media={<StatusIcon tone={h.tone} />}
						title={
							<span className="diag-sum-name">
								{m.name}
								{m.self && <span className="diag-tag">This machine</span>}
							</span>
						}
						text={<span className="diag-sum-line">{machineLine(m, now)}</span>}
						after={
							<span className={`diag-sum-state is-${h.tone}`}>{h.label}</span>
						}
						linkProps={{
							type: "button",
							onClick: () => showMachine(m),
							"data-summary": m.name,
						}}
					/>
				);
			})}
		</GroupedList>
	);
}

function Machine({ m }: { m: MachineRow }) {
	const [open, setOpen] = useState(false);
	const h = health(m);
	const id = machineAnchor(m);
	const todo = m.report ? attention(m.report.checks) : [];
	const ok = m.report ? passed(m.report.checks) : [];
	const facts = factRows(m);
	const rows = !!(m.upgrade || m.error || m.report);
	return (
		<section
			className="diag-machine"
			aria-labelledby={id}
			data-machine={m.name}
		>
			<BlockTitle className="diag-machine-head">
				<h2 id={id} className="diag-machine-name" tabIndex={-1}>
					{m.name}
					{m.self && <span className="diag-tag">This machine</span>}
				</h2>
				{m.checking ? (
					<span className="diag-health is-checking" role="status">
						<StatusIcon tone="checking" />
						Checking…
					</span>
				) : (
					<span className={`diag-health is-${h.tone}`}>{h.label}</span>
				)}
			</BlockTitle>
			{rows && (
				<List strong inset className="diag-card">
					{m.upgrade && (
						<ListItem
							strongTitle={false}
							media={
								<span className="diag-level is-note">
									<TriangleAlertIcon aria-hidden="true" />
								</span>
							}
							title={
								<span className="diag-upgrade" role="note">
									<Text text={m.upgrade} />
								</span>
							}
						/>
					)}
					{m.error && (
						<ListItem
							strongTitle={false}
							media={<StatusIcon tone="unknown" />}
							title={
								<span className="diag-error">
									<span className="diag-sr">No report: </span>
									{m.error}
								</span>
							}
						/>
					)}
					{todo.map((c, i) => (
						<ListItem
							key={i}
							className={`diag-check is-${c.level}`}
							data-level={c.level}
							strongTitle={false}
							media={<LevelIcon level={c.level} />}
							title={<CheckBody c={c} />}
						/>
					))}
					{ok.length > 0 && (
						<ListItem
							link
							linkComponent="button"
							chevron={false}
							contentClassName="p-li-button diag-passed-toggle"
							strongTitle={false}
							media={<LevelIcon level="ok" />}
							title={
								<span className="diag-passed-label">
									{passedLabel(ok.length)}
								</span>
							}
							after={
								<ChevronDownIcon className="diag-chev" aria-hidden="true" />
							}
							linkProps={{
								type: "button",
								onClick: () => setOpen(!open),
								"aria-expanded": open,
							}}
						/>
					)}
					{open &&
						grouped(ok).flatMap(([group, checks]) => [
							<ListItem
								key={group}
								groupTitle
								className="diag-group"
								title={
									<h3 className="diag-group-name">
										{GROUP_LABEL[group] ?? group}
									</h3>
								}
							/>,
							...checks.map((c, i) => (
								<ListItem
									key={`${group}-${i}`}
									className="diag-check is-ok"
									data-level="ok"
									strongTitle={false}
									media={<LevelIcon level="ok" />}
									title={<CheckBody c={c} detail={false} />}
								/>
							)),
						])}
				</List>
			)}
			{facts.length > 0 && (
				<List strong inset className="diag-facts">
					{facts.map(([k, v]) => (
						<ListItem
							key={k}
							strongTitle={false}
							className="diag-fact"
							titleWrapClassName="diag-fact-wrap"
							title={k}
							after={<span className="diag-fact-value">{v}</span>}
						/>
					))}
				</List>
			)}
		</section>
	);
}

export function DiagnosticsPhoneView({ d }: { d: Diagnostics }) {
	const { list, machines } = d;
	const skew = skewText(d);
	return (
		<div className="diag diag-phone">
			{list.isError && !list.data && (
				<p className="diag-error diag-inset" role="alert">
					{list.error instanceof ApiError
						? list.error.message
						: "Couldn't load diagnostics."}
				</p>
			)}
			{!list.data && !list.isError && (
				<p className="diag-muted diag-loading diag-inset">Finding machines…</p>
			)}
			<Summary d={d} />
			{skew && (
				<div
					className="diag-skew diag-inset"
					role="note"
					aria-label="Version skew"
				>
					<TriangleAlertIcon aria-hidden="true" />
					<span>{skew}</span>
				</div>
			)}
			{machines.map((m) => (
				<Machine key={m.machineId} m={m} />
			))}
		</div>
	);
}
