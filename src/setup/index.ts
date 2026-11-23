import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CLIENTS } from "../harnesses/index.ts";
import { meshIsOn } from "../http/config.ts";
import { installRoot, retainedBuilds } from "../paths.ts";
import { VERSION } from "../version.ts";
import {
	type Action,
	type SetupContext,
	type Undo,
	undoAction,
} from "./actions.ts";
import { loadJsonc } from "./jsonc.ts";
import { MESH_ON_FLAGS, meshOnOptions } from "./mesh-cli.ts";
import { binDir, onPath, pathAdvice, shimPath, writeShim } from "./shim.ts";
import { loadState, type SetupState, saveState, stateFile } from "./state.ts";
import { confirm, SETUP_STEPS, stepContext } from "./steps.ts";

const home = homedir();
const tilde = (p: string) => p.replace(home, "~");

/** The package root (holds package.json, dist/, skills/), found by walking up. */
function packageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 5; i++) {
		const pkg = join(dir, "package.json");
		if (
			existsSync(pkg) &&
			(JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name ===
				"pulsar"
		)
			return dir;
		dir = dirname(dir);
	}
	throw new Error("could not find the Pulsar package folder");
}

/**
 * Copies this version to a stable folder, so agent configs never depend on an
 * npx cache or a network fetch at session start.
 */
async function installStableCopy(): Promise<string> {
	const root = packageRoot();
	const dist = join(root, "dist", "cli.js");
	if (!existsSync(dist))
		throw new Error(`no build found at ${dist}. Run \`bun run build\` first.`);
	const dir = join(installRoot(), VERSION);
	if (resolve(dir) !== resolve(root)) {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		for (const entry of [
			"package.json",
			"dist",
			"skills",
			"README.md",
			"LICENSE",
		]) {
			if (existsSync(join(root, entry)))
				cpSync(join(root, entry), join(dir, entry), { recursive: true });
		}
	}
	// Agent configs point at `current`, so an upgrade only moves this link.
	const current = join(installRoot(), "current");
	let previous: string | null = null;
	try {
		previous = readlinkSync(current);
	} catch {}
	const tmp = `${current}.${process.pid}`;
	rmSync(tmp, { force: true });
	symlinkSync(VERSION, tmp);
	renameSync(tmp, current);
	// Running agents and the service still load code from the folder `current`
	// pointed to, and this process from its own: keep both. Keep the newest
	// builds too: the daemon serves their app files to pages that still run
	// them (src/paths.ts retainedBuilds). Drop the rest.
	const keep = new Set([
		VERSION,
		previous,
		basename(root),
		...(await retainedBuilds()),
	]);
	for (const old of readdirSync(installRoot()))
		if (/^\d/.test(old) && !keep.has(old))
			rmSync(join(installRoot(), old), { recursive: true, force: true });
	return current;
}

async function uninstall(yes: boolean, dryRun: boolean): Promise<number> {
	const { readServiceRecord, removeService, serviceEnv } = await import(
		"./service.ts"
	);
	const service = readServiceRecord();
	const state = loadState();
	if (!state && !service) {
		console.log(
			"pulsar setup has not been run on this machine; nothing to undo.",
		);
		return 0;
	}
	console.log("pulsar setup --uninstall will:");
	if (service)
		console.log(
			`  - stop and remove the background service (${tilde(service.file)})`,
		);
	for (const u of [...(state?.undo ?? [])].reverse())
		console.log(`  - [${u.client}] undo ${describeUndo(u.undo)}`);
	console.log(`  - remove ${tilde(installRoot())}`);
	if (dryRun) return 0;
	const run = async () => {
		// Before the install folder goes: the service runs from it.
		if (service) {
			try {
				await removeService(serviceEnv());
			} catch (e) {
				console.log(`  ! [service] ${(e as Error).message}`);
			}
		}
		for (const u of [...(state?.undo ?? [])].reverse()) {
			try {
				undoAction(u.undo);
			} catch (e) {
				console.log(`  ! [${u.client}] ${(e as Error).message}`);
			}
		}
		rmSync(installRoot(), { recursive: true, force: true });
		rmSync(stateFile(), { force: true });
		console.log(
			"Done. Restart your agents. The daemon exits on its own once idle (or run `pulsar stop`).",
		);
		return 0;
	};
	if (yes || !process.stdin.isTTY) return run();
	return (await confirm("Continue?")) ? run() : 1;
}

