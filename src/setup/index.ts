import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stateDir } from "../paths.ts";
import { VERSION } from "../version.ts";
import {
	type Action,
	CLIENTS,
	type SetupContext,
	type Undo,
	undoAction,
} from "./clients.ts";

const home = homedir();
const tilde = (p: string) => p.replace(home, "~");

interface SetupState {
	version: string;
	installDir: string;
	undo: Array<{ client: string; undo: Undo }>;
}

function stateFile() {
	return join(stateDir(), "setup.json");
}

function loadState(): SetupState | null {
	try {
		return JSON.parse(readFileSync(stateFile(), "utf8")) as SetupState;
	} catch {
		return null;
	}
}

function saveState(state: SetupState) {
	writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
}

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
	throw new Error("could not find the pulsar package folder");
}

export function installRoot(): string {
	return (
		process.env.PULSAR_INSTALL_ROOT ??
		join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "pulsar")
	);
}

/**
 * Copies this version to a stable folder, so agent configs never depend on an
 * npx cache or a network fetch at session start.
 */
function installStableCopy(): string {
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
	const tmp = `${current}.${process.pid}`;
	rmSync(tmp, { force: true });
	symlinkSync(VERSION, tmp);
	renameSync(tmp, current);
	// Keep the two newest versions; older ones are no longer referenced.
	const versions = readdirSync(installRoot())
		.filter((v) => v !== VERSION && /^\d/.test(v))
		.sort();
	for (const old of versions.slice(0, -1))
		rmSync(join(installRoot(), old), { recursive: true, force: true });
	return current;
}

async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
	rl.close();
	return answer === "" || answer === "y" || answer === "yes";
}

function uninstall(yes: boolean, dryRun: boolean): Promise<number> | number {
	const state = loadState();
	if (!state) {
		console.log(
			"pulsar setup has not been run on this machine; nothing to undo.",
		);
		return 0;
	}
	console.log("pulsar setup --uninstall will:");
	for (const u of [...state.undo].reverse())
		console.log(`  - [${u.client}] undo ${describeUndo(u.undo)}`);
	console.log(`  - remove ${tilde(installRoot())}`);
	if (dryRun) return 0;
	const run = () => {
		for (const u of [...state.undo].reverse()) {
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
	return confirm("Continue?").then((ok) => (ok ? run() : 1));
}

function describeUndo(u: Undo): string {
	switch (u.type) {
		case "json":
			return `${u.path.join(".")} in ${tilde(u.file)}`;
		case "cli":
			return `\`${u.cmd} ${u.args.join(" ")}\``;
		case "dir":
			return `remove ${tilde(u.path)}`;
	}
}

export async function runSetup(argv: string[]): Promise<number> {
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
		},
	});
	if (values.uninstall) return uninstall(!!values.yes, !!values["dry-run"]);

	const wanted = values.client
		?.flatMap((c) => c.split(","))
		.map((c) => c.trim().toLowerCase());
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
	if (selected.length === 0) {
		console.log(
			`No supported agents found. Supported: ${CLIENTS.map((c) => c.label).join(", ")}.`,
		);
		return 1;
	}

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

	console.log(`pulsar ${VERSION} setup\n`);
	console.log(
		`Agents found: ${detected.map((c) => c.label).join(", ") || "none"}`,
	);
	console.log(`Configuring:  ${selected.map((c) => c.label).join(", ")}\n`);
	console.log(
		`  - copy pulsar to ${tilde(installDir)} (agents run it with ${tilde(ctx.node)})`,
	);
	for (const a of actions) console.log(`  - [${a.client}] ${a.describe}`);
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

	installStableCopy();
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
	// Keep undo entries from earlier runs for clients not touched this time.
	for (const old of previous?.undo ?? []) {
		if (!state.undo.some((u) => JSON.stringify(u) === JSON.stringify(old)))
			state.undo.push(old);
	}
	saveState(state);

	console.log(
		`\n${failures ? `Done with ${failures} problem(s).` : "Done."} Restart your agents to load pulsar.`,
	);
	console.log(
		'Then try: `pulsar ls` here, or ask any agent to "list agents with pulsar".\n',
	);
	await restartOutdatedDaemon();
	const { runDoctor } = await import("./doctor.ts");
	await runDoctor({ quiet: true });
	return failures ? 1 : 0;
}

/** Stops a daemon from an older version; the next agent call starts this one. Agents reconnect on their own. */
async function restartOutdatedDaemon() {
	const { DaemonClient } = await import("../client.ts");
	const { PROTOCOL_VERSION } = await import("../types.ts");
	const client = new DaemonClient();
	try {
		await client.connect(false);
		await client.call("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
			registration: { role: "cli" },
		});
		const status = await client.call<{ version: string }>("status");
		if (status.version !== VERSION) {
			await client.call("shutdown");
			console.log(
				`Restarted the pulsar daemon (${status.version} → ${VERSION}).`,
			);
		}
	} catch {
		// No daemon running: nothing to restart.
	} finally {
		client.close();
	}
}
