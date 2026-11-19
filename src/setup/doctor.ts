import { existsSync } from "node:fs";
import { DaemonClient } from "../client.ts";
import { CLIENTS } from "../harnesses/index.ts";
import { envPort } from "../http/config.ts";
import type { LagStats } from "../service/jobs.ts";
import type { PoolMachine } from "../service/pool.ts";
import { PROTOCOL_VERSION } from "../types.ts";
import { newer } from "../util.ts";
import { VERSION } from "../version.ts";
import { loadJsonc } from "./jsonc.ts";

interface Status {
	version: string;
	protocol: number;
	pid: number;
	agents: number;
	/** Absent on older daemons. */
	eventLoop?: LagStats;
	/** Claude sessions on a hook without `--timeout`; absent on older daemons. */
	oldHookSessions?: { name: string; pid: number | null }[];
}

async function latestVersion(): Promise<string | null> {
	try {
		const res = await fetch("https://registry.npmjs.org/pulsar/latest", {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) return null;
		return ((await res.json()) as { version?: string }).version ?? null;
	} catch {
		return null;
	}
}

/** Checks the daemon and every harness integration. Returns an exit code. */
export async function runDoctor(
	opts: { quiet?: boolean; meshOnly?: boolean } = {},
): Promise<number> {
	await loadJsonc();
	let problems = 0;
	const ok = (msg: string) => console.log(`  ✓ ${msg}`);
	const bad = (msg: string) => {
		problems++;
		console.log(`  ✗ ${msg}`);
	};
	const note = (msg: string) => console.log(`  · ${msg}`);

	console.log(`Pulsar ${VERSION} doctor`);
	if (opts.meshOnly) {
		// Read-only: no daemon is started.
		await runMeshChecks(ok, bad, note);
		return problems ? 1 : 0;
	}
	let oldHooks: Status["oldHookSessions"] = [];
	const client = new DaemonClient();
	try {
		await client.connect(true);
		await client.call("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
			registration: { role: "cli" },
		});
		const s = await client.call<Status>("status");
		oldHooks = s.oldHookSessions ?? [];
		ok(`daemon ${s.version} running (pid ${s.pid}), ${s.agents} live agent(s)`);
		const lag = s.eventLoop;
		if (lag) {
			const line = `event loop: p99 ${lag.p99} ms, max ${lag.max} ms`;
			if (lag.lastStall) {
				const c = lag.causes;
				const causes = c
					? ` (${c.busy} JS, ${c.gc} GC, ${c.starved} starved of CPU)`
					: "";
				const top = lag.lastStall.cause?.top.length
					? `; top: ${lag.lastStall.cause.top.join(", ")}`
					: "";
				note(
					`${line}; ${lag.stalls} stall(s) over 200 ms${causes}, last ${lag.lastStall.ms} ms at ${lag.lastStall.at} (running: ${lag.lastStall.culprit}${top})`,
				);
			} else ok(line);
			if (lag.gc?.long)
				note(
					`garbage collection: ${lag.gc.long} pause(s) of 50 ms or more, longest ${lag.gc.maxMs} ms`,
				);
		}
		if (s.version !== VERSION)
			note(
				`daemon runs ${s.version}; it switches to ${VERSION} after \`pulsar stop\``,
			);
		client.close();
	} catch (e) {
		bad(`daemon: ${(e as Error).message}`);
	}

	for (const c of CLIENTS) {
		if (!c.detect()) continue;
		if (c.configured()) ok(`${c.label}: configured`);
		else
			note(
				`${c.label}: found, not configured (run \`pulsar setup --client ${c.id}\`)`,
			);
	}

	if (CLIENTS.some((c) => c.id === "opencode" && c.detect())) {
		// The daemon runs `opencode api`; its PATH may find an old OpenCode first.
		const { staleOpencodeOnPath, OPENCODE_HOME_BIN } = await import(
			"../harnesses/opencode-api.ts"
		);
		const { serviceVariables } = await import("./service.ts");
		const daemonPath = serviceVariables(process.env, process.execPath).PATH;
		const stale = await staleOpencodeOnPath(daemonPath ?? "");
		if (stale)
			note(
				`OpenCode: the daemon's PATH finds ${stale.path} (${stale.version}), too old for \`opencode api\`; Pulsar uses the running service's own executable (or ${OPENCODE_HOME_BIN()}) instead. Update or remove the old one.`,
			);
	}

	const { shimStatus } = await import("./shim.ts");
	const shim = shimStatus();
	if (shim.ok) ok(shim.message);
	else bad(shim.message);

	const { installedApprovalHook } = await import("../harnesses/claude.ts");
	const hook = installedApprovalHook();
	if (hook) {
		// The command is `<node> <cli> hook claude-permission`; both files must exist.
		const missing = hook
			.split(/\s+/)
			.slice(0, 2)
			.map((p) => p.replace(/^'|'$/g, ""))
			.filter((p) => p.startsWith("/") && !existsSync(p));
		if (missing.length)
			bad(
				`Claude Code approvals: the hook runs ${missing.join(", ")}, which is missing; re-run \`pulsar setup\``,
			);
		else {
			const { remoteConfig } = await import("../http/config.ts");
			const { localPasskeyCount, NO_LOCAL_PASSKEY } = await import(
				"./passkey-hint.ts"
			);
			if (remoteConfig().mode === "off")
				note(
					"Claude Code approvals: hook installed, but the agent mesh is off on this machine, so prompts stay in the terminal (`pulsar mesh on` turns it on)",
				);
			else if ((await localPasskeyCount()) === 0)
				note(`Claude Code approvals: ${NO_LOCAL_PASSKEY}`);
			else ok("Claude Code approvals: permission prompts relay to the app");
			const { installedApprovalHookTimeout, APPROVAL_HOOK_TIMEOUT_S } =
				await import("../harnesses/claude.ts");
			const timeout = installedApprovalHookTimeout();
			if (timeout !== null && timeout < APPROVAL_HOOK_TIMEOUT_S)
				note(
					`Claude Code approvals: the hook times out after ${timeout} s, so a question or plan left for the app longer ends in the terminal; re-run \`pulsar setup\` (${APPROVAL_HOOK_TIMEOUT_S} s)`,
				);
			else if (!hook.includes("--timeout"))
				note(
					"Claude Code approvals: the hook doesn't pass its timeout, so the app has 9 minutes to answer a permission prompt; re-run `pulsar setup` to give it an hour",
				);
			if (oldHooks.length)
				note(
					`Claude Code approvals: ${oldHooks.length} running session(s) started before the hook gave the app an hour (${oldHooks
						.map((o) => (o.pid ? `${o.name}, pid ${o.pid}` : o.name))
						.join(
							"; ",
						)}); the app has 9 minutes to answer their prompts. Restart these sessions to give the app an hour to answer.`,
				);
		}
	} else if (
		CLIENTS.some((c) => c.id === "claude" && c.detect()) &&
		(await import("../http/config.ts")).meshIsOn()
	)
		note(
			"Claude Code approvals: off (run `pulsar mesh on` to answer permission prompts from the app)",
		);

	const { readSettings, remoteConfig, tailnetUrl, tlsSetting } = await import(
		"../http/config.ts"
	);
	const remote = remoteConfig();
	if (remote.mode === "tailscale") {
		const { BRING_CERT_HINT, ENABLE_HTTPS_HINT, runTailscale, tailscaleSelf } =
			await import("../http/identity.ts");
		const self = await tailscaleSelf();
		// The operator's own certificate replaces `tailscale cert` (the mesh checks inspect it).
		const ownCert = tlsSetting(readSettings()) !== null;
		if (!self) bad("remote access: Tailscale is not running or not logged in");
		else if (!self.ownerLogin)
			bad("remote access: this node has no Tailscale user (a tagged node)");
		else if (!ownCert && !self.certDomains.includes(self.dnsName)) {
			const { readControlPlane } = await import("../http/control.ts");
			const { magicDnsSuffix } = await import("../federation/tailnet.ts");
			const control = await readControlPlane(
				runTailscale,
				magicDnsSuffix(self.dnsName),
			);
			bad(
				`remote access: ${control.kind === "custom" ? BRING_CERT_HINT : ENABLE_HTTPS_HINT}`,
			);
		} else
			ok(
				`remote access: ${tailnetUrl(self.dnsName, remote.port)} for ${self.ownerLogin}`,
			);
	} else if (remote.mode === "dev")
		note(
			`remote access: dev mode for ${remote.login} on http://127.0.0.1:${remote.port}/`,
		);
	if (remote.mode !== "off") {
		console.log("agent mesh");
		await runMeshChecks(ok, bad, note);
	} else if (!opts.quiet) {
		// Setup (quiet) prints its own line about the mesh at the end.
		const { MESH_OFF_HINT } = await import("./mesh-cli.ts");
		console.log("agent mesh");
		note(MESH_OFF_HINT);
	}

	if (!existsSync(process.execPath))
		bad(`node binary ${process.execPath} is missing; re-run \`pulsar setup\``);

	if (!opts.quiet) {
		const latest = await latestVersion();
		if (latest && newer(latest, VERSION))
			note(`Pulsar ${latest} is available: run \`npx pulsar@latest setup\``);
	}
	return problems ? 1 : 0;
}

