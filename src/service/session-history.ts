import { basename } from "node:path";
import { driverFor } from "../harnesses/index.ts";
import type { SavedSessionHit } from "../http/wire.ts";
import type { Store } from "../store.ts";
import { type Agent, isFolderGuess } from "../types.ts";
import { splitAddress } from "./pool.ts";

type Binding = Pick<
	Agent,
	| "name"
	| "harness"
	| "sessionId"
	| "cwd"
	| "project"
	| "branch"
	| "model"
	| "createdAt"
	| "lastSeen"
	| "meta"
>;

/** A pi-style process can host several conversations over its lifetime. */
export function archiveAddress(agent: Agent): string | null {
	if (agent.sessionId && !agent.sessionId.startsWith("pid:")) return agent.id;
	const key = agent.meta.resumeKey;
	if (
		!driverFor(agent.harness)?.extension ||
		!key?.startsWith(`${agent.harness}:`)
	)
		return null;
	const sessionId = key.slice(agent.harness.length + 1);
	if (!/^[a-zA-Z0-9_-]{1,190}$/.test(sessionId)) return null;
	return key;
}

/** Transcript references for links opened on this machine. Never used for delivery. */
export class SessionHistory {
	constructor(store: Store, machine: string) {
		this.store = store;
		this.machine = machine;
	}
	private readonly store: Store;
	private readonly machine: string;

	private localId(id: string) {
		const address = splitAddress(id);
		return address && address.machineId === this.store.machineId()
			? address.localId
			: id;
	}

	remember(agent: Agent) {
		const id = archiveAddress(agent);
		if (
			!id ||
			agent.id.includes("/") ||
			agent.meta.machineId ||
			agent.meta.subagentOf ||
			isFolderGuess(agent) ||
			(!driverFor(agent.harness)?.transcript && agent.meta.acp !== "1")
		)
			return;
		this.save(id, {
			name: agent.name,
			harness: agent.harness,
			sessionId:
				id === agent.id ? agent.sessionId : id.slice(agent.harness.length + 1),
			cwd: agent.cwd,
			project: agent.project,
			branch: agent.branch,
			model: agent.model,
			createdAt: agent.createdAt,
			lastSeen: agent.lastSeen,
			meta: {
				...(agent.meta.acp === "1"
					? {
							acp: "1",
							acpResume: agent.meta.acpResume === "1" ? "1" : "0",
							...(agent.meta.acpTitle ? { acpTitle: agent.meta.acpTitle } : {}),
						}
					: {}),
				...(agent.meta.resumeKey ? { resumeKey: agent.meta.resumeKey } : {}),
			},
		});
	}

	private save(id: string, binding: Binding, recovered = false) {
		this.store.db
			.prepare(`INSERT INTO session_history (id,binding) VALUES (?,?)
			ON CONFLICT(id) DO UPDATE SET binding=excluded.binding WHERE ? = 0 AND binding != excluded.binding`)
			.run(id, JSON.stringify(binding), Number(recovered));
	}

	search(query: string, liveIds: string[]): SavedSessionHit[] {
		const rows = this.store.db
			.prepare(`
			SELECT id, json_extract(binding,'$.name') AS name,
				json_extract(binding,'$.harness') AS harness,
				json_extract(binding,'$.project') AS project,
				json_extract(binding,'$.lastSeen') AS lastSeen
			FROM session_history
			WHERE id NOT IN (SELECT value FROM json_each(?))
				AND instr(lower(name || ' ' || coalesce(project,'') || ' ' || coalesce(json_extract(binding,'$.meta.acpTitle'),'') || ' ' || id), lower(?)) > 0
			ORDER BY lastSeen DESC, id LIMIT 30
		`)
			.all(JSON.stringify(liveIds), query.trim());
		return rows as unknown as SavedSessionHit[];
	}

	get(id: string): Agent | undefined {
		const key = this.localId(id);
		if (key.includes("/")) return;
		const row = this.store.db
			.prepare("SELECT binding FROM session_history WHERE id=?")
			.get(key);
		if (!row) return;
		return {
			...JSON.parse(String(row.binding)),
			id: key,
			machine: this.machine,
			tags: [],
			pid: null,
			status: "gone",
			activity: null,
			registered: false,
			reach: "pull",
			inbound: "refuse",
		};
	}

	async resolve(id: string): Promise<Agent | undefined> {
		const known = this.get(id);
		if (known) return known;
		await this.recover(id);
		return this.get(id);
	}

	/** Import a pre-existing native conversation only if the driver verifies its exact ID. */
	async recover(id: string) {
		const key = this.localId(id);
		if (key.includes("/") || key.length > 512) return;
		const colon = key.indexOf(":");
		if (colon < 1) return;
		const harness = key.slice(0, colon);
		const sessionId = key.slice(colon + 1).replaceAll("%2F", "/");
		const native = await driverFor(harness)?.readSession?.(sessionId);
		if (!native) return;
		const project = native.cwd ? basename(native.cwd) : null;
		this.save(
			key,
			{
				harness,
				sessionId,
				name: native.name || (project ? `${harness}@${project}` : harness),
				cwd: native.cwd,
				project,
				branch: null,
				model: null,
				lastSeen: native.lastSeen,
				createdAt: native.lastSeen,
				meta: {},
			},
			true,
		);
	}
}
