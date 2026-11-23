/** Diagnostics data: the queries, and what the page says about a machine. */
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { versionSkew } from "../../../../src/diagnostics/checks.ts";
import { ApiError, api } from "../../api/client.ts";
import type {
	DiagCheck,
	DiagLevel,
	MachineDiagnostics,
} from "../../api/types.ts";
import { queryClient, useLiveEvent } from "../../data/hooks.ts";
import { route } from "../../lib/router.ts";

export const diagnosticsKey = ["diagnostics"] as const;

/** How often the open page runs doctor again on every machine (ms). */
export const RECHECK_MS = 60_000;

/** A machine as the page shows it: its report, or `checking` while it is asked. */
export type MachineRow = MachineDiagnostics & { checking: boolean };

const shown = () => {
	const r = route.value;
	return (
		r.view === "page" &&
		r.name === "diagnostics" &&
		document.visibilityState === "visible"
	);
};

/**
 * The pool at once (`GET /diagnostics`), then each machine's report asked
 * in parallel (`GET /diagnostics/:id`), each shown as it arrives. Version
 * skew is worked out again as reports come in. Live while the page shows:
 * every machine runs doctor again each minute, when the tab comes back, and
 * when a machine joins, leaves or changes version (`machines` notices).
 * Reports stay on screen while the next ones load.
 */
