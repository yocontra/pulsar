import type { DaemonClient } from "./client.ts";
import { callConfirmed } from "./presence/cli.ts";
import type { PoolMemberRow } from "./store.ts";

const USAGE =
	"usage: pulsar mesh list | pulsar mesh allow|deny|forget <node> | pulsar mesh owner <login>";

/**
 * `pulsar mesh list|allow|deny|forget|owner …`: shows or changes who may be in the pool. Anyone may run a
 * change, agents too; the daemon asks the person to confirm it (Touch ID on
 * this Mac, or a passkey in the app) and applies it only then.
 */
export async function poolCommand(
	client: DaemonClient,
	args: string[],
): Promise<number> {
	const [verb = "list", target] = args;
	if (verb === "list") {
		const r = await client.call<{
			owner: string | null;
			entries: PoolMemberRow[];
			peers: { machineId: string; name: string; node: string | null }[];
		}>("pool.list", {});
		const allow = r.entries.filter((e) => e.verdict === "allow");
		const deny = r.entries.filter((e) => e.verdict === "deny");
		const line = (e: PoolMemberRow) => `${e.name} (node ${e.nodeId})`;
		console.log(`allowed nodes: ${allow.map(line).join(", ") || "(none)"}`);
		console.log(`denied nodes: ${deny.map(line).join(", ") || "(none)"}`);
		if (r.owner) console.log(`pool owner (this tagged node): ${r.owner}`);
		console.log(
			`linked machines: ${r.peers.map((p) => `${p.name} (${p.machineId.slice(0, 8)})`).join(", ") || "(none)"}`,
		);
		console.log("Nodes owned by your Tailscale user join automatically.");
		return 0;
	}
	if (!["allow", "deny", "forget", "owner"].includes(verb) || !target) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	const r = await callConfirmed<{ change: string; method: string }>(
		client,
		"pool.change",
		{ verb, target },
	);
	console.log(`Done: ${r.change} (confirmed with ${r.method}).`);
	return 0;
}
