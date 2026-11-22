/**
 * The Diagnostics page body (desktop pane and phone page): every machine's
 * `pulsar doctor` checks, grouped, with the fix for each problem, the
 * machine's facts, and a note for each machine on an older Pulsar.
 */
import {
	CircleCheckIcon,
	CircleXIcon,
	InfoIcon,
	RefreshCwIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "../../api/client.ts";
import type { DiagCheck, DiagLevel } from "../../api/types.ts";
import { ago } from "../../ds/index.ts";
import {
	certLabel,
	type Diagnostics,
	GROUP_LABEL,
	grouped,
	health,
	type MachineRow,
	spans,
	TAILSCALE_LABEL,
	uptime,
} from "./model.ts";
import "./diagnostics.css";

const LEVEL_LABEL: Record<DiagLevel, string> = {
	ok: "Passed",
	note: "Note",
	bad: "Problem",
};

function Text({ text }: { text: string }) {
	return (
		<>
			{spans(text).map((s, i) =>
				s.code ? <code key={i}>{s.text}</code> : <span key={i}>{s.text}</span>,
			)}
		</>
	);
}

function LevelIcon({ level }: { level: DiagLevel }) {
	const Icon =
		level === "ok" ? CircleCheckIcon : level === "bad" ? CircleXIcon : InfoIcon;
	return (
		<span className={`diag-level is-${level}`}>
			<Icon aria-hidden="true" />
			<span className="diag-sr">{LEVEL_LABEL[level]}: </span>
		</span>
	);
}

function CheckRow({ c }: { c: DiagCheck }) {
	return (
		<li className={`diag-check is-${c.level}`} data-level={c.level}>
			<LevelIcon level={c.level} />
			<span className="diag-check-body">
				<span className="diag-check-text">
					<Text text={c.text} />
				</span>
				{c.fix && (
					<span className="diag-fix">
						<span className="diag-fix-label">Fix: </span>
						<Text text={c.fix} />
					</span>
				)}
			</span>
		</li>
	);
}

function Facts({ m }: { m: MachineRow }) {
	const r = m.report;
	if (!r) return null;
	const ts = r.facts.tailscale;
	const lag = r.eventLoop;
	const rows: [string, string][] = [
		["Pulsar", r.version],
		["Uptime", uptime(r.uptimeS)],
		[
			"Event loop",
			lag
				? `p99 ${Math.round(lag.p99)} ms, max ${Math.round(lag.max)} ms${lag.stalls ? `, ${lag.stalls} stall${lag.stalls === 1 ? "" : "s"}` : ""}`
				: "Not measured",
		],
		["Agents", String(r.agents)],
		[
			"Tailscale",
			ts
				? [TAILSCALE_LABEL[ts.state] ?? ts.state, ts.version]
						.filter(Boolean)
						.join(" · ")
				: "Not checked",
		],
	];
	if (r.facts.certDays !== null)
		rows.push(["Certificate", certLabel(r.facts.certDays)]);
	for (const h of r.facts.harnesses)
		rows.push([h.label, h.version ?? "Version unknown"]);
	return (
		<dl className="diag-facts">
			{rows.map(([k, v]) => (
				<div key={k} className="diag-fact">
					<dt>{k}</dt>
					<dd>{v}</dd>
				</div>
			))}
		</dl>
	);
}

function Machine({ m }: { m: MachineRow }) {
	const h = health(m);
	const id = `diag-m-${m.machineId.replace(/[^A-Za-z0-9_-]/g, "")}`;
	return (
		<section
			className="diag-machine"
			aria-labelledby={id}
			data-machine={m.name}
		>
			<header className="diag-machine-head">
				<h2 id={id} className="diag-machine-name">
					{m.name}
					{m.self && <span className="diag-tag">This machine</span>}
				</h2>
				{m.checking ? (
					<span className="diag-health is-checking" role="status">
						<RefreshCwIcon className="diag-spin" aria-hidden="true" />
						Checking…
					</span>
				) : (
					<span className={`diag-health is-${h.tone}`}>{h.label}</span>
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
			<Facts m={m} />
			{m.report &&
				grouped(m.report.checks).map(([group, checks]) => (
					<div key={group} className="diag-group">
						<h3 className="diag-group-name">{GROUP_LABEL[group] ?? group}</h3>
						<ul className="diag-checks">
							{checks.map((c, i) => (
								<CheckRow key={i} c={c} />
							))}
						</ul>
					</div>
				))}
		</section>
	);
}

/** Seconds since `start`, ticking while shown. */
function useElapsed(start: number | null) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (start === null) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [start]);
	return start === null ? 0 : Math.max(0, Math.round((now - start) / 1000));
}

/** Refresh, replaced in place by its progress while machines are checked. */
export function RefreshControl({ d }: { d: Diagnostics }) {
	const elapsed = useElapsed(d.checking ? d.startedAt : null);
	if (d.checking) {
		const left = d.machines.filter((m) => m.checking).length;
		return (
			<span className="diag-progress" role="status">
				<RefreshCwIcon className="diag-spin" aria-hidden="true" />
				{left
					? `Checking ${left} machine${left === 1 ? "" : "s"}…`
					: "Checking…"}{" "}
				{elapsed} s
			</span>
		);
	}
	return (
		<button type="button" className="diag-refresh" onClick={d.refresh}>
			<RefreshCwIcon aria-hidden="true" />
			Check again
		</button>
	);
}

export function DiagnosticsView({
	variant,
	d,
}: {
	variant: "desktop" | "phone";
	d: Diagnostics;
}) {
	const { list, machines } = d;
	const behind = machines.filter((m) => m.upgrade);
	const checkedAt = machines.find((m) => m.self)?.report?.checkedAt;
	return (
		<div className={`diag diag-${variant}`}>
			{variant === "desktop" && (
				<header className="diag-head">
					<h1 className="diag-title">Diagnostics</h1>
					{checkedAt ? (
						<span className="diag-muted">Checked {ago(checkedAt)}</span>
					) : null}
					<span className="diag-spacer" />
					<RefreshControl d={d} />
				</header>
			)}
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
			{behind.length > 0 && (
				<div className="diag-skew" role="note" aria-label="Version skew">
					<TriangleAlertIcon aria-hidden="true" />
					<span>
						Machines run different Pulsar versions (newest {d.newest}).{" "}
						{behind.map((m) => `Upgrade pulsar on ${m.name}.`).join(" ")}
					</span>
				</div>
			)}
			{machines.map((m) => (
				<Machine key={m.machineId} m={m} />
			))}
		</div>
	);
}
