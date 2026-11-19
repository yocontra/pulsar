import type { DaemonClient } from "./client.ts";
import { callConfirmed } from "./presence/cli.ts";

interface PasskeyRow {
	id: string;
	label: string;
	createdAt: number;
	lastUsedAt: number | null;
}

/**
 * `pulsar passkeys`: the passkeys on this machine. They are made in the app
 * (Prove Human), or at the end of `pulsar mesh on`.
 */
export async function passkeysCommand(
	client: DaemonClient,
	args: string[],
): Promise<number> {
	const [sub = "list", id] = args;
	if (sub === "list") {
		const r = await client.call<{ passkeys: PasskeyRow[] }>("passkeys.list");
		if (r.passkeys.length === 0) {
			console.log(
				"No passkeys yet. Open Prove Human in the app on any device signed in to your tailnet, or run `pulsar mesh on --prove`.",
			);
			return 0;
		}
		for (const p of r.passkeys)
			console.log(
				`${p.id}  ${p.label}  added ${new Date(p.createdAt).toLocaleString()}${p.lastUsedAt ? `, last used ${new Date(p.lastUsedAt).toLocaleString()}` : ""}`,
			);
		return 0;
	}
	if (sub === "remove") {
		if (!id) {
			process.stderr.write("usage: pulsar passkeys remove <id>\n");
			return 2;
		}
		// The daemon asks the person (Touch ID or the app) before it removes it.
		const r = await callConfirmed<{ removed: boolean }>(
			client,
			"passkeys.remove",
			{ id },
		);
		console.log(r.removed ? `Removed passkey ${id}.` : `No passkey ${id}.`);
		return r.removed ? 0 : 1;
	}
	process.stderr.write(
		"usage: pulsar passkeys [list] | pulsar passkeys remove <id>\n",
	);
	return 1;
}
