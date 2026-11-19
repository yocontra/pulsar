import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

/** Marks a `pulsar` command setup wrote, so nothing else is ever overwritten or removed. */
const SHIM_MARKER = "# pulsar shim: written by `pulsar setup`";

/** Where the `pulsar` command goes: ~/.local/bin (XDG; on PATH on most Linux desktops). */
export function binDir(home = homedir()): string {
	return join(home, ".local", "bin");
}

export function shimPath(home = homedir()): string {
	return join(binDir(home), "pulsar");
}

/** A two-line sh wrapper: the node setup ran with, the stable copy's CLI. */
export function shimScript(node: string, cli: string): string {
	return `#!/bin/sh\n${SHIM_MARKER}\nexec ${sq(node)} ${sq(cli)} "$@"\n`;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Whether `path` holds a shim setup wrote (or nothing at all). */
export function ownsShim(path: string): boolean {
	if (!existsSync(path)) return true;
	try {
		return readFileSync(path, "utf8").includes(SHIM_MARKER);
	} catch {
		return false;
	}
}

/**
 * Writes the shim. Refuses to replace a `pulsar` command it didn't write
 * (a global npm install, the user's own script).
 */
export function writeShim(node: string, cli: string, home = homedir()) {
	const path = shimPath(home);
	if (!ownsShim(path))
		throw new Error(`${path} exists and is not Pulsar's; left it alone`);
	mkdirSync(binDir(home), { recursive: true });
	writeFileSync(path, shimScript(node, cli));
	chmodSync(path, 0o755);
}

/** Removes the shim, only if setup wrote it. */
export function removeShim(path: string) {
	if (existsSync(path) && ownsShim(path)) rmSync(path, { force: true });
}

/** Whether `dir` is on `PATH` (ignoring a trailing slash). */
export function onPath(dir: string, path = process.env.PATH ?? ""): boolean {
	const want = dir.replace(/\/+$/, "");
	return path.split(delimiter).some((p) => p.replace(/\/+$/, "") === want);
}

/**
 * The exact command that puts ~/.local/bin on PATH for the user's login
 * shell, and the file it changes. `shell`: $SHELL.
 */
export function pathHint(
	shell = process.env.SHELL ?? "",
	platform = process.platform,
): { command: string; file: string } {
	const name = basename(shell);
	if (name === "fish")
		return {
			command: "fish_add_path ~/.local/bin",
			file: "~/.config/fish (universal variable)",
		};
	const line = `export PATH="$HOME/.local/bin:$PATH"`;
	if (name === "bash") {
		// macOS Terminal opens login shells, which read ~/.bash_profile.
		const file = platform === "darwin" ? "~/.bash_profile" : "~/.bashrc";
		return { command: `echo '${line}' >> ${file}`, file };
	}
	if (name === "zsh" || platform === "darwin")
		return { command: `echo '${line}' >> ~/.zshrc`, file: "~/.zshrc" };
	return { command: `echo '${line}' >> ~/.profile`, file: "~/.profile" };
}

/**
 * Debian and Ubuntu's ~/.profile puts ~/.local/bin on PATH at login once
 * the folder exists: then a new login is all it takes.
 */
function profileAddsBin(home = homedir()): boolean {
	try {
		return readFileSync(join(home, ".profile"), "utf8").includes(".local/bin");
	} catch {
		return false;
	}
}

/** What to tell the user when ~/.local/bin is not on this PATH. */
export function pathAdvice(home = homedir()): string {
	if (profileAddsBin(home))
		return "~/.profile adds it at login: open a new login shell (or log in again)";
	const hint = pathHint();
	return `add it (${hint.file}), then open a new terminal:\n    ${hint.command}`;
}

/** The first executable `pulsar` on PATH, or null. */
function resolveOnPath(
	name = "pulsar",
	path = process.env.PATH ?? "",
): string | null {
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		const file = join(dir, name);
		try {
			accessSync(file, constants.X_OK);
			return file;
		} catch {}
	}
	return null;
}

/** The node and CLI a shim setup wrote runs, or null. */
export function shimTarget(path: string): { node: string; cli: string } | null {
	try {
		const m = /^exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' "\$@"$/m.exec(
			readFileSync(path, "utf8"),
		);
		if (!m) return null;
		const un = (s: string) => s.replace(/'\\''/g, "'");
		return { node: un(m[1]!), cli: un(m[2]!) };
	} catch {
		return null;
	}
}

/**
 * Doctor's view of the `pulsar` command: ok, or what is wrong and the fix.
 */
export function shimStatus(home = homedir()): { ok: boolean; message: string } {
	const path = shimPath(home);
	const resolved = resolveOnPath();
	const ours = existsSync(path) && ownsShim(path);
	if (!ours)
		return resolved
			? { ok: true, message: `\`pulsar\` command: ${tildeOf(resolved, home)}` }
			: {
					ok: false,
					message:
						"no `pulsar` command on PATH: run `npx pulsar setup` to add one",
				};
	const target = shimTarget(path);
	if (!target || !existsSync(target.node) || !existsSync(target.cli))
		return {
			ok: false,
			message: `${tildeOf(path, home)} points at a node or pulsar copy that is gone: run \`npx pulsar setup\` again`,
		};
	if (!onPath(binDir(home)))
		return {
			ok: profileAddsBin(home),
			message: `${tildeOf(binDir(home), home)} is not on PATH here, so \`pulsar\` won't run yet: ${pathAdvice(home).replace(/\n\s+/, " ")}`,
		};
	if (resolved && resolved !== path)
		return {
			ok: true,
			message: `\`pulsar\` command: ${tildeOf(resolved, home)} comes first on PATH (setup's is ${tildeOf(path, home)})`,
		};
	return { ok: true, message: `\`pulsar\` command: ${tildeOf(path, home)}` };
}

const tildeOf = (p: string, home: string) =>
	p.startsWith(home) ? `~${p.slice(home.length)}` : p;
