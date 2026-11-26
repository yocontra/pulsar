import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../src/paths.ts";
import { installBuild } from "../src/setup/build.ts";

test("same-version setup keeps running code intact and only switches complete builds", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "p-build-"));
	const source = join(tmp, "pkg");
	const dist = join(source, "dist");
	const root = join(tmp, "install");
	const current = join(root, "current");
	const server = createServer();
	try {
		mkdirSync(dist, { recursive: true });
		const cli = join(dist, "cli.js");
		writeFileSync(cli, "first build");
		await installBuild(source, root, "1.0.0");
		const first = readlinkSync(current);
		await installBuild(source, root, "1.0.0");
		expect(readlinkSync(current)).toBe(first);
		writeFileSync(cli, "second build");
		// A socket cannot be copied. Even after cli.js was staged, the active
		// tree must remain complete and the staging directory must be removed.
		await new Promise<void>((done) =>
			server.listen(join(dist, "socket"), done),
		);
		await expect(installBuild(source, root, "1.0.0")).rejects.toThrow();
		expect(readFileSync(join(current, "dist", "cli.js"), "utf8")).toBe(
			"first build",
		);
		expect(readdirSync(root).sort()).toEqual([first, "current"]);
		await new Promise<void>((done) => server.close(() => done()));
		await Promise.all([
			installBuild(source, root, "1.0.0"),
			installBuild(source, root, "1.0.0"),
		]);
		expect(readFileSync(join(current, "dist", "cli.js"), "utf8")).toBe(
			"second build",
		);
		expect(readFileSync(join(root, first, "dist", "cli.js"), "utf8")).toBe(
			"first build",
		);
		expect(readdirSync(root)).toHaveLength(3);
		const damaged = readlinkSync(current);
		rmSync(join(current, "dist", "cli.js"));
		await installBuild(source, root, "1.0.0");
		expect(readlinkSync(current)).not.toBe(damaged);
		expect(readFileSync(join(current, "dist", "cli.js"), "utf8")).toBe(
			"second build",
		);
	} finally {
		if (server.listening)
			await new Promise<void>((done) => server.close(() => done()));
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("a state directory removed between uses is recreated with private permissions", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "p-state-"));
	const dir = join(tmp, "state");
	try {
		await ensureDir(dir);
		rmSync(dir, { recursive: true });
		await Promise.all([ensureDir(dir), ensureDir(dir)]);
		expect(existsSync(dir)).toBe(true);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
