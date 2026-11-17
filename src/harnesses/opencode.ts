import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { processTable } from "../processes.ts";
import { jsonAction, skillFor } from "../setup/actions.ts";
import { getPath, readJsonc } from "../setup/files.ts";
import { run, runJson, which } from "../util.ts";
import type { HarnessDriver, Scanned } from "./types.ts";

/** `_meta` key OpenCode uses to say which of its sessions made a tool call. */
const SESSION_KEY = "ai.opencode/sessionID";

/** True when OpenCode's shared background server is running (never starts one). */
function opencodeServiceRunning(table = processTable()): boolean {
	for (const p of table.values())
		if (/opencode(\S*)? serve\b.*--service/.test(p.args)) return true;
	return false;
}

/** The folder an OpenCode session works in, from its server. */
function opencodeSessionDir(sessionId: string): string | null {
	if (!opencodeServiceRunning()) return null;
	try {
		const out = execFileSync(
			"opencode",
			["api", "GET", `/api/session/${sessionId}`],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 5000,
			},
		);
		type Info = { directory?: string; location?: { directory?: string } };
		const raw = JSON.parse(out) as Info & { data?: Info };
		const info = raw.data ?? raw;
		return info.location?.directory ?? info.directory ?? null;
	} catch {
		return null;
	}
}

/** A session's messages from its local server, newest first; [] when unavailable. */
async function opencodeMessages(sessionId: string): Promise<unknown[]> {
	if (!opencodeServiceRunning()) return [];
	const raw = (await runJson(
		"opencode",
		["api", "GET", `/api/session/${sessionId}/message`],
		{
			maxBuffer: 32 * 1024 * 1024,
		},
	)) as { data?: unknown[] } | unknown[] | null;
	const list = Array.isArray(raw) ? raw : raw?.data;
	return Array.isArray(list) ? list : [];
}

/** OpenCode sessions that are running right now, from its shared server. */
async function scanOpencode(): Promise<Scanned[]> {
	// `opencode api` starts a service when none runs; only look when one already does.
	if (!opencodeServiceRunning()) return [];
	// The server wraps results: {"data": {"ses_…": {"type": "running"}}}.
	const raw = (await runJson("opencode", ["api", "session.active"])) as {
		data?: Record<string, { type?: string }>;
	} | null;
	const active = raw?.data ?? null;
	if (!active || typeof active !== "object") return [];
	const out: Scanned[] = [];
	for (const [id, state] of Object.entries(active)) {
		type SessionInfo = {
			directory?: string;
			location?: { directory?: string };
			title?: string;
			parentID?: string | null;
			model?: { id?: string };
		};
		const got = (await runJson("opencode", [
			"api",
			"GET",
			`/api/session/${id}`,
		])) as (SessionInfo & { data?: SessionInfo }) | null;
		const info = got?.data ?? got;
		if (info?.parentID) continue;
		out.push({
			harness: opencode.id,
			sessionId: id,
			pid: null,
			cwd: info?.location?.directory ?? info?.directory ?? null,
			status: state?.type === "running" ? "busy" : "idle",
			model: info?.model?.id ?? null,
			meta: info?.title ? { title: info.title } : {},
		});
	}
	return out;
}

function opencodeConfig(): string {
	const dir = join(homedir(), ".config", "opencode");
	const jsonc = join(dir, "opencode.jsonc");
	return existsSync(jsonc) || !existsSync(join(dir, "opencode.json"))
		? jsonc
		: join(dir, "opencode.json");
}

export const opencode: HarnessDriver = {
	id: "opencode",
	label: "OpenCode",

	matchProcess(args) {
		const exe = basename(args.split(/\s+/)[0] ?? "").toLowerCase();
		return exe === "opencode" || exe.startsWith("opencode-");
	},

	identify({ sessionId, env }) {
		return { sessionId: sessionId ?? env.OPENCODE_SESSION_ID ?? null };
	},

	// One MCP process serves every OpenCode session and names it in `_meta`.
	toolSessions: {
		sessionId(meta) {
			const id = meta?.[SESSION_KEY];
			return typeof id === "string" && id ? id : null;
		},
		cwd: opencodeSessionDir,
	},

	scan: { intervalMs: 20_000, sessions: scanOpencode },

	push: {
		canPush(agent) {
			return agent.harness === opencode.id && !!agent.sessionId;
		},
		async deliver(agent, text, priority) {
			if (!opencodeServiceRunning())
				return {
					ok: false,
					via: "opencode-api",
					detail: "OpenCode service is not running",
				};
			const body = JSON.stringify({
				text,
				delivery: priority === "urgent" ? "steer" : "queue",
				resume: true,
			});
			try {
				await run("opencode", [
					"api",
					"POST",
					`/api/session/${agent.sessionId}/prompt`,
					"-d",
					body,
				]);
				return { ok: true, via: "opencode-api" };
			} catch (e) {
				return { ok: false, via: "opencode-api", detail: (e as Error).message };
			}
		},
	},

	/** The model of the session's newest assistant message. */
	async model(agent) {
		if (!agent.sessionId) return null;
		for (const m of (await opencodeMessages(agent.sessionId)) as Array<{
			type?: string;
			model?: { id?: string };
		}>) {
			if (m.type === "assistant" && m.model?.id) return m.model.id;
		}
		return null;
	},

	async sessionLog(agent) {
		if (!agent.sessionId) return "";
		return JSON.stringify(
			(await opencodeMessages(agent.sessionId)).slice(0, 50),
		);
	},

	setup: {
		detect: () =>
			!!which("opencode") || existsSync(join(homedir(), ".config", "opencode")),
		configured: () => {
			const cfg = readJsonc(opencodeConfig());
			return !!(
				getPath(cfg, ["mcp", "servers", "pulsar"]) ??
				getPath(cfg, ["mcp", "pulsar"])
			);
		},
		plan: (ctx) => {
			const file = opencodeConfig();
			const cfg = readJsonc(file);
			const mcp = getPath(cfg, ["mcp"]) as Record<string, unknown> | undefined;
			// OpenCode 2 nests servers under mcp.servers; older configs put them right under mcp.
			const path =
				!mcp || "servers" in mcp
					? ["mcp", "servers", "pulsar"]
					: ["mcp", "pulsar"];
			return [
				...(ctx.mcp
					? [
							jsonAction("opencode", file, path, {
								type: "local",
								command: [ctx.node, ctx.cli, "mcp"],
								enabled: true,
							}),
						]
					: []),
				...skillFor(
					"opencode",
					join(homedir(), ".config", "opencode", "skills"),
					ctx,
				),
			];
		},
	},
};