async function runMeshChecks(
	ok: (m: string) => void,
	bad: (m: string) => void,
	note: (m: string) => void,
) {
	const { readSettings, remoteConfig, tlsSetting } = await import(
		"../http/config.ts"
	);
	const settings = readSettings();
	const { runTailscale } = await import("../http/identity.ts");
	const { meshChecks } = await import("./mesh-doctor.ts");
	const { runCommand, serviceEnv } = await import("./service.ts");
	const remote = remoteConfig();
	if (remote.mode === "dev") {
		note(
			`remote access: dev mode for ${remote.login} on http://127.0.0.1:${remote.port}/`,
		);
		return;
	}
	await meshChecks(
		{
			tailscale: runTailscale,
			run: runCommand,
			fetch,
			service: serviceEnv(),
			remoteOn: remote.mode === "tailscale",
			port: envPort(),
			tls: tlsSetting(settings),
			...(settings.rpId ? { rpId: settings.rpId } : {}),
			allowed: (await import("../federation/config.ts")).readPoolConfig().allow,
			// The daemon's own view of each peer's link (its federation).
			pool: async () => {
				const { DaemonClient } = await import("../client.ts");
				const client = new DaemonClient();
				try {
					await client.connect(false);
					const s = await client.call<{ pool?: PoolMachine[] }>("status", {});
					return s.pool ?? null;
				} catch {
					return null;
				} finally {
					client.close?.();
				}
			},
		},
		{ ok, bad, note },
	);
}
