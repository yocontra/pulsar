import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
} from "node:fs";
import { basename, join } from "node:path";
import { retainedBuilds } from "../paths.ts";

const entries = ["package.json", "dist", "skills", "README.md", "LICENSE"];

function fingerprint(dir: string) {
	const hash = createHash("sha256");
	function visit(rel: string) {
		const path = join(dir, rel);
		const stat = lstatSync(path);
		hash.update(JSON.stringify([rel, stat.mode & 0o111])).update("\0");
		if (stat.isDirectory()) {
			hash.update("d");
			for (const name of readdirSync(path).sort()) visit(join(rel, name));
		} else {
			const link = stat.isSymbolicLink();
			const content = link ? readlinkSync(path) : readFileSync(path);
			hash
				.update(link ? "l" : "f")
				.update(createHash("sha256").update(content).digest());
		}
	}
	for (const name of readdirSync(dir).sort()) visit(name);
	return hash.digest("hex").slice(0, 24);
}

/** Publish a complete immutable build before switching the stable CLI link. */
export async function installBuild(
	source: string,
	root: string,
	version: string,
) {
	if (!existsSync(join(source, "dist", "cli.js")))
		throw new Error(
			`no build found at ${join(source, "dist", "cli.js")}. Run \`bun run build\` first.`,
		);
	mkdirSync(root, { recursive: true });
	const stage = mkdtempSync(join(root, ".setup-"));
	const current = join(root, "current");
	try {
		const copy = join(stage, "package");
		mkdirSync(copy);
		for (const name of entries) {
			const from = join(source, name);
			if (existsSync(from))
				cpSync(from, join(copy, name), {
					recursive: true,
					verbatimSymlinks: true,
				});
		}
		const digest = fingerprint(copy);
		const base = `${version}-${digest}`;
		let build = base;
		for (let attempt = 1; ; attempt++) {
			const target = join(root, build);
			try {
				renameSync(copy, target);
				break;
			} catch (err) {
				if (
					!["ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(
						(err as NodeJS.ErrnoException).code ?? "",
					)
				)
					throw err;
			}
			if (lstatSync(target).isDirectory() && fingerprint(target) === digest) {
				const now = new Date();
				utimesSync(target, now, now);
				break;
			}
			// Repair a damaged install without writing into a running process's build.
			build = `${base}-${attempt}`;
		}
		let previous: string | undefined;
		try {
			previous = readlinkSync(current);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		const link = join(stage, "current");
		symlinkSync(build, link);
		renameSync(link, current);
		const candidates = readdirSync(root).filter((name) => /^\d/.test(name));
		const keep = new Set([
			build,
			previous,
			basename(source),
			...(await retainedBuilds(root)),
		]);
		for (const name of candidates) {
			if (!keep.has(name) && name !== readlinkSync(current))
				rmSync(join(root, name), { recursive: true, force: true });
		}
		return current;
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}
