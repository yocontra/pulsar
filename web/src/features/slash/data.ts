/**
 * The `/` menu's list and an agent's modes, read from the daemon
 * (`GET /agents/:id/commands`, `/modes`) and kept briefly; switching a mode
 * (an acting op: Prove Human first).
 */
import { ApiError, api, ProveCancelled } from "../../api/client.ts";
import type {
	AgentModes,
	AgentRow,
	CommandCatalog,
	ControlResult,
} from "../../api/types.ts";
import { showToast } from "../../lib/store.ts";

const CATALOG_MS = 30_000;
const MODES_MS = 4_000;

const catalogs = new Map<
	string,
	{ at: number; capabilities: string; p: Promise<CommandCatalog> }
>();
const modes = new Map<string, { at: number; p: Promise<AgentModes> }>();

export function catalogFor(
	agentId: string,
	capabilities: string,
): Promise<CommandCatalog> {
	const hit = catalogs.get(agentId);
	if (hit?.capabilities === capabilities && Date.now() - hit.at < CATALOG_MS)
		return hit.p;
	const p = api.commands(agentId);
	catalogs.set(agentId, { at: Date.now(), capabilities, p });
	const forget = () => {
		if (catalogs.get(agentId)?.p === p) catalogs.delete(agentId);
	};
	// A starting or reconnecting harness may advertise its commands later.
	void p.then((c) => {
		if (!c.runnable || !c.commands.length) forget();
	}, forget);
	return p;
}

export function modesFor(agentId: string, fresh = false): Promise<AgentModes> {
	const hit = modes.get(agentId);
	if (!fresh && hit && Date.now() - hit.at < MODES_MS) return hit.p;
	const p = api.modes(agentId);
	modes.set(agentId, { at: Date.now(), p });
	p.catch(() => modes.delete(agentId));
	return p;
}

// ---- recent commands (this device only) ----

const RECENT_KEY = "pulsar.slash.recent";
const RECENT_MAX = 8;

export function recentFor(harness: string): string[] {
	try {
		const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}") as Record<
			string,
			string[]
		>;
		return Array.isArray(all[harness]) ? all[harness].slice(0, RECENT_MAX) : [];
	} catch {
		return [];
	}
}

export function noteRecent(harness: string, name: string) {
	try {
		const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}") as Record<
			string,
			string[]
		>;
		const list = [name, ...(all[harness] ?? []).filter((n) => n !== name)];
		all[harness] = list.slice(0, RECENT_MAX);
		localStorage.setItem(RECENT_KEY, JSON.stringify(all));
	} catch {}
}

// ---- running and switching ----

/** What a control result says, for a toast. */
export function outcomeText(r: ControlResult, what: string): string {
	if (r.result === "ok") return what;
	return `${r.detail ?? r.result}`;
}

/** Switches the agent's mode; a toast says what happened. */
export async function switchMode(
	agent: AgentRow,
	mode: string,
	label: string,
): Promise<ControlResult | null> {
	try {
		const r = await api.setMode(agent.id, mode);
		modes.delete(agent.id);
		showToast(
			r.result === "ok"
				? `${agent.name} is in ${label} mode${r.detail ? ` (${r.detail})` : ""}`
				: `Couldn't switch ${agent.name} to ${label}: ${r.detail ?? r.result}`,
			r.result === "ok" ? "ok" : "warn",
		);
		return r;
	} catch (e) {
		if (e instanceof ProveCancelled) return null;
		showToast(
			`Couldn't switch ${agent.name}'s mode: ${e instanceof ApiError ? e.message : (e as Error).message}`,
			"warn",
		);
		return null;
	}
}

/** The phone's mode picker: an action sheet of the agent's modes. */
export async function chooseMode(agent: AgentRow) {
	let m: AgentModes;
	try {
		m = await modesFor(agent.id, true);
	} catch (e) {
		showToast(
			`Couldn't read ${agent.name}'s mode: ${(e as Error).message}`,
			"warn",
		);
		return;
	}
	if (!m.modes.length) {
		showToast(m.reason ?? "This agent has no modes", "warn");
		return;
	}
	const { showActions } = await import("../../mobile/ui/actions.ts");
	await showActions({
		header: "Mode",
		subHeader: m.canSwitch
			? [
					m.current
						? `Now: ${m.modes.find((x) => x.id === m.current)?.label ?? m.current}${m.live ? "" : " (last seen)"}`
						: null,
					m.note,
				]
					.filter(Boolean)
					.join(" · ")
			: m.reason,
		buttons: [
			...m.modes.map((x) => ({
				text: x.id === m.current ? `${x.label} ✓` : x.label,
				disabled: !m.canSwitch || x.id === m.current,
				handler: () => void switchMode(agent, x.id, x.label),
			})),
			{ text: "Cancel", role: "cancel" as const },
		],
	});
}
