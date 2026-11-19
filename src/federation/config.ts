import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../paths.ts";

/**
 * `pool.json` in the state folder: a display copy of the pool settings
 * (names only) that the daemon writes after each `pulsar mesh` change, for
 * `pulsar doctor` and setup. The daemon never reads it back: membership lives
 * in its store (`PoolMembers`), keyed by Tailscale node id.
 */
export interface PoolConfig {
	allow: string[];
	deny: string[];
	owner?: string | null;
}

export function poolConfigPath() {
	return join(stateDir(), "pool.json");
}

function names(v: unknown): string[] {
	return Array.isArray(v)
		? [
				...new Set(
					v
						.filter((x): x is string => typeof x === "string")
						.map((x) => x.trim().toLowerCase())
						.filter(Boolean),
				),
			]
		: [];
}

/** Reads the display copy; empty when there is none. */
export function readPoolConfig(path = poolConfigPath()): PoolConfig {
	try {
		// sync-ok: CLI only (doctor, mesh checks); the daemon never reads it back
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			unknown
		>;
		const owner =
			typeof raw.owner === "string" && raw.owner.includes("@")
				? raw.owner.trim()
				: null;
		return {
			allow: names(raw.allow),
			deny: names(raw.deny),
			...(owner ? { owner } : {}),
		};
	} catch {
		return { allow: [], deny: [] };
	}
}
