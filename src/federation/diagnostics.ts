import { cleanLocalDiagnostics, redact } from "../diagnostics/checks.ts";
import type { LocalDiagnostics } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Principal } from "../service/caller.ts";
import type { Federation } from "./index.ts";
import { clean } from "./protocol.ts";

/** A peer runs `pulsar doctor --json` itself (up to 30 s), plus the trip. */
export const DIAG_TIMEOUT_MS = 35_000;

/** A peer as Diagnostics lists it, before asking it anything. */
export interface RemoteDiagnosticsPeer {
	machineId: string;
	name: string;
	/** Its Pulsar version from its last hello, when it said. */
	helloVersion: string | null;
	/** Why it can't be asked now (asleep, offline); null when linked. */
	away: string | null;
}

/** A peer's answer; `error` when it did not answer. */
export interface RemoteDiagnosticsRow extends RemoteDiagnosticsPeer {
	report: LocalDiagnostics | null;
	error: string | null;
}

export interface PoolDiagnostics {
	/** Every peer, now (no request). */
	peers(): RemoteDiagnosticsPeer[];
	/** One peer's report (by id or name), asked now; null for a machine not in the pool. */
	one(
		machineId: string,
		fresh: boolean,
		as?: Principal,
	): Promise<RemoteDiagnosticsRow | null>;
}

/**
 * Diagnostics of other machines: each peer's daemon runs its own checks
 * (`act: diag.read`, as the original user) and redacts them before they
 * leave; this node checks and bounds what comes back. A machine that is
 * offline, slow or too old is reported with why.
 */
export class RemoteDiagnostics implements PoolDiagnostics {
	private readonly fed: Federation;

	constructor(fed: Federation) {
		this.fed = fed;
	}

	peers(): RemoteDiagnosticsPeer[] {
		return this.fed.machines().map((m) => {
			const hello = this.fed.state.peers.get(m.machineId)?.hello;
			return {
				machineId: m.machineId,
				name: m.name,
				helloVersion:
					typeof hello?.pulsarVersion === "string"
						? hello.pulsarVersion.slice(0, 40)
						: null,
				away:
					m.link === "tailnet" ? null : (m.reason ?? `${m.name} is offline`),
			};
		});
	}

	async one(
		machineId: string,
		fresh: boolean,
		as?: Principal,
	): Promise<RemoteDiagnosticsRow | null> {
		// By id, else by name (the CLI and people use names).
		const peers = this.peers();
		const peer =
			peers.find((p) => p.machineId === machineId) ??
			peers.find((p) => p.name === machineId);
		if (!peer) return null;
		if (peer.away) return { ...peer, report: null, error: peer.away };
		try {
			const r = await this.fed.act(
				`${peer.machineId}/`,
				{ op: "diag.read", fresh },
				as,
				DIAG_TIMEOUT_MS,
			);
			const report = cleanLocalDiagnostics(r.report);
			if (!report) throw new Error("sent no report");
			return { ...peer, report, error: null };
		} catch (e) {
			const msg = (e as Error).message;
			return {
				...peer,
				report: null,
				error:
					// An older node refuses the op it does not know.
					e instanceof RpcError && e.code === "unsupported"
						? `upgrade pulsar on ${peer.name} to see its checks`
						: /abort|time(d)? ?out/i.test(msg)
							? `${peer.name} did not answer within ${DIAG_TIMEOUT_MS / 1000} s`
							: // The peer redacted it; checked again here as data.
								redact(clean(msg, 300), ""),
			};
		}
	}
}
