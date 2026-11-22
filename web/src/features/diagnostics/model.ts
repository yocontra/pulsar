/** Diagnostics data: the queries, and what the page says about a machine. */
import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { versionSkew } from "../../../../src/diagnostics/checks.ts";
import { ApiError, api } from "../../api/client.ts";
import type { DiagCheck, MachineDiagnostics } from "../../api/types.ts";
import { queryClient } from "../../data/hooks.ts";

export const diagnosticsKey = ["diagnostics"] as const;

/** A machine as the page shows it: its report, or `checking` while it is asked. */
export type MachineRow = MachineDiagnostics & { checking: boolean };

/**
 * The pool at once (`GET /diagnostics`), then each machine's report asked
 * in parallel (`GET /diagnostics/:id`), each shown as it arrives. Version
 * skew is worked out again as reports come in. `refresh` asks every
 * machine to run doctor again now.
 */
export function useDiagnostics() {
	const [round, setRound] = useState(0);
	const [startedAt, setStartedAt] = useState(() => Date.now());
	const list = useQuery(
		{
			queryKey: [...diagnosticsKey, "list", round],
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
				queryKey: [...diagnosticsKey, "machine", m.machineId, round],
				queryFn: () => api.machineDiagnostics(m.machineId, round > 0),
				staleTime: 15_000,
				retry: false,
			})),
		},
		queryClient,
	);
	const byId = new Map(pending.map((m, i) => [m.machineId, answers[i]!]));
	const merged: MachineRow[] = (list.data?.machines ?? []).map((m) => {
		const a = byId.get(m.machineId);
		if (!a) return { ...m, checking: false };
		if (a.data) return { ...a.data, checking: false };
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
		return { ...m, checking: true };
	});
	const { newest, upgrade } = versionSkew(merged);
	const machines = merged.map((m) => ({
		...m,
		upgrade: upgrade.get(m.name) ?? null,
	}));
	const checking = list.isFetching || machines.some((m) => m.checking);
	return {
		list,
		machines,
		newest,
		checking,
		startedAt,
		refresh: () => {
			setStartedAt(Date.now());
			setRound((r) => r + 1);
		},
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