export function useDiagnostics() {
	// The first read reuses a recent report; later ones ask for a fresh run
	// (the daemon throttles fresh runs and caches failures briefly).
	const fresh = useRef(false);
	const [startedAt, setStartedAt] = useState(() => Date.now());
	const list = useQuery(
		{
			queryKey: [...diagnosticsKey, "list"],
			queryFn: () => api.diagnostics(),
			staleTime: 15_000,
			retry: 1,
		},
		queryClient,
	);
	const pending = list.data?.machines.filter((m) => m.pending) ?? [];
	const answers = useQueries(
		{
			queries: pending.map((m) => ({
				queryKey: [...diagnosticsKey, "machine", m.machineId],
				queryFn: () => api.machineDiagnostics(m.machineId, fresh.current),
				staleTime: 15_000,
				retry: false,
			})),
		},
		queryClient,
	);
	const recheck = () => {
		if (!shown()) return;
		fresh.current = true;
		setStartedAt(Date.now());
		void queryClient.invalidateQueries({ queryKey: diagnosticsKey });
	};
	const recheckRef = useRef(recheck);
	recheckRef.current = recheck;
	const lastRun = useRef(startedAt);
	lastRun.current = startedAt;
	useEffect(() => {
		const t = setInterval(() => recheckRef.current(), RECHECK_MS);
		const onVisible = () => {
			if (Date.now() - lastRun.current >= RECHECK_MS) recheckRef.current();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(t);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, []);
	useLiveEvent("machines", () => recheckRef.current());
	const byId = new Map(pending.map((m, i) => [m.machineId, answers[i]!]));
	const merged: MachineRow[] = (list.data?.machines ?? []).map((m) => {
		const a = byId.get(m.machineId);
		if (!a) return { ...m, checking: false };
		// The last check failed (a recheck too): say why, not an old report.
		if (a.isError)
			return {
				...m,
				pending: false,
				checking: false,
				error:
					a.error instanceof ApiError
						? `Couldn't check: ${a.error.message}`
						: "Couldn't check this machine.",
			};
		// A recheck keeps the last report on screen.
		if (a.data) return { ...a.data, checking: false };
		return { ...m, checking: true };
	});
	const { newest, upgrade } = versionSkew(merged);
	const machines = merged.map((m) => ({
		...m,
		upgrade: upgrade.get(m.name) ?? null,
	}));
	const checking =
		list.isFetching ||
		machines.some((m) => m.checking) ||
		answers.some((a) => a.isFetching);
	return {
		list,
		machines,
		newest,
		/** Doctor runs somewhere now (first load or a recheck). */
		checking,
		startedAt,
	};
}

export type Diagnostics = ReturnType<typeof useDiagnostics>;

/** Doctor's groups in the order the page shows them. */
const GROUPS = ["daemon", "harnesses", "approvals", "remote access", "mesh"];
export const GROUP_LABEL: Record<string, string> = {
	daemon: "Daemon",
	harnesses: "Harnesses",
	approvals: "Approvals",
	"remote access": "Remote access",
	mesh: "Agent mesh",
};

/** Checks by group, known groups first, each in doctor's order. */
export function grouped(checks: DiagCheck[]): [string, DiagCheck[]][] {
	const by = new Map<string, DiagCheck[]>();
	for (const c of checks) by.set(c.group, [...(by.get(c.group) ?? []), c]);
	const rank = (g: string) => {
		const i = GROUPS.indexOf(g);
		return i < 0 ? GROUPS.length : i;
	};
	return [...by].sort((a, b) => rank(a[0]) - rank(b[0]));
}

const RANK: Record<DiagLevel, number> = { bad: 0, note: 1, ok: 2 };

/** The checks to act on: problems, then notes, each in doctor's order. */
export function attention(checks: DiagCheck[]): DiagCheck[] {
	return checks
		.filter((c) => c.level !== "ok")
		.sort((a, b) => RANK[a.level] - RANK[b.level]);
}

/** The checks that passed, in doctor's order. */
export function passed(checks: DiagCheck[]): DiagCheck[] {
	return checks.filter((c) => c.level === "ok");
}

export type Health = "problems" | "notes" | "ok" | "unknown" | "checking";

/** A machine's overall state and its short summary. */
export function health(m: MachineRow): { tone: Health; label: string } {
	if (m.checking) return { tone: "checking", label: "Checking…" };
	if (!m.report) return { tone: "unknown", label: "No report" };
	const bad = m.report.checks.filter((c) => c.level === "bad").length;
	const notes = m.report.checks.filter((c) => c.level === "note").length;
	if (bad)
		return { tone: "problems", label: `${bad} problem${bad === 1 ? "" : "s"}` };
	if (notes)
		return { tone: "notes", label: `${notes} note${notes === 1 ? "" : "s"}` };
	return { tone: "ok", label: "All checks passed" };
}

/** "3d 4h", "2h 5m", "40m", "12s". */
export function uptime(s: number): string {
	const d = Math.floor(s / 86_400);
	const h = Math.floor((s % 86_400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d) return `${d}d ${h}h`;
	if (h) return `${h}h ${m}m`;
	if (m) return `${m}m`;
	return `${Math.floor(s)}s`;
}

/** "Expires in 60 days", "Expires today", "Expired 2 days ago". */
export function certLabel(days: number): string {
	if (days < 0) return `Expired ${-days} day${days === -1 ? "" : "s"} ago`;
	if (days === 0) return "Expires today";
	return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}

export const TAILSCALE_LABEL: Record<string, string> = {
	running: "Running",
	stopped: "Stopped",
	"logged-out": "Logged out",
	"needs-approval": "Needs approval",
	"not-running": "Not running",
	missing: "Not installed",
};

/** Doctor's text with `commands` as code spans. */
export function spans(text: string): { code: boolean; text: string }[] {
	return text
		.split(/(`[^`]+`)/)
		.filter(Boolean)
		.map((t) =>
			t.length > 2 && t.startsWith("`") && t.endsWith("`")
				? { code: true, text: t.slice(1, -1) }
				: { code: false, text: t },
		);
}

/**
 * A fix as text and code spans; `command` marks a code span the operator
 * runs ("run `pulsar mesh on`"), which the page offers to copy. Other code
 * spans ("a `client load error` line") stay plain code.
 */
export function fixParts(
	fix: string,
): { code: boolean; command: boolean; text: string }[] {
	const parts = spans(fix);
	return parts.map((p, i) => ({
		...p,
		command: p.code && i > 0 && /\b(?:re-?)?run\s*$/i.test(parts[i - 1]!.text),
	}));
}
