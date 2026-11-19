import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Temp repos only, never the user's git config. */
export const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};

const roots: string[] = [];

/** A fresh temp folder, removed by `cleanupRepos`. */
export function tmpFolder(): string {
	const d = mkdtempSync(join(tmpdir(), "pulsar-changes-"));
	roots.push(d);
	return d;
}

export function cleanupRepos() {
	for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Runs git in a temp repo (no signing, `main` as the first branch). */
export function g(dir: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
		{ cwd: dir, env: GIT_ENV, encoding: "utf8" },
	);
}

/** A repo with one commit: a.txt, gone.txt, "old name.txt", .gitignore, bin.dat. */
export function gitRepo(): string {
	const d = tmpFolder();
	g(d, "init", "-q");
	writeFileSync(join(d, "a.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(d, "gone.txt"), "bye\n");
	writeFileSync(join(d, "old name.txt"), "rename me\nplease\n");
	writeFileSync(join(d, ".gitignore"), "secret.env\nignored/\n");
	writeFileSync(join(d, "bin.dat"), Buffer.from([0, 1, 2, 3]));
	g(d, "add", "-A");
	g(d, "commit", "-q", "-m", "init");
	return d;
}
