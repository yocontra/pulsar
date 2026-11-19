import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { DaemonClient } from "../client.ts";
import type { TlsFiles } from "../http/tls.ts";
import { installRoot } from "../paths.ts";
import { VERSION } from "../version.ts";
import { loadJsonc } from "./jsonc.ts";
import { loadState, type SetupState, saveState } from "./state.ts";
import { claudeApprovalsStep, confirm, stepContext } from "./steps.ts";

const home = homedir();
const tilde = (p: string) => p.replace(home, "~");

/** The line setup, doctor and status print while the mesh is off. */
export const MESH_OFF_HINT =
	"The agent mesh is off. `pulsar mesh on` turns it on: remote control from your phone, and agents on your other machines.";

export const MESH_HELP = `Usage: pulsar mesh [status|on|off|list|allow|deny|forget|owner]

The agent mesh links this machine to your other machines over Tailscale and
serves the app (remote control from your phone). It is off until you turn it on.

  pulsar mesh [status]          on or off, the app's URL, linked machines (read-only)
  pulsar mesh on [options]      check Tailscale, get this machine's HTTPS certificate,
                                turn the app on, install the background service,
                                relay Claude Code permission prompts to the app;
                                ends with the app's QR code
      -y, --yes                 apply without asking (skips the passkey step)
      --cert <file>             your own certificate for this machine's MagicDNS name
                                (PEM, leaf then intermediates), instead of \`tailscale cert\`;
                                needed with a self-hosted control server (Headscale)
      --key <file>              its private key (with --cert)
      --ca <file>               the root that issued it, when not a public CA
      --rp-id <domain>          the passkey RP id (default: the tailnet's MagicDNS suffix)
      --no-approvals            don't relay Claude Code permission prompts to the app
                                (removes the hook if an earlier run added it)
      --prove                   end with the passkey step, even with --yes
  pulsar mesh off [--dry-run]   remove the background service and the approvals hook,
                                turn the app off; agent configs stay
  pulsar mesh list              which tagged nodes may join the pool, the pool owner
  pulsar mesh allow|deny|forget <node>
  pulsar mesh owner <login>     change who may be in the pool; each change waits for you
                                to confirm it (Touch ID, or your passkey in the app)`;

/** `pulsar mesh on`'s flags; `pulsar setup --mesh` takes them too. */
export const MESH_ON_FLAGS = {
	cert: { type: "string" },
	key: { type: "string" },
	ca: { type: "string" },
	"rp-id": { type: "string" },
	"no-approvals": { type: "boolean" },
	prove: { type: "boolean" },
} as const;

export interface MeshOnOptions {
	/** `--yes`: no questions; a fix that needs the operator fails instead of waiting. */
	yes: boolean;
	/** The operator already said yes (in setup, or at `pulsar qr`): don't ask again. */
	confirmed?: boolean;
	tls?: TlsFiles;
	rpId?: string;
	/** Relay Claude Code permission prompts to the app (when Claude Code is here). */
	approvals: boolean;
	/** Claude Code is configured here (default: detected). */
	claude?: boolean;
	prove: boolean;
}

/** Options from parsed `MESH_ON_FLAGS`, or the reason they don't fit together. */
export function meshOnOptions(
	values: {
		cert?: string;
		key?: string;
		ca?: string;
		"rp-id"?: string;
		"no-approvals"?: boolean;
		prove?: boolean;
	},
	yes: boolean,
): MeshOnOptions | string {
	if (!!values.cert !== !!values.key || (values.ca && !values.cert))
		return "--cert and --key go together (and --ca needs them).";
	const abs = (p: string) => resolve(p.replace(/^~(?=\/|$)/, home));
	return {
		yes,
		approvals: !values["no-approvals"],
		prove: !!values.prove,
		...(values.cert && values.key
			? {
					tls: {
						cert: abs(values.cert),
						key: abs(values.key),
						...(values.ca ? { ca: abs(values.ca) } : {}),
					},
				}
			: {}),
		...(values["rp-id"] ? { rpId: values["rp-id"] } : {}),
	};
}

/** Set in tests and sandboxes: `pulsar mesh on` never reaches Tailscale or the service manager. */
function meshBlocked(): boolean {
	return /^(1|true|yes)$/i.test(process.env.PULSAR_NO_MESH ?? "");
}

