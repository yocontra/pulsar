import { DaemonClient } from "../client.ts";
import { PROTOCOL_VERSION } from "../types.ts";
import { VERSION } from "../version.ts";

/** What doctor and setup say when this machine's prompts can't be approved from the app yet. */
export const NO_LOCAL_PASSKEY =
	"approvals on this machine need a passkey here: open Prove Human in this machine's app (or run `pulsar mesh on --prove`); until then its prompts stay in the terminal";

/**
 * How many passkeys this machine's daemon has, or null when that can't be
 * told (no daemon running, or asked from inside an agent, which may not list
 * passkeys). Only this machine's own passkeys approve its prompts.
 */
export async function localPasskeyCount(): Promise<number | null> {
	const client = new DaemonClient();
	try {
		await client.connect(false);
		await client.call("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
			registration: { role: "cli" },
		});
		const r = await client.call<{ passkeys: unknown[] }>("passkeys.list");
		return r.passkeys.length;
	} catch {
		return null;
	} finally {
		client.close();
	}
}
