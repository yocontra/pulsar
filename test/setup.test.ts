import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const cli = join(root, "dist", "cli.js");
// Absolute node path: the child gets a bare PATH so real harness CLIs are not found.
const node = execFileSync("node", ["-p", "process.execPath"], {
	encoding: "utf8",
}).trim();

/** Runs the built CLI with a fake HOME, so real agent configs are never touched. */
function run(home: string, args: string[]) {
	const r = spawnSync(node, [cli, ...args], {
		encoding: "utf8",
		env: {
			PATH: "/usr/bin:/bin",
			HOME: home,
			PULSAR_HOME: join(home, ".pulsar-state"),
			PULSAR_INSTALL_ROOT: join(home, ".pulsar-install"),
		},
		timeout: 60_000,
	});
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function fakeHome() {
	const home = mkdtempSync(join(tmpdir(), "pulsar-home-"));
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

beforeAll(() => {
	if (!existsSync(cli))
		execFileSync("bun", ["run", "build"], { cwd: root, stdio: "ignore" });
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