const wantsHelp = (argv: string[]) =>
	argv.includes("--help") || argv.includes("-h");

export async function meshOnCommand(argv: string[]): Promise<number> {
	if (wantsHelp(argv)) {
		console.log(MESH_HELP);
		return 0;
	}
	const { values } = parseArgs({
		args: argv,
		options: { ...MESH_ON_FLAGS, yes: { type: "boolean", short: "y" } },
	});
	const opts = meshOnOptions(values, !!values.yes);
	if (typeof opts === "string") {
		console.error(opts);
		return 1;
	}
	return meshOn(opts);
}

/**
 * Turns the agent mesh on: Tailscale, the node certificate, the app, the
 * background service (runMeshSetup), then the Claude Code approvals hook and
 * the passkey offer; ends with the app's URL and QR code. Safe to run again.
 */
export async function meshOn(opts: MeshOnOptions): Promise<number> {
	if (meshBlocked()) {
		console.error(
			"The agent mesh can't be turned on here (PULSAR_NO_MESH is set).",
		);
		return 1;
	}
	await loadJsonc();
	const installDir = join(installRoot(), "current");
	const cli = join(installDir, "dist", "cli.js");
	if (!existsSync(cli)) {
		console.error(
			"Run `pulsar setup` first: the background service runs the copy of Pulsar it installs.",
		);
		return 1;
	}
	const { CLIENTS } = await import("../harnesses/index.ts");
	const { installedApprovalHook, removeApprovalHook, approvalHookUndo } =
		await import("../harnesses/claude.ts");
	const claude =
		opts.claude ?? CLIENTS.some((c) => c.id === "claude" && c.detect());
	const approvals = opts.approvals && claude;
	const dropHook = !opts.approvals && !!installedApprovalHook();

	console.log("Turn on the agent mesh:");
	console.log(
		"  - check Tailscale (installed, running, signed in, MagicDNS on)",
	);
	console.log(
		opts.tls
			? `  - check your certificate (${tilde(opts.tls.cert)})`
			: "  - get this machine's HTTPS certificate (`tailscale cert`)",
	);
	console.log("  - turn the app on and install the background service");
	if (approvals) console.log(`  - [claude] ${claudeApprovalsStep.describe}`);
	if (dropHook) console.log("  - [claude] remove the approvals hook");
	if (!opts.yes && !opts.confirmed) {
		if (!process.stdin.isTTY) {
			console.log("\nRun again with --yes to apply (no terminal to ask in).");
			return 1;
		}
		if (!(await confirm("\nTurn on the agent mesh?"))) return 1;
	}
	console.log("");

	const state: SetupState = loadState() ?? {
		version: VERSION,
		installDir,
		undo: [],
	};
	const outro: Array<() => Promise<void> | void> = [];
	const ctx = stepContext(
		opts.yes,
		(fn) => outro.push(fn),
		(client, undo) => {
			if (
				!state.undo.some((u) => JSON.stringify(u.undo) === JSON.stringify(undo))
			)
				state.undo.push({ client, undo });
		},
		{ node: process.execPath, cli },
	);

	const { meshOutro, runMeshSetup } = await import("./mesh.ts");
	const { envPort, readSettings, tlsSetting, writeSettings } = await import(
		"../http/config.ts"
	);
	const { runTailscale } = await import("../http/identity.ts");
	const { runCommand, serviceEnv } = await import("./service.ts");
	const r = await runMeshSetup({
		tailscale: runTailscale,
		run: runCommand,
		fetch,
		service: serviceEnv(),
		port: envPort(),
		log: ctx.log,
		waitEnter: ctx.waitEnter,
		enableRemote: () => writeSettings({ remote: true }),
		tls: opts.tls ?? tlsSetting(readSettings()),
		saveTls: (tls) => writeSettings({ tls }),
		...(opts.rpId ? { rpId: opts.rpId } : {}),
		saveRpId: (rpId) => writeSettings({ rpId }),
	});
	if (!r.ok) {
		console.log(
			"\nThe agent mesh is not on yet. Fix the problem above, then run `pulsar mesh on` again.",
		);
		return 1;
	}

	let failures = 0;
	if (approvals) {
		console.log("");
		if (!opts.yes && !(await confirm(claudeApprovalsStep.question)))
			console.log(`  · [${claudeApprovalsStep.id}] skipped`);
		else {
			try {
				if (!(await claudeApprovalsStep.run(ctx))) failures++;
			} catch (e) {
				failures++;
				console.log(
					`  ✗ [${claudeApprovalsStep.id}] ${(e as Error).message.split("\n")[0]}`,
				);
			}
		}
	}
	if (dropHook) {
		removeApprovalHook();
		const undo = JSON.stringify(approvalHookUndo());
		state.undo = state.undo.filter((u) => JSON.stringify(u.undo) !== undo);
		console.log("  ✓ [claude] removed the approvals hook");
	}
	saveState(state);

	const { offerProveHuman } = await import("./prove.ts");
	await offerProveHuman({ yes: opts.yes, prove: opts.prove });
	const url = r.url;
	if (url) await meshOutro(url, ctx.log);
	for (const fn of outro) await fn();
	return failures ? 1 : 0;
}

