import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import { exec } from "../exec.ts";

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function globalConfig(
	binary: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
) {
	const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
	if (!isAbsolute(home))
		throw new Error("CodeWhale user home must be absolute.");
	const configuredPath = (value: unknown) => {
		if (typeof value !== "string") return;
		if (value.split(/[/\\]/).includes(".."))
			throw new Error("CodeWhale MCP configuration paths cannot contain '..'.");
		const path = /^~(?:[/\\]|$)/.test(value)
			? join(home, value.slice(1))
			: value;
		return isAbsolute(path) ? path : undefined;
	};
	const override = env.CODEWHALE_MCP_CONFIG ?? env.DEEPSEEK_MCP_CONFIG;
	const explicit = configuredPath(override);
	if (explicit) return explicit;
	// Let CodeWhale resolve its profile, managed settings and TOML syntax.
	const result = await exec(binary, ["config", "get", "mcp_config_path"], {
		cwd,
		env,
	});
	if (result.ok) {
		const path = configuredPath(JSON.parse(result.stdout.trim()));
		if (path) return path;
	} else if (!result.stderr?.includes("key not found: mcp_config_path")) {
		throw new Error(
			"Could not resolve the user MCP configuration with CodeWhale.",
		);
	}
	const overrideHome = env.CODEWHALE_HOME?.trim();
	if (overrideHome) {
		const path = configuredPath(overrideHome);
		if (!path) throw new Error("CodeWhale home must be an absolute path.");
		return join(path, "mcp.json");
	}
	const path = join(home, ".codewhale", "mcp.json");
	try {
		await access(path);
		return path;
	} catch (error) {
		if (!missing(error)) throw error;
	}
	return join(home, ".deepseek", "mcp.json");
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** CodeWhale rejects client-supplied ACP servers; its process reads this private
 * global config snapshot. It still applies its own trust checks to project MCP.
 */
export async function codewhaleMcpConfig(
	binary: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	directory: string,
	mcp: McpServerStdio,
): Promise<string> {
	const original = await globalConfig(binary, cwd, env);
	let config: Record<string, unknown> = {};
	try {
		const path = await realpath(original);
		const project = await realpath(cwd);
		const raw = await readFile(path, "utf8");
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new Error(`Invalid CodeWhale MCP JSON in ${original}`);
		}
		if (!object(value))
			throw new Error(`Invalid CodeWhale MCP configuration in ${original}`);
		config = value;
		// CodeWhale clears delegated authority when the selected global file is
		// inside the workspace, even when the workspace is the user's home.
		const fromProject = relative(project, path);
		if (fromProject.split(/[\\/]/)[0] !== ".." && !isAbsolute(fromProject))
			delete config.delegated_operations;
	} catch (error) {
		if (!missing(error)) throw error;
	}
	const key = Object.hasOwn(config, "mcpServers") ? "mcpServers" : "servers";
	const servers = Object.hasOwn(config, key) ? config[key] : {};
	if (
		!object(servers) ||
		(key === "mcpServers" && Object.hasOwn(config, "servers"))
	) {
		throw new Error(`Invalid CodeWhale MCP server list in ${original}`);
	}
	// Keep other configured servers and their permissions. If the user has
	// a server named pulsar, leave it intact and give this session its own name.
	let name = mcp.name;
	for (let index = 1; Object.hasOwn(servers, name); index++)
		name = `${mcp.name}_${index}`;
	config[key] = {
		...servers,
		[name]: {
			command: mcp.command,
			args: mcp.args,
			env: Object.fromEntries(mcp.env.map(({ name, value }) => [name, value])),
		},
	};
	const path = join(directory, "mcp.json");
	await writeFile(path, JSON.stringify(config), { mode: 0o600, flag: "wx" });
	return path;
}
