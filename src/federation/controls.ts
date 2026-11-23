import type { AgentModes, CommandCatalog } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Principal } from "../service/caller.ts";
import type { RemoteControls } from "../service/controls.ts";
import type { Federation } from "./index.ts";

/** A home node too old for `controls.read`. */
const OLD_NODE = new Set(["unsupported", "bad_request"]);

/**
 * Modes and the `/` menu of agents on other machines, read by their home
 * node (`controls.read`). Switching a mode and running a command are
 * acting ops: they travel as `acting.run`, and the home node checks the
 * operator's passkey itself.
 */
export class RemoteControlsRelay implements RemoteControls {
	private readonly fed: Federation;

	constructor(fed: Federation) {
		this.fed = fed;
	}

	async modes(address: string, as?: Principal): Promise<AgentModes> {
		const r = await this.read(address, "modes", as);
		const m = (r?.modes ?? null) as AgentModes | null;
		if (!m || !Array.isArray(m.modes))
			return {
				agentId: address,
				modes: [],
				current: null,
				live: false,
				canSwitch: false,
				reason: "Its machine runs an older Pulsar without modes.",
			};
		return { ...m, agentId: address };
	}

	async commands(address: string, as?: Principal): Promise<CommandCatalog> {
		const r = await this.read(address, "commands", as);
		const c = (r?.commands ?? null) as CommandCatalog | null;
		if (!c || !Array.isArray(c.commands))
			return {
				agentId: address,
				harness: "",
				commands: [],
				runnable: false,
				reason: "Its machine runs an older Pulsar without slash commands.",
			};
		return { ...c, agentId: address };
	}

	private async read(
		address: string,
		what: "modes" | "commands",
		as?: Principal,
	): Promise<Record<string, unknown> | null> {
		const slash = address.indexOf("/");
		if (slash <= 0) throw new RpcError("not_found", `no agent ${address}`);
		try {
			return await this.fed.act(
				address,
				{ op: "controls.read", agent: address.slice(slash + 1), what },
				as,
			);
		} catch (e) {
			if (e instanceof RpcError && OLD_NODE.has(e.code)) return null;
			throw e;
		}
	}
}
