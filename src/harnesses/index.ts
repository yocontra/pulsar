import { withAntigravityWake } from "../setup/antigravity.ts";
import type { Agent } from "../types.ts";
import { antigravity } from "./antigravity.ts";
import { HARNESSES } from "./catalog.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { identFor } from "./ident.ts";
import { mcpSetup } from "./mcp-config.ts";
import { omp } from "./omp.ts";
import { opencode } from "./opencode.ts";
import { pi } from "./pi.ts";
import type { HarnessDriver } from "./types.ts";

export {
	extensionHostFor,
	findHarnessAncestor,
	harnessIds,
	PSEUDO_HARNESSES,
} from "./ident.ts";
export type { HarnessDriver } from "./types.ts";

const native = [claude, codex, opencode, pi, omp, antigravity];
export const DRIVERS: HarnessDriver[] = HARNESSES.map((h) => ({
	...identFor(h.id)!,
	...native.find((d) => d.id === h.id),
	...("mcp" in h
		? {
				setup:
					h.id === "antigravity"
						? withAntigravityWake(mcpSetup(h, h.mcp))
						: mcpSetup(h, h.mcp),
			}
		: {}),
}));

export function driverFor(id: string): HarnessDriver | null {
	return DRIVERS.find((d) => d.id === id) ?? null;
}

/** Managed sessions use their negotiated ACP connection for control. */
export function attachedDriver(
	agent: Pick<Agent, "harness" | "meta">,
): HarnessDriver | null {
	return agent.meta.acp === "1" ? null : driverFor(agent.harness);
}

/** The driver whose process a command line is, if any. */
export function driverForProcess(args: string): HarnessDriver | null {
	return DRIVERS.find((d) => d.matchProcess(args)) ?? null;
}

/** The push path that reaches an agent from outside its session, if any. */
export function pushFor(agent: Agent): HarnessDriver["push"] | null {
	const push = attachedDriver(agent)?.push;
	return push?.canPush(agent) ? push : null;
}

/** Drivers `pulsar setup` and `doctor` can configure, in registry order. */
export const CLIENTS = DRIVERS.flatMap((d) =>
	d.setup
		? [
				{
					id: d.id,
					label: d.label,
					bin: HARNESSES.find((h) => h.id === d.id)!.bin,
					...d.setup,
				},
			]
		: [],
);
