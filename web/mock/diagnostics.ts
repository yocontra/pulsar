/**
 * Mock Diagnostics (`GET /diagnostics`, then `GET /diagnostics/:id` per
 * machine): the named machines of the mock pool, each with a doctor report
 * as its daemon would send it (redacted): studio (this machine) healthy,
 * mbp-a one version behind with problems, mbp-b asleep, desk too old to
 * answer. `POST /__mock/diagnostics` holds a machine's answer back for a
 * while, or makes it time out.
 */
import type {
	DiagCheck,
	DiagnosticsReport,
	LocalDiagnostics,
	MachineDiagnostics,
} from "../../src/http/wire.ts";

const ok = (group: string, text: string): DiagCheck => ({
	group,
	level: "ok",
	text,
	fix: null,
});

function report(
	version: string,
	checks: DiagCheck[],
	o: Partial<LocalDiagnostics> = {},
): LocalDiagnostics {
	return {
		version,
		platform: "darwin",
		uptimeS: 3 * 86_400 + 4 * 3600,
		agents: 6,
		eventLoop: { p99: 12, max: 48, stalls: 0 },
		checks,
		facts: {
			tailscale: {
				state: "running",
				version: "1.104.7",
				dnsName: "studio.tail1234.ts.net",
				magicDns: true,
			},
			certDays: 71,
			harnesses: [
				{
					id: "claude",
					label: "Claude Code",
					version: "2.1.328",
					configured: true,
				},
				{ id: "codex", label: "Codex", version: "0.169.0", configured: true },
			],
		},
		checkedAt: Date.now() - 20_000,
		...o,
	};
}

function full(): DiagnosticsReport {
	return {
		newest: "2.1.0",
		machines: [
			{
				machineId: "studio",
				name: "studio",
				self: true,
				version: "2.1.0",
				error: null,
				upgrade: null,
				pending: false,
				report: report("2.1.0", [
					ok("daemon", "daemon 2.1.0 running (pid 4211), 6 live agent(s)"),
					ok("daemon", "event loop: p99 12 ms, max 48 ms"),
					ok("harnesses", "Claude Code: configured"),
					ok("harnesses", "Codex: configured"),
					ok(
						"approvals",
						"Claude Code approvals: permission prompts relay to the app",
					),
					ok(
						"remote access",
						"remote access: https://studio.tail1234.ts.net:7337/ for me@example.com",
					),
					ok("mesh", "MagicDNS on"),
					ok("mesh", "node certificate valid for 71 days"),
					ok("mesh", "background service running (pid 4211)"),
					ok("mesh", "mbp-a (macOS): Pulsar 2.0.3"),
					{
						group: "mesh",
						level: "note",
						text: "mbp-b (macOS): asleep 14m",
						fix: null,
					},
				]),
			},
			{
				machineId: "mbp-a",
				name: "mbp-a",
				self: false,
				version: "2.0.3",
				error: null,
				upgrade: "upgrade pulsar on mbp-a (2.0.3; newest is 2.1.0)",
				pending: false,
				report: report(
					"2.0.3",
					[
						ok("daemon", "daemon 2.0.3 running (pid 912), 2 live agent(s)"),
						{
							group: "daemon",
							level: "note",
							text: "event loop: p99 240 ms, max 1900 ms; 3 stall(s) over 200 ms",
							fix: null,
						},
						{
							group: "harnesses",
							level: "note",
							text: "pi: found, not configured",
							fix: "run `pulsar setup --client pi`",
						},
						{
							group: "mesh",
							level: "bad",
							text: "background service not loaded (~/Library/LaunchAgents/dev.pulsar.daemon.plist)",
							fix: "run `pulsar mesh on`",
						},
						{
							group: "mesh",
							level: "note",
							text: "node certificate expires in 6 day(s); the daemon renews it daily",
							fix: null,
						},
					],
					{
						uptimeS: 2 * 3600 + 5 * 60,
						agents: 2,
						eventLoop: { p99: 240, max: 1900, stalls: 3 },
						facts: {
							tailscale: {
								state: "running",
								version: "1.102.0",
								dnsName: "mbp-a.tail1234.ts.net",
								magicDns: true,
							},
							certDays: 6,
							harnesses: [
								{
									id: "claude",
									label: "Claude Code",
									version: "2.1.300",
									configured: true,
								},
								{ id: "pi", label: "pi", version: null, configured: false },
							],
						},
					},
				),
			},
			{
				machineId: "mbp-b",
				name: "mbp-b",
				self: false,
				version: "2.1.0",
				error: "asleep 14m",
				upgrade: null,
				pending: false,
				report: null,
			},
			{
				machineId: "desk",
				name: "desk",
				self: false,
				version: "1.9.2",
				error: "upgrade pulsar on desk to see its checks",
				upgrade: "upgrade pulsar on desk (1.9.2; newest is 2.1.0)",
				pending: false,
				report: null,
			},
		],
	};
}

/** Mock knobs: hold one machine's answer back (ms), or make it time out. */
const knobs: {
	hold: Record<string, number>;
	timeout: string[];
	problem: string | null;
} = {
	hold: {},
	timeout: [],
	problem: null,
};

export function mockDiagnostics(b: {
	hold?: Record<string, number>;
	timeout?: string[];
	/** A problem this machine's next doctor run finds (null: none). */
	problem?: string | null;
	reset?: boolean;
}) {
	if (b.reset) {
		knobs.hold = {};
		knobs.timeout = [];
		knobs.problem = null;
	}
	if (b.problem !== undefined) knobs.problem = b.problem;
	if (b.hold) knobs.hold = b.hold;
	if (b.timeout) knobs.timeout = b.timeout;
	return { ok: true };
}

/** `GET /diagnostics`: every machine at once, reports to come. */
export function diagnosticsList(): DiagnosticsReport {
	const r = full();
	return {
		newest: r.newest,
		machines: r.machines.map((m) => ({
			...m,
			report: null,
			error: m.machineId === "mbp-b" ? m.error : null,
			// desk's version comes from its hello; it says why only when asked.
			pending: m.machineId !== "mbp-b",
			upgrade: m.upgrade,
		})),
	};
}

/** `GET /diagnostics/:id`: one machine's answer (after a held delay). */
export async function machineDiagnostics(
	id: string,
): Promise<MachineDiagnostics | null> {
	const m = full().machines.find((x) => x.machineId === id);
	if (!m) return null;
	const hold = knobs.hold[id] ?? 0;
	if (hold) await new Promise((r) => setTimeout(r, hold));
	if (knobs.timeout.includes(id))
		return {
			...m,
			report: null,
			error: `${m.name} did not answer within 35 s`,
		};
	if (m.self && knobs.problem && m.report)
		return {
			...m,
			report: {
				...m.report,
				checkedAt: Date.now(),
				checks: [
					...m.report.checks,
					{ group: "daemon", level: "bad", text: knobs.problem, fix: null },
				],
			},
		};
	return m;
}
