import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtCli } from "./helpers.ts";

const root = join(import.meta.dir, "..");
const cli = join(root, "dist", "cli.js");
// Absolute node path: the child gets a bare PATH so real harness CLIs are not found.
const node = execFileSync("node", ["-p", "process.execPath"], {
	encoding: "utf8",
}).trim();

/** Runs the built CLI with a fake HOME, so real agent configs are never touched. */
function run(
	home: string,
	args: string[],
	extraEnv: Record<string, string> = {},
	entry = cli,
) {
	const r = spawnSync(node, [entry, ...args], {
		encoding: "utf8",
		env: {
			PATH: "/usr/bin:/bin",
			HOME: home,
			PULSAR_HOME: join(home, ".pulsar-state"),
			PULSAR_INSTALL_ROOT: join(home, ".pulsar-install"),
			// Never reach the real launchctl, systemctl or Tailscale.
			PULSAR_NO_MESH: "1",
			// A daemon setup starts must not scan (and message) real sessions.
			PULSAR_NO_SCAN: "1",
			...extraEnv,
		},
		timeout: 60_000,
	});
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const homes: string[] = [];

function fakeHome() {
	const home = mkdtempSync(join(tmpdir(), "pulsar-home-"));
	homes.push(home);
	mkdirSync(join(home, ".cursor"));
	mkdirSync(join(home, ".gemini"));
	mkdirSync(join(home, ".config", "opencode"), { recursive: true });
	writeFileSync(
		join(home, ".config", "opencode", "opencode.jsonc"),
		'{\n  // keep this comment\n  "mcp": {\n    "servers": {\n      "other": { "type": "local", "command": ["x"] }\n    }\n  }\n}\n',
	);
	writeFileSync(
		join(home, ".gemini", "settings.json"),
		'{ "theme": "dark" }\n',
	);
	return home;
}

// Setup starts a daemon in each fake home (detached, so it may still be
// coming up): stop it until none answers, then remove the home.
afterAll(async () => {
	for (const home of homes) {
		for (let i = 0; i < 10; i++) {
			run(home, ["stop"]);
			await new Promise((r) => setTimeout(r, 200));
			if (/not running/.test(run(home, ["status"]).out)) break;
		}
		// A daemon that came up after the last check: anything running from
		// this temp home is ours.
		await new Promise((r) => setTimeout(r, 500));
		spawnSync("pkill", ["-f", home]);
		rmSync(home, { recursive: true, force: true });
	}
}, 60_000);

beforeAll(() => {
	// Never test an old build (a checkout that moved since the last build).
	builtCli();
});

describe("pulsar setup", () => {
	test("--dry-run changes nothing", () => {
		const home = fakeHome();
		const before = readFileSync(join(home, ".gemini", "settings.json"), "utf8");
		const r = run(home, [
			"setup",
			"--dry-run",
			"--client",
			"cursor,gemini,opencode",
		]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("--dry-run: nothing changed");
		expect(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).toBe(
			before,
		);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
	});

	test("the mesh is not part of setup unless asked for: --dry-run shows the question, --mesh plans it", () => {
		const home = fakeHome();
		// --dry-run returns before anything runs, so no real launchctl or tailscale.
		const r = run(home, ["setup", "--dry-run", "--client", "cursor"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("[mesh] ask whether to turn on the agent mesh");
		expect(r.out).not.toContain("[claude-approvals]");
		const yes = run(home, [
			"setup",
			"--dry-run",
			"--yes",
			"--client",
			"cursor",
		]);
		expect(yes.out).not.toContain("[mesh]");
		const mesh = run(home, [
			"setup",
			"--dry-run",
			"--mesh",
			"--client",
			"cursor",
		]);
		expect(mesh.out).toContain("[mesh] turn on the agent mesh");
		// Mesh options need --mesh.
		const cert = run(home, [
			"setup",
			"--dry-run",
			"--client",
			"cursor",
			"--cert",
			"a",
			"--key",
			"b",
		]);
		expect(cert.code).toBe(1);
		expect(cert.out).toContain("--cert is a mesh option: add --mesh");
	});

	test("no agents to configure (--client none, or none found): only the command, and the mesh question", () => {
		const bare = mkdtempSync(join(tmpdir(), "pulsar-home-"));
		homes.push(bare);
		const r = run(bare, ["setup", "--dry-run", "--client", "none"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain(
			"Configuring:  no agents (only the `pulsar` command)",
		);
		const none = run(bare, ["setup", "--dry-run"]);
		expect(none.code).toBe(0);
		expect(none.out).toContain(
			"Configuring:  no agents (only the `pulsar` command; supported:",
		);
		expect(none.out).toContain("[mesh] ask whether to turn on the agent mesh");
	});

	test("--yes --mesh applies the agent configs, then runs `pulsar mesh on`", () => {
		const home = fakeHome();
		// PULSAR_NO_MESH (set by run) stops `mesh on` before Tailscale or the service manager.
		const r = run(home, ["setup", "--yes", "--mesh", "--client", "cursor"]);
		expect(r.out).toContain("✓ [cursor]");
		expect(r.out).toContain("PULSAR_NO_MESH is set");
		expect(r.code).toBe(1);
	}, 60_000);

	test("without a terminal it asks for --yes", () => {
		const home = fakeHome();
		const r = run(home, ["setup", "--client", "cursor"]);
		expect(r.code).toBe(1);
		expect(r.out).toContain("--yes");
	});

	test("applies, is idempotent, and uninstalls cleanly", () => {
		const home = fakeHome();
		const geminiBefore = readFileSync(
			join(home, ".gemini", "settings.json"),
			"utf8",
		);
		const opencodeBefore = readFileSync(
			join(home, ".config", "opencode", "opencode.jsonc"),
			"utf8",
		);

		const r = run(home, [
			"setup",
			"--yes",
			"--client",
			"cursor,gemini,opencode",
		]);
		expect(r.out).toContain("✓ [cursor]");
		// The mesh stays off and setup says how to turn it on.
		expect(r.out).toContain(
			"The agent mesh is off. `pulsar mesh on` turns it on",
		);
		expect(existsSync(join(home, ".pulsar-state", "settings.json"))).toBe(
			false,
		);

		const cursor = JSON.parse(
			readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(cursor.mcpServers.pulsar.args[1]).toBe("mcp");
		expect(existsSync(cursor.mcpServers.pulsar.args[0])).toBe(true);

		const gemini = JSON.parse(
			readFileSync(join(home, ".gemini", "settings.json"), "utf8"),
		);
		expect(gemini.theme).toBe("dark");
		expect(gemini.mcpServers.pulsar.command).toBeTruthy();

		const opencode = readFileSync(
			join(home, ".config", "opencode", "opencode.jsonc"),
			"utf8",
		);
		expect(opencode).toContain("// keep this comment");
		expect(opencode).toContain('"pulsar"');
		expect(opencode).toContain('"other"');
		expect(
			existsSync(
				join(home, ".config", "opencode", "skills", "pulsar", "SKILL.md"),
			),
		).toBe(true);
		expect(
			readdirSync(join(home, ".gemini")).some((f) =>
				f.startsWith("settings.json.bak-pulsar-"),
			),
		).toBe(true);

		const again = run(home, [
			"setup",
			"--yes",
			"--client",
			"cursor,gemini,opencode",
		]);
		expect(again.out).toContain("✓ [gemini]");
		expect(
			JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"))
				.mcpServers.pulsar,
		).toBeTruthy();

		const un = run(home, ["setup", "--uninstall", "--yes"]);
		expect(un.code).toBe(0);
		expect(
			JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")),
		).toEqual(JSON.parse(geminiBefore));
		expect(
			readFileSync(
				join(home, ".config", "opencode", "opencode.jsonc"),
				"utf8",
			).replace(/\s/g, ""),
		).toBe(opencodeBefore.replace(/\s/g, ""));
		expect(
			JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"))
				.mcpServers?.pulsar,
		).toBeUndefined();
		expect(
			existsSync(join(home, ".config", "opencode", "skills", "pulsar")),
		).toBe(false);
		expect(existsSync(join(home, ".pulsar-install"))).toBe(false);
	}, 60_000);

	test("puts a `pulsar` command in ~/.local/bin, says how to reach it, and uninstall removes it", () => {
		const home = fakeHome();
		const shim = join(home, ".local", "bin", "pulsar");
		const r = run(home, ["setup", "--yes", "--client", "cursor"]);
		expect(r.out).toContain(
			"✓ [pulsar] put the `pulsar` command in ~/.local/bin",
		);
		// PATH here is /usr/bin:/bin: setup says what to add.
		expect(r.out).toContain("~/.local/bin is not on your PATH");
		expect(r.out).toContain('export PATH="$HOME/.local/bin:$PATH"');
		const v = spawnSync(shim, ["--version"], {
			encoding: "utf8",
			env: { PATH: "/usr/bin:/bin", HOME: home },
		});
		expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
		// Doctor flags the PATH, then is happy once it's there.
		const bin = join(home, ".local", "bin");
		expect(run(home, ["doctor"]).out).toContain(
			"✗ ~/.local/bin is not on PATH here",
		);
		expect(
			run(home, ["doctor"], { PATH: `${bin}:/usr/bin:/bin` }).out,
		).toContain("✓ `pulsar` command: ~/.local/bin/pulsar");
		const un = run(home, ["setup", "--uninstall", "--yes"]);
		expect(un.code).toBe(0);
		expect(existsSync(shim)).toBe(false);
	}, 60_000);

	test("an upgrade keeps the version agents still run and the copy setup runs from", () => {
		const home = fakeHome();
		const install = join(home, ".pulsar-install");
		for (const v of ["1.0.0", "1.5.0", "1.9.0"])
			mkdirSync(join(install, v, "dist"), { recursive: true });
		symlinkSync("1.5.0", join(install, "current"));
		// Setup run from an installed copy (a hand-deployed build).
		const self = join(install, "2.0.0-abc1234");
		for (const entry of ["package.json", "dist", "skills"])
			cpSync(join(root, entry), join(self, entry), { recursive: true });
		const r = run(
			home,
			["setup", "--yes", "--client", "cursor"],
			{},
			join(self, "dist", "cli.js"),
		);
		expect(r.code).toBe(0);
		const version = readlinkSync(join(install, "current"));
		expect(readdirSync(install).sort()).toEqual(
			["1.5.0", "2.0.0-abc1234", version, "current"].sort(),
		);
		expect(existsSync(join(self, "dist", "cli.js"))).toBe(true);
		run(home, ["setup", "--uninstall", "--yes"]);
	}, 60_000);

	test("leaves a `pulsar` command it didn't write alone", () => {
		const home = fakeHome();
		const shim = join(home, ".local", "bin", "pulsar");
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		writeFileSync(shim, "#!/bin/sh\necho mine\n");
		const r = run(home, ["setup", "--yes", "--client", "cursor"]);
		expect(r.out).toContain("✗ [pulsar]");
		expect(r.out).toContain("not Pulsar's");
		run(home, ["setup", "--uninstall", "--yes"]);
		expect(readFileSync(shim, "utf8")).toContain("echo mine");
	}, 60_000);

	test("--skills-dir writes one shared skill and --no-mcp skips MCP entries", () => {
		const home = fakeHome();
		const r = run(home, [
			"setup",
			"--yes",
			"--client",
			"cursor,opencode",
			"--no-mcp",
			"--skills-dir",
			join(home, "shared-skills"),
		]);
		expect(r.code).toBe(0);
		expect(existsSync(join(home, "shared-skills", "pulsar", "SKILL.md"))).toBe(
			true,
		);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
		expect(
			existsSync(join(home, ".config", "opencode", "skills", "pulsar")),
		).toBe(false);
	}, 60_000);
});

describe("Claude approvals hook", () => {
	const settings = (home: string) => join(home, ".claude", "settings.json");
	const read = (home: string) =>
		JSON.parse(readFileSync(settings(home), "utf8")) as {
			theme?: string;
			hooks?: Record<
				string,
				{ matcher?: string; hooks: { command: string; timeout?: number }[] }[]
			>;
		};
	const ours = (home: string) =>
		(read(home).hooks?.PermissionRequest ?? []).filter((g) =>
			g.hooks.some((h) => h.command.includes(" hook claude-permission")),
		);

	function claudeHome() {
		const home = mkdtempSync(join(tmpdir(), "pulsar-home-"));
		homes.push(home);
		mkdirSync(join(home, ".claude"));
		writeFileSync(
			settings(home),
			JSON.stringify({
				theme: "dark",
				hooks: {
					PermissionRequest: [
						{
							matcher: "Bash",
							hooks: [{ type: "command", command: "my-own-hook" }],
						},
					],
					Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
				},
			}),
		);
		return home;
	}

	test("with the mesh off, setup adds no hook", () => {
		const home = claudeHome();
		const r = run(home, ["setup", "--yes", "--client", "claude", "--no-mcp"]);
		expect(r.code).toBe(0);
		expect(r.out).not.toContain("[claude-approvals]");
		expect(ours(home).length).toBe(0);
		expect(r.out).toContain("`pulsar mesh on` turns it on");
	}, 60_000);

	test("with the mesh on, setup merges the hook (idempotent); --no-approvals, --uninstall and `mesh off` remove only it", () => {
		const home = claudeHome();
		const args = ["setup", "--yes", "--client", "claude", "--no-mcp"];
		// The mesh on in dev mode: loopback only, no Tailscale or service manager.
		const on = {
			PULSAR_DEV_IDENTITY: "dev@example.com",
			PULSAR_HTTP_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
		};
		const first = run(home, args, on);
		expect(first.code).toBe(0);
		// No passkey enrolled on this machine yet: setup says what that means.
		expect(first.out).toContain(
			"approvals on this machine need a passkey here: open Prove Human in this machine's app",
		);
		expect(run(home, args, on).code).toBe(0);
		const mine = ours(home);
		expect(mine.length).toBe(1);
		expect(mine[0]!.matcher).toBe("*");
		expect(mine[0]!.hooks[0]!.timeout).toBe(3600);
		expect(mine[0]!.hooks[0]!.command).toContain(
			join(home, ".pulsar-install", "current", "dist", "cli.js"),
		);
		const s = read(home);
		expect(s.theme).toBe("dark");
		expect(s.hooks?.PermissionRequest?.[0]?.hooks[0]?.command).toBe(
			"my-own-hook",
		);
		expect(s.hooks?.Stop?.length).toBe(1);

		const doctor = run(home, ["doctor"]);
		// The mesh is off without the env: the hook is there, prompts stay in the terminal.
		expect(doctor.out).toContain(
			"Claude Code approvals: hook installed, but the agent mesh is off",
		);
		// With the app on but no passkey here, doctor says prompts can't be approved yet.
		expect(run(home, ["doctor"], on).out).toContain(
			"Claude Code approvals: approvals on this machine need a passkey here",
		);

		const off = run(home, [...args, "--no-approvals"], on);
		expect(off.out).toContain("remove the PermissionRequest hook");
		expect(ours(home).length).toBe(0);
		expect(read(home).hooks?.PermissionRequest?.length).toBe(1);

		expect(run(home, args, on).code).toBe(0);
		expect(ours(home).length).toBe(1);
		expect(run(home, ["setup", "--uninstall", "--yes"]).code).toBe(0);
		expect(ours(home).length).toBe(0);
		expect(read(home).hooks?.PermissionRequest?.[0]?.hooks[0]?.command).toBe(
			"my-own-hook",
		);
		expect(read(home).hooks?.Stop?.length).toBe(1);

		// Leaving the mesh takes the hook too (and its undo record); agent configs stay.
		expect(run(home, args, on).code).toBe(0);
		expect(ours(home).length).toBe(1);
		const left = run(home, ["mesh", "off"]);
		expect(left.code).toBe(0);
		expect(left.out).toContain("remove the Claude Code approvals hook");
		expect(ours(home).length).toBe(0);
		expect(read(home).hooks?.PermissionRequest?.[0]?.hooks[0]?.command).toBe(
			"my-own-hook",
		);
		expect(
			readFileSync(join(home, ".pulsar-state", "setup.json"), "utf8"),
		).not.toContain("PermissionRequest");
		expect(run(home, ["mesh", "off"]).out).toContain(
			"The agent mesh is already off",
		);

		// Claude Code not selected: no hook.
		expect(
			run(home, ["setup", "--yes", "--client", "cursor", "--no-mcp"], on).code,
		).toBe(0);
		expect(ours(home).length).toBe(0);
	}, 60_000);
});

describe("pulsar mesh, qr and ui with the mesh off", () => {
	test("qr without a terminal and ui fail with the hint; status says off; mesh on refuses in tests", () => {
		const home = mkdtempSync(join(tmpdir(), "pulsar-home-"));
		homes.push(home);
		for (const cmd of ["qr", "ui"]) {
			const r = run(home, [cmd]);
			expect(r.code).toBe(1);
			expect(r.out).toContain("the agent mesh is off; run `pulsar mesh on`");
		}
		const status = run(home, ["mesh"]);
		expect(status.code).toBe(0);
		expect(status.out).toContain("The agent mesh is off.");
		// PULSAR_NO_MESH (set by run): never reaches Tailscale or the service manager.
		const on = run(home, ["mesh", "on", "--yes"]);
		expect(on.code).toBe(1);
		expect(on.out).toContain("PULSAR_NO_MESH");
		expect(run(home, ["mesh", "nope"]).out).toContain(
			'unknown mesh command "nope"',
		);
		expect(run(home, ["mesh", "help"]).out).toContain("pulsar mesh off");
		// The old commands are gone.
		for (const cmd of ["remote", "pool"])
			expect(run(home, [cmd]).out).toContain(`unknown command "${cmd}"`);
	}, 60_000);

	test("mesh on needs the copy setup installs", () => {
		const home = mkdtempSync(join(tmpdir(), "pulsar-home-"));
		homes.push(home);
		const r = run(home, ["mesh", "on", "--yes"], { PULSAR_NO_MESH: "" });
		expect(r.code).toBe(1);
		expect(r.out).toContain("Run `pulsar setup` first");
	});
});