function describeUndo(u: Undo): string {
	switch (u.type) {
		case "json":
			return `${u.path.join(".")} in ${tilde(u.file)}`;
		case "cli":
			return `\`${u.cmd} ${u.args.join(" ")}\``;
		case "dir":
			return `remove ${tilde(u.path)}`;
		case "hook":
			return `the ${u.event} hook in ${tilde(u.file)}`;
		case "shim":
			return `remove the \`pulsar\` command (${tilde(u.path)})`;
	}
}

const SETUP_HELP = `Usage: pulsar setup [options]

Configures the agents found on this machine to use pulsar and puts the
\`pulsar\` command on your PATH. Shows the plan and asks before changing
anything; files are backed up first. At the end it asks whether to turn on
the agent mesh (\`pulsar mesh on\`: remote control from your phone, agents on
your other machines); the answer defaults to no.

  -y, --yes             apply without asking (the mesh stays as it is, unless --mesh)
  --client <name>       only these clients (repeat, or comma-separated);
                        \`--client none\` configures no agents (only the \`pulsar\` command)
  --all-detected        every client found (the default)
  --dry-run             show the plan, change nothing
  --no-mcp              skip MCP server entries
  --skills-dir <path>   install the skill into one shared folder
  --no-approvals        don't relay Claude Code permission prompts to the app
                        (removes the hook if an earlier run added it)
  --mesh                turn the agent mesh on without asking; takes the
                        \`pulsar mesh on\` options: --cert, --key, --ca, --rp-id, --prove
  --uninstall           undo everything setup did
  -h, --help            this help

See \`pulsar mesh help\` for the mesh.`;

