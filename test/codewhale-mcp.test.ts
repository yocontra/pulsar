import { expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codewhaleMcpConfig } from "../src/harnesses/codewhale-mcp.ts";

test("CodeWhale MCP snapshots preserve user settings and isolate each launch", async () => {
	const root = await mkdtemp(join(tmpdir(), "pulsar-whale-"));
	try {
		const cwd = join(root, "project"),
			binary = join(root, "codewhale"),
			globalDir = join(root, ".codewhale");
		for (const dir of [
			cwd,
			globalDir,
			join(cwd, ".codewhale"),
			join(root, "first"),
			join(root, "second"),
		])
			await mkdir(dir);
		await writeFile(
			binary,
			"#!/bin/sh\necho 'error: key not found: mcp_config_path' >&2\nexit 1\n",
		);
		await chmod(binary, 0o700);
		const configured = {
			command: "node",
			args: ["./custom.js"],
			cwd: "./tools",
			always_allow_tools: ["read"],
		};
		const source = JSON.stringify({
			mcpServers: { pulsar: configured },
			delegated_operations: { pulsar: { read: { effect: "read" } } },
			timeouts: { connect_timeout_ms: 100 },
		});
		await writeFile(join(globalDir, "mcp.json"), source);
		await writeFile(
			join(cwd, ".codewhale", "mcp.json"),
			JSON.stringify({ servers: { unreviewed: { command: "other" } } }),
		);
		const snapshot = async (workspace: string, dir: string) => {
			const mcp = {
				name: "pulsar",
				command: "bun",
				args: ["cli", "mcp"],
				env: [{ name: "PULSAR_ACP_IDENTITY", value: dir }],
			};
			const path = await codewhaleMcpConfig(
				binary,
				workspace,
				{ HOME: root },
				join(root, dir),
				mcp,
			);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			return JSON.parse(await readFile(path, "utf8"));
		};
		const [one, two] = await Promise.all([
			snapshot(cwd, "first"),
			snapshot(root, "second"),
		]);
		expect(one).toMatchObject({
			mcpServers: {
				pulsar: configured,
				pulsar_1: { env: { PULSAR_ACP_IDENTITY: "first" } },
			},
			delegated_operations: { pulsar: { read: { effect: "read" } } },
			timeouts: { connect_timeout_ms: 100 },
		});
		expect(two.mcpServers.pulsar_1.env.PULSAR_ACP_IDENTITY).toBe("second");
		expect(two.mcpServers.pulsar).toEqual(configured);
		expect(two.delegated_operations).toBeUndefined();
		expect(one.mcpServers.unreviewed).toBeUndefined();
		expect(await readFile(join(globalDir, "mcp.json"), "utf8")).toBe(source);
		await writeFile(join(globalDir, "mcp.json"), "{broken");
		await expect(snapshot(cwd, "first")).rejects.toThrow(
			"Invalid CodeWhale MCP JSON",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
