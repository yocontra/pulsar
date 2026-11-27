import { homedir } from "node:os";
import { join } from "node:path";

/** The agent settings and session root chosen by a pi-family CLI. */
export function piAgentDir(harness: "pi" | "omp", home = homedir()) {
	if (harness === "pi")
		return process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
	const root = join(home, process.env.PI_CONFIG_DIR || ".omp");
	const profile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim();
	if (profile && profile !== "default") {
		if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile.endsWith("."))
			throw new Error("Invalid OMP profile name");
		return join(root, "profiles", profile, "agent");
	}
	return process.env.PI_CODING_AGENT_DIR || join(root, "agent");
}