export async function runSetup(argv: string[]): Promise<number> {
	await loadJsonc();
	const { values } = parseArgs({
		args: argv,
		options: {
			yes: { type: "boolean", short: "y" },
			"all-detected": { type: "boolean" },
			client: { type: "string", multiple: true },
			"dry-run": { type: "boolean" },
			"no-mcp": { type: "boolean" },
			"skills-dir": { type: "string" },
			uninstall: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			mesh: { type: "boolean" },
			...MESH_ON_FLAGS,
		},
	});
	if (values.help) {
		console.log(SETUP_HELP);
		return 0;
	}
	if (values.uninstall) return uninstall(!!values.yes, !!values["dry-run"]);
	const meshOpts = meshOnOptions(values, !!values.yes);
	if (typeof meshOpts === "string") {
		console.error(meshOpts);
		return 1;
	}
	const meshFlag = ["cert", "key", "ca", "rp-id", "prove"].find(
		(f) => values[f as keyof typeof values] !== undefined,
	);
	if (meshFlag && !values.mesh) {
		console.error(`--${meshFlag} is a mesh option: add --mesh.`);
		return 1;
	}

	const wanted = values.client
		?.flatMap((c) => c.split(","))
		.map((c) => c.trim().toLowerCase())
		// `--client none`: configure no agents (a server: only the `pulsar` command).
		.filter((c) => c && c !== "none");
	const unknown = wanted?.filter((w) => !CLIENTS.some((c) => c.id === w));
	if (unknown?.length) {
		console.error(
			`Unknown client(s): ${unknown.join(", ")}. Known: ${CLIENTS.map((c) => c.id).join(", ")}`,
		);
		return 1;
	}
	const detected = CLIENTS.filter((c) => c.detect());
	const selected = wanted
		? CLIENTS.filter((c) => wanted.includes(c.id))
		: detected;
	// The mesh is asked about at the end; `--mesh` turns it on (or refreshes it) without asking.
	const meshWasOn = meshIsOn();
	const meshPlanned = !!values.mesh;

	const installDir = join(installRoot(), "current");
	const skillsDir = values["skills-dir"]
		? resolve(values["skills-dir"].replace(/^~/, home))
		: null;
	const ctx: SetupContext = {
		node: process.execPath,
		installDir,
		cli: join(installDir, "dist", "cli.js"),
		skillSource: join(installDir, "skills", "pulsar"),
		mcp: !values["no-mcp"],
		skillsDir,
	};
	const actions: Action[] = selected.flatMap((c) => c.plan(ctx));
	// The `pulsar` command every hint names, from the stable copy.
	const shim = shimPath();
	actions.push({
		client: "pulsar",
		describe: `put the \`pulsar\` command in ${tilde(binDir())}`,
		apply: () => writeShim(ctx.node, ctx.cli),
		undo: { type: "shim", path: shim },
	});
	// `pulsar mesh on` runs the approvals step itself.
	const steps = (meshPlanned ? [] : SETUP_STEPS).filter(
		(s) =>
			!s.skipped?.(
				values,
				selected.map((c) => c.id),
			),
	);
	// `--no-approvals` also takes back the hook an earlier setup added.
	const { approvalHookUndo, installedApprovalHook, removeApprovalHook } =
		await import("../harnesses/claude.ts");
	const dropHook = Boolean(values["no-approvals"]) && !!installedApprovalHook();
	if (skillsDir) {
		const dest = skillsDir.endsWith("/pulsar")
			? skillsDir
			: join(skillsDir, "pulsar");
		actions.push({
			client: "skills",
			describe: `install skill to ${tilde(dest)}`,
			apply: () => {
				rmSync(dest, { recursive: true, force: true });
				mkdirSync(join(dest, ".."), { recursive: true });
				cpSync(ctx.skillSource, dest, { recursive: true });
			},
			undo: { type: "dir", path: dest },
		});
	}

	console.log(`Pulsar ${VERSION} setup\n`);
	console.log(
		`Agents found: ${detected.map((c) => c.label).join(", ") || "none"}`,
	);
	console.log(
		selected.length
			? `Configuring:  ${selected.map((c) => c.label).join(", ")}\n`
			: `Configuring:  no agents (only the \`pulsar\` command${wanted ? "" : `; supported: ${CLIENTS.map((c) => c.label).join(", ")}`})\n`,
	);
	console.log(
		`  - copy Pulsar to ${tilde(installDir)} (agents run it with ${tilde(ctx.node)})`,
	);
	for (const a of actions) console.log(`  - [${a.client}] ${a.describe}`);
	if (dropHook)
		console.log(`  - [claude] remove ${describeUndo(approvalHookUndo())}`);
	for (const s of steps)
		console.log(`  - [${s.id}] ${s.describe} (asks first)`);
	if (meshPlanned)
		console.log(
			"  - [mesh] turn on the agent mesh: Tailscale, HTTPS certificate, app, background service (`pulsar mesh on`)",
		);
	else if (!meshWasOn && !values.yes)
		console.log("  - [mesh] ask whether to turn on the agent mesh");
	console.log(
		"\nFiles are backed up as <file>.bak-pulsar-<time> before any change. Undo with `pulsar setup --uninstall`.",
	);

	if (values["dry-run"]) {
		console.log("\n--dry-run: nothing changed.");
		return 0;
	}
	if (!values.yes) {
		if (!process.stdin.isTTY) {
			console.log("\nRun again with --yes to apply (no terminal to ask in).");
			return 1;
		}
		if (!(await confirm("\nApply these changes?"))) return 1;
	}

	await installStableCopy();
	const previous = loadState();
	const state: SetupState = { version: VERSION, installDir, undo: [] };
	let failures = 0;
	for (const a of actions) {
		try {
			a.apply();
			state.undo.push({ client: a.client, undo: a.undo });
			console.log(`  ✓ [${a.client}] ${a.describe}`);
		} catch (e) {
			failures++;
			console.log(
				`  ✗ [${a.client}] ${a.describe}: ${(e as Error).message.split("\n")[0]}`,
			);
		}
	}
	if (dropHook) {
		try {
			removeApprovalHook();
			console.log(`  ✓ [claude] removed ${describeUndo(approvalHookUndo())}`);
		} catch (e) {
			failures++;
			console.log(`  ✗ [claude] remove: ${(e as Error).message}`);
		}
	}
	// Keep undo entries from earlier runs for clients not touched this time.
	const removed = new Set(dropHook ? [JSON.stringify(approvalHookUndo())] : []);
	for (const old of previous?.undo ?? []) {
		if (
			!removed.has(JSON.stringify(old)) &&
			!state.undo.some((u) => JSON.stringify(u) === JSON.stringify(old))
		)
			state.undo.push(old);
	}
	saveState(state);

	const outro: Array<() => Promise<void> | void> = [];
	const stepCtx = stepContext(
		!!values.yes,
		(fn) => outro.push(fn),
		(client, undo) => {
			if (
				!state.undo.some((u) => JSON.stringify(u.undo) === JSON.stringify(undo))
			)
				state.undo.push({ client, undo });
		},
		{ node: ctx.node, cli: ctx.cli },
	);
	for (const step of steps) {
		console.log("");
		if (!values.yes && !(await confirm(step.question))) {
			console.log(`  · [${step.id}] skipped`);
			continue;
		}
		try {
			if (!(await step.run(stepCtx))) failures++;
		} catch (e) {
			failures++;
			console.log(`  ✗ [${step.id}] ${(e as Error).message.split("\n")[0]}`);
		}
	}
	// Steps may have recorded undo entries.
	saveState(state);

	console.log(
		`\n${failures ? `Done with ${failures} problem(s).` : "Done."} Restart your agents to load Pulsar.`,
	);
	if (!onPath(binDir()))
		console.log(
			`\n${tilde(binDir())} is not on your PATH, so \`pulsar\` won't run yet: ${pathAdvice()}`,
		);
	console.log(
		'Then try: `pulsar ls` here, or ask any agent to "list agents with pulsar".\n',
	);
	await restartOutdatedDaemon();
	const { runDoctor } = await import("./doctor.ts");
	await runDoctor({ quiet: true });
	if (meshWasOn && !meshPlanned) {
		const { offerProveHuman } = await import("./prove.ts");
		await offerProveHuman({ yes: Boolean(values.yes), prove: false });
	}
	for (const fn of outro) await fn();
	if (meshWasOn && !meshPlanned) return failures ? 1 : 0;

	// The mesh, last: it ends with the app's QR code. Off unless asked for.
	const { MESH_OFF_HINT, meshOn } = await import("./mesh-cli.ts");
	const wantMesh =
		meshPlanned ||
		(!values.yes &&
			process.stdin.isTTY &&
			(await confirm(
				"\nTurn on the agent mesh? It lets you control your agents from your phone and links agents on your other machines (Tailscale).",
				false,
			)));
	if (!wantMesh) {
		console.log(`\n${MESH_OFF_HINT}`);
		return failures ? 1 : 0;
	}
	console.log("");
	const mesh = await meshOn({
		...meshOpts,
		// The approvals hook only when this run configures Claude Code.
		claude: selected.some((c) => c.id === "claude"),
		confirmed: true,
	});
	return failures || mesh ? 1 : 0;
}

