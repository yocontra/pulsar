/**
 * Pieces both Diagnostics layouts share (desktop DiagnosticsView.tsx, phone
 * PhoneView.tsx): status icons, a check's text, detail and fix with its
 * command to copy, the machine facts, and when it was last checked. No
 * Konsta here: the desktop chunk loads this file.
 */
import {
	CheckIcon,
	CircleAlertIcon,
	CircleCheckIcon,
	CircleDashedIcon,
	CircleXIcon,
	CopyIcon,
	LoaderCircleIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DiagCheck, DiagLevel } from "../../api/types.ts";
import { ago } from "../../ds/index.ts";
import { showToast } from "../../lib/store.ts";
import {
	certLabel,
	type Diagnostics,
	fixParts,
	GROUP_LABEL,
	type Health,
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

/** The id of a machine's heading (the summary scrolls to it). */
export const machineAnchor = (m: MachineRow) =>
	`diag-m-${m.machineId.replace(/[^A-Za-z0-9_-]/g, "")}`;

/** Scroll a machine's section into view and move focus to its heading. */
export function showMachine(m: MachineRow) {
	const h = document.getElementById(machineAnchor(m));
	if (!h) return;
	const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
	h.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
	h.focus({ preventScroll: true });
}

export function Text({ text }: { text: string }) {
	return (
		<>
			{spans(text).map((s, i) =>
				s.code ? <code key={i}>{s.text}</code> : <span key={i}>{s.text}</span>,
			)}
		</>
	);
}

export function LevelIcon({ level }: { level: DiagLevel }) {
	const Icon =
		level === "ok"
			? CircleCheckIcon
			: level === "bad"
				? CircleXIcon
				: CircleAlertIcon;
	return (
		<span className={`diag-level is-${level}`}>
			<Icon aria-hidden="true" />
			<span className="diag-sr">{LEVEL_LABEL[level]}: </span>
		</span>
	);
}

/** A machine's overall state as an icon on a tinted disc. */
export function StatusIcon({ tone }: { tone: Health }) {
	const Icon =
		tone === "ok"
			? CircleCheckIcon
			: tone === "problems"
				? CircleXIcon
				: tone === "notes"
					? CircleAlertIcon
					: tone === "checking"
						? LoaderCircleIcon
						: CircleDashedIcon;
	return (
		<span className={`diag-status is-${tone}`} aria-hidden="true">
			<Icon className={tone === "checking" ? "diag-spin" : undefined} />
		</span>
	);
}

function CopyButton({ text }: { text: string }) {
	const [done, setDone] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			showToast("Copied command");
			setDone(true);
			clearTimeout(timer.current);
			timer.current = setTimeout(() => setDone(false), 1500);
		} catch {
			showToast("Couldn't copy the command", "warn");
		}
	};
	return (
		<button
			type="button"
			className="diag-copy"
			aria-label={`Copy ${text}`}
			onClick={() => void copy()}
		>
			{done ? (
				<CheckIcon aria-hidden="true" />
			) : (
				<CopyIcon aria-hidden="true" />
			)}
			<span aria-hidden="true">{done ? "Copied" : "Copy"}</span>
		</button>
	);
}

/** Doctor's fix: its prose, and each command as a chip with a Copy button. */
export function Fix({ fix }: { fix: string }) {
	return (
		<span className="diag-fix">
			<span className="diag-fix-label">Fix: </span>
			{fixParts(fix).map((p, i) =>
				p.command ? (
					<span key={i} className="diag-cmd">
						<code>{p.text}</code>
						<CopyButton text={p.text} />
					</span>
				) : p.code ? (
					<code key={i}>{p.text}</code>
				) : (
					<span key={i}>{p.text}</span>
				),
			)}
		</span>
	);
}

/** A check's text, its group (when not under a group heading), and its fix. */
export function CheckBody({
	c,
	detail = true,
}: {
	c: DiagCheck;
	detail?: boolean;
}) {
	return (
		<span className="diag-check-body">
			<span className="diag-check-text">
				<Text text={c.text} />
			</span>
			{detail && (
				<span className="diag-check-detail">
					{GROUP_LABEL[c.group] ?? c.group}
				</span>
			)}
			{c.fix && <Fix fix={c.fix} />}
		</span>
	);
}

/** The machine's facts as label/value pairs. */
export function factRows(m: MachineRow): [string, string][] {
	const r = m.report;
	if (!r) return [];
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
	return rows;
}

/** "N checks passed". */
export const passedLabel = (n: number) =>
	`${n} check${n === 1 ? "" : "s"} passed`;

/** The clock, ticking each second while shown. */
export function useNow() {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	return now;
}

/** "Pulsar 2.1.0 · checked 20s ago": the summary row's second line. */
export function machineLine(m: MachineRow, now: number): string {
	const version = m.report?.version ?? m.version;
	const at = m.report?.checkedAt;
	return [
		version ? `Pulsar ${version}` : null,
		at ? `checked ${ago(at, now)}` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * When this machine was last checked, or the progress while machines are
 * checked. Text only: the page checks again on its own (model.ts).
 */
export function CheckStatus({ d }: { d: Diagnostics }) {
	const now = useNow();
	const checkedAt = d.machines.find((m) => m.self)?.report?.checkedAt;
	if (d.checking) {
		const left = d.machines.filter((m) => m.checking).length;
		const elapsed = Math.max(0, Math.round((now - d.startedAt) / 1000));
		return (
			<span className="diag-progress" role="status">
				<LoaderCircleIcon className="diag-spin" aria-hidden="true" />
				{left
					? `Checking ${left} machine${left === 1 ? "" : "s"}…`
					: "Checking…"}{" "}
				{elapsed} s
			</span>
		);
	}
	if (!checkedAt) return null;
	return (
		<span className="diag-progress" data-testid="diag-checked">
			Checked {ago(checkedAt, now)}
		</span>
	);
}

/** The version skew notice (once, above the machines). */
export function skewText(d: Diagnostics): string | null {
	const behind = d.machines.filter((m) => m.upgrade);
	if (!behind.length) return null;
	return `Machines run different Pulsar versions (newest ${d.newest}). ${behind
		.map((m) => `Upgrade pulsar on ${m.name}.`)
		.join(" ")}`;
}