export async function meshOffCommand(argv: string[]): Promise<number> {
	if (wantsHelp(argv)) {
		console.log(MESH_HELP);
		return 0;
	}
	const { values } = parseArgs({
		args: argv,
		options: { "dry-run": { type: "boolean" } },
	});
	return meshOff(!!values["dry-run"]);
}

/** Removes the background service and the approvals hook and turns the app off; agent configs stay. */
export async function meshOff(dryRun: boolean): Promise<number> {
	const { readServiceRecord, removeService, serviceEnv } = await import(
		"./service.ts"
	);
	const { readSettings, writeSettings } = await import("../http/config.ts");
	const service = readServiceRecord();
	const { approvalHookUndo, installedApprovalHook, removeApprovalHook } =
		await import("../harnesses/claude.ts");
	await loadJsonc();
	const hook = Boolean(installedApprovalHook());
	const remote = readSettings().remote === true;
	if (!hook && !service && !remote) {
		console.log("The agent mesh is already off on this machine.");
		return 0;
	}
	console.log("pulsar mesh off will:");
	if (hook)
		console.log(
			"  - remove the Claude Code approvals hook (approvals are answered in the app, which is part of the mesh)",
		);
	if (service)
		console.log(
			`  - stop and remove the background service (${tilde(service.file)})`,
		);
	console.log("  - turn the app off");
	if (dryRun) return 0;
	try {
		await removeService(serviceEnv());
	} catch (e) {
		console.log(`  ! [service] ${(e as Error).message}`);
		return 1;
	}
	writeSettings({ remote: false });
	if (hook) {
		removeApprovalHook();
		const state = loadState();
		if (state) {
			const undo = JSON.stringify(approvalHookUndo());
			state.undo = state.undo.filter((u) => JSON.stringify(u.undo) !== undo);
			saveState(state);
		}
	}
	console.log(
		"Done. This machine left the agent mesh; agents keep working on this machine. Turn it back on with `pulsar mesh on`.",
	);
	return 0;
}

/**
 * `pulsar mesh [status]`: on or off, the app's URL, and the pool (from a
 * daemon that already runs; `client` is null when none does). Read-only.
 */
export async function meshStatus(client: DaemonClient | null): Promise<number> {
	const { appUrlOrReason, readSettings, remoteConfig } = await import(
		"../http/config.ts"
	);
	const cfg = remoteConfig();
	if (cfg.mode === "off") {
		console.log(MESH_OFF_HINT);
		return 0;
	}
	const fromEnv = readSettings().remote ? "" : " (from the environment)";
	console.log(
		cfg.mode === "dev"
			? `agent mesh: dev mode for ${cfg.login} (127.0.0.1:${cfg.port})${fromEnv}`
			: `agent mesh: on (port ${cfg.port})${fromEnv}`,
	);
	const app = await appUrlOrReason(cfg);
	console.log("url" in app ? `app: ${app.url}` : `app: ${app.reason}`);
	if (!client) {
		console.log(
			"The daemon is not running, so linked machines aren't known yet (`pulsar doctor --mesh` checks the rest).",
		);
		return 0;
	}
	const { poolCommand } = await import("../pool-cli.ts");
	return poolCommand(client, ["list"]);
}