/**
 * Moves the daemon to this version. A service is restarted; an on-demand
 * daemon from an older version is stopped and started again from `current`.
 * Agents reconnect on their own.
 */
async function restartOutdatedDaemon() {
	const {
		restartService,
		serviceEnv,
		serviceInstalled,
		serviceInstalledThisRun,
	} = await import("./service.ts");
	if (serviceInstalled()) {
		// Already restarted on this version in this process.
		if (serviceInstalledThisRun()) return;
		try {
			await restartService(serviceEnv());
			console.log("Restarted the Pulsar background service.");
		} catch (e) {
			console.error(
				`Could not restart the Pulsar background service: ${(e as Error).message}`,
			);
		}
		return;
	}
	const { DaemonClient } = await import("../client.ts");
	const { PROTOCOL_VERSION } = await import("../types.ts");
	const client = new DaemonClient();
	try {
		await client.connect(false);
	} catch {
		// No daemon running: nothing to restart.
		return;
	}
	try {
		await client.call("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
			registration: { role: "cli" },
		});
		const status = await client.call<{ version: string }>("status");
		if (status.version === VERSION) return;
		await client.call("shutdown");
		// Start the new daemon at once (from `current`), before older sessions reconnect.
		await new Promise((r) => setTimeout(r, 300));
		const fresh = new DaemonClient();
		try {
			await fresh.connect(true);
			console.log(
				`Restarted the pulsar daemon (${status.version} → ${VERSION}).`,
			);
		} catch (e) {
			console.error(
				`Stopped the old pulsar daemon (${status.version}) but the new one did not start: ${(e as Error).message}`,
			);
		} finally {
			fresh.close();
		}
	} catch (e) {
		console.error(
			`Could not check the running pulsar daemon: ${(e as Error).message}`,
		);
	} finally {
		client.close();
	}
}
