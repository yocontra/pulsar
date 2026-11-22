import type { PoolDiagnostics } from "../federation/diagnostics.ts";
import type { DiagnosticsReport, MachineDiagnostics } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Principal } from "../service/caller.ts";
import { VERSION } from "../version.ts";
import { versionSkew } from "./checks.ts";
import type { LocalDiagnosticsRunner } from "./local.ts";

/*
 * `GET /diagnostics` lists the pool at once (no doctor runs); the app then
 * asks each machine with `GET /diagnostics/:machineId`, in parallel, and
 * shows each report as it arrives. Each report is made by that machine's
 * own daemon. A machine that is away keeps the version from its last
 * hello, so an old one is still flagged for upgrade.
 */

type Self = { id: string; name: string };

/** Every machine's version as this node knows it now: this one's and each peer's hello. */
function known(self: Self, pool: PoolDiagnostics | null) {
	return [
		{ name: self.name, version: VERSION as string | null },
		...(pool?.peers() ?? []).map((p) => ({
			name: p.name,
			version: p.helloVersion,
		})),
	];
}

export function diagnosticsList(
	self: Self,
	pool: PoolDiagnostics | null,
): DiagnosticsReport {
	const { newest, upgrade } = versionSkew(known(self, pool));
	const peers = pool?.peers() ?? [];
	return {
		newest,
		machines: [
			{
				machineId: self.id,
				name: self.name,
				self: true,
				version: VERSION,
				report: null,
				error: null,
				upgrade: upgrade.get(self.name) ?? null,
				pending: true,
			},
			...peers.map((p) => ({
				machineId: p.machineId,
				name: p.name,
				self: false,
				version: p.helloVersion,
				report: null,
				error: p.away,
				upgrade: upgrade.get(p.name) ?? null,
				pending: p.away === null,
			})),
		],
	};
}

export async function machineDiagnostics(
	self: Self,
	local: LocalDiagnosticsRunner,
	pool: PoolDiagnostics | null,
	machineId: string,
	as: Principal,
	fresh: boolean,
): Promise<MachineDiagnostics> {
	let row: Omit<MachineDiagnostics, "upgrade" | "pending">;
	if (machineId === self.id) {
		const r = await local.read(fresh).then(
			(report) => ({ report, error: null }),
			(e: Error) => ({ report: null, error: e.message.slice(0, 300) }),
		);
		row = {
			machineId: self.id,
			name: self.name,
			self: true,
			version: VERSION,
			...r,
		};
	} else {
		const p = await pool?.one(machineId, fresh, as);
		if (!p) throw new RpcError("not_found", "no such machine in the pool");
		row = {
			machineId: p.machineId,
			name: p.name,
			self: false,
			version: p.report?.version ?? p.helloVersion,
			report: p.report,
			error: p.error,
		};
	}
	const versions = known(self, pool).map((k) =>
		k.name === row.name ? { name: k.name, version: row.version } : k,
	);
	return {
		...row,
		upgrade: versionSkew(versions).upgrade.get(row.name) ?? null,
		pending: false,
	};
}
