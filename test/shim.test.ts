import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	onPath,
	ownsShim,
	pathAdvice,
	pathHint,
	removeShim,
	shimPath,
	shimScript,
	shimTarget,
	writeShim,
} from "../src/setup/shim.ts";

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "pulsar-shim-"));
	dirs.push(d);
	return d;
};
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("the pulsar command (shim)", () => {
	test("runs the stable copy with the given node, and round-trips odd paths", () => {
		const home = tmp();
		const cli = join(home, "it's here", "cli.js");
		mkdirSync(join(home, "it's here"));
		writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)))");
		writeShim(process.execPath, cli, home);
		const path = shimPath(home);
		expect(statSync(path).mode & 0o111).toBeTruthy();
		expect(shimTarget(path)).toEqual({ node: process.execPath, cli });
		const out = execFileSync(path, ["ls", "a b"], { encoding: "utf8" });
		expect(JSON.parse(out)).toEqual(["ls", "a b"]);
		// Idempotent, and removable.
		writeShim(process.execPath, cli, home);
		removeShim(path);
		expect(() => statSync(path)).toThrow();
	});

	test("never overwrites or removes a pulsar command it didn't write", () => {
		const home = tmp();
		const path = shimPath(home);
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		writeFileSync(path, "#!/bin/sh\necho mine\n");
		expect(ownsShim(path)).toBe(false);
		expect(() => writeShim(process.execPath, "/x/cli.js", home)).toThrow(
			/not Pulsar's/,
		);
		removeShim(path);
		expect(readFileSync(path, "utf8")).toContain("echo mine");
		expect(shimScript("/n", "/c")).toContain("exec '/n' '/c' \"$@\"");
	});

	test("PATH check and the line to add per shell", () => {
		expect(onPath("/h/.local/bin", "/usr/bin:/h/.local/bin/")).toBe(true);
		expect(onPath("/h/.local/bin", "/usr/bin:/bin")).toBe(false);
		expect(pathHint("/bin/zsh", "darwin")).toEqual({
			command: `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`,
			file: "~/.zshrc",
		});
		expect(pathHint("/bin/bash", "darwin").file).toBe("~/.bash_profile");
		expect(pathHint("/usr/bin/bash", "linux").file).toBe("~/.bashrc");
		expect(pathHint("/usr/bin/fish", "linux").command).toBe(
			"fish_add_path ~/.local/bin",
		);
		expect(pathHint("", "linux").file).toBe("~/.profile");
	});

	test("a ~/.profile that adds ~/.local/bin at login: just log in again", () => {
		const home = tmp();
		expect(pathAdvice(home)).toContain("export PATH");
		writeFileSync(
			join(home, ".profile"),
			'if [ -d "$HOME/.local/bin" ] ; then\n    PATH="$HOME/.local/bin:$PATH"\nfi\n',
		);
		expect(pathAdvice(home)).toContain("new login shell");
	});
});
