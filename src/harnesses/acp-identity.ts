import { readFile } from "node:fs/promises";
import { pidAlive } from "../processes.ts";
import type { Registration } from "../types.ts";

export const ACP_IDENTITY_ENV = "PULSAR_ACP_IDENTITY";

/** The bridge publishes this only after it owns the real session in the daemon. */
export async function acpRegistration(
	role: Registration["role"],
): Promise<Registration | null> {
	const path = process.env[ACP_IDENTITY_ENV];
	if (!path) return null;
	const registration = JSON.parse(await readFile(path, "utf8")) as Registration;
	if (
		registration.meta?.acp !== "1" ||
		!registration.pid ||
		!registration.sessionId ||
		!pidAlive(registration.pid)
	)
		throw new Error("The managed ACP session is unavailable");
	// A later MCP connection must preserve the bridge’s current model and name.
	const { name: _name, model: _model, ...identity } = registration;
	return { ...identity, role, meta: { acp: "1" } };
}
