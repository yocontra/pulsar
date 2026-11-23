/**
 * The Diagnostics page body on the desktop: a summary of every machine,
 * then each machine's `pulsar doctor` report with problems and notes
 * first (each with its fix and a command to copy), the checks that passed
 * folded into one row, and the machine's facts. The phone's layout is
 * PhoneView.tsx; both use parts.tsx.
 */
import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/client.ts";
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

function Summary({ machines }: { machines: MachineRow[] }) {
	const now = useNow();
	if (!machines.length) return null;
	return (
		<ul className="d-card diag-summary" aria-label="Machines">
			{machines.map((m) => {
				const h = health(m);
				return (
					<li key={m.machineId}>
						<button
							type="button"
							className="diag-sum-row"
							data-summary={m.name}
							onClick={() => showMachine(m)}
						>
							<StatusIcon tone={h.tone} />
							<span className="diag-sum-text">
								<span className="diag-sum-name">
									{m.name}
									{m.self && <span className="diag-tag">This machine</span>}
								</span>
								<span className="diag-sum-line">{machineLine(m, now)}</span>
							</span>
							<span className={`diag-sum-state is-${h.tone}`}>{h.label}</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

function Machine({ m }: { m: MachineRow }) {
	const [open, setOpen] = useState(false);
	const h = health(m);
	const id = machineAnchor(m);
	const todo = m.report ? attention(m.report.checks) : [];
	const ok = m.report ? passed(m.report.checks) : [];
	const facts = factRows(m);
	return (
		<section
			className="diag-machine"
			aria-labelledby={id}
			data-machine={m.name}
		>
			<header className="diag-machine-head">
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
					<span className={`diag-health is-${h.tone}`}>
						<StatusIcon tone={h.tone} />
						{h.label}
					</span>
				)}
			</header>
			{m.upgrade && (
				<p className="diag-upgrade" role="note">
					<TriangleAlertIcon aria-hidden="true" />
					<span>
						<Text text={m.upgrade} />
					</span>
				</p>
			)}
			{m.error && (
				<p className="diag-error">
					<span className="diag-sr">No report: </span>
					{m.error}
				</p>
			)}
			{m.report && (
				<ul className="d-card diag-card">
					{todo.length > 0 && (
						<li>
							<ul className="diag-checks diag-problems">
								{todo.map((c, i) => (
									<li
										key={i}
										className={`diag-check is-${c.level}`}
										data-level={c.level}
									>
										<LevelIcon level={c.level} />
										<CheckBody c={c} />
									</li>
								))}
							</ul>
						</li>
					)}
					{ok.length > 0 && (
						<li>
							<button
								type="button"
								className="diag-passed-toggle"
								aria-expanded={open}
								aria-controls={`${id}-passed`}
								onClick={() => setOpen(!open)}
							>
								<LevelIcon level="ok" />
								<span className="diag-passed-label">
									{passedLabel(ok.length)}
								</span>
								<ChevronRightIcon className="diag-chev" aria-hidden="true" />
							</button>
							{open && (
								<div id={`${id}-passed`} className="diag-passed">
									{grouped(ok).map(([group, checks]) => (
										<div key={group} className="diag-group">
											<h3 className="diag-group-name">
												{GROUP_LABEL[group] ?? group}
											</h3>
											<ul className="diag-checks">
												{checks.map((c, i) => (
													<li
														key={i}
														className="diag-check is-ok"
														data-level="ok"
													>
														<LevelIcon level="ok" />
														<CheckBody c={c} detail={false} />
													</li>
												))}
											</ul>
										</div>
									))}
								</div>
							)}
						</li>
					)}
				</ul>
			)}
			{facts.length > 0 && (
				<dl className="diag-facts">
					{facts.map(([k, v]) => (
						<div key={k} className="diag-fact">
							<dt>{k}</dt>
							<dd>{v}</dd>
						</div>
					))}
				</dl>
			)}
		</section>
	);
}

export function DiagnosticsView({ d }: { d: Diagnostics }) {
	const { list, machines } = d;
	const skew = skewText(d);
	return (
		<div className="diag diag-desktop">
			<header className="diag-head">
				<h1 className="diag-title">Diagnostics</h1>
				<span className="diag-spacer" />
				<CheckStatus d={d} />
			</header>
			<div className="diag-body">
				{list.isError && !list.data && (
					<p className="diag-error" role="alert">
						{list.error instanceof ApiError
							? list.error.message
							: "Couldn't load diagnostics."}
					</p>
				)}
				{!list.data && !list.isError && (
					<p className="diag-muted diag-loading">Finding machines…</p>
				)}
				<Summary machines={machines} />
				{skew && (
					<div className="diag-skew" role="note" aria-label="Version skew">
						<TriangleAlertIcon aria-hidden="true" />
						<span>{skew}</span>
					</div>
				)}
				{machines.map((m) => (
					<Machine key={m.machineId} m={m} />
				))}
			</div>
		</div>
	);
}
