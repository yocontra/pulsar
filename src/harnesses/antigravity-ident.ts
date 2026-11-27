import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { exec } from "../exec.ts";
import { currentCli } from "../paths.ts";
import type { ProcessInfo } from "../processes.ts";
import { tailAsync } from "../util.ts";
import type { HarnessIdent } from "./types.ts";

export const ANTIGRAVITY_SESSION_ID =
	/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function antigravityConversations(home = process.env.HOME || homedir()) {
	return join(home, ".gemini", "antigravity-cli", "conversations");
}

/** lsof can report several open history databases. Only bind an unambiguous one. */
export function antigravityFiles(output: string, directory: string) {
	let fd = "";
	let cwd: string | null = null;
	const sessions = new Set<string>();
	const logs = new Set<string>();
	const presence = new Set<string>();
	const presenceDir = join(dirname(directory), "presence");
	for (const line of output.split("\n")) {
		if (line.startsWith("f")) fd = line.slice(1);
		if (!line.startsWith("n/")) continue;
		const path = line.slice(1);
		if (fd === "cwd") cwd = path;
		if (
			(fd === "1" || fd === "2") &&
			dirname(path) === join(dirname(directory), "log") &&
			/^cli-\d{8}_\d{6}\.log$/.test(basename(path))
		)
			logs.add(path);
		if (!/^\d+$/.test(fd)) continue;
		if (dirname(path) === presenceDir && path.endsWith(".lock")) {
			const id = basename(path, ".lock");
			if (ANTIGRAVITY_SESSION_ID.test(id)) presence.add(id);
		}
		if (dirname(path) !== directory) continue;
		const id = basename(path, ".db");
		if (path.endsWith(".db") && ANTIGRAVITY_SESSION_ID.test(id))
			sessions.add(id);
	}
	return {
		cwd,
		sessions: [...sessions],
		presence: [...presence],
		log: logs.size === 1 ? [...logs][0]! : null,
	};
}

export async function antigravityProcess(pid: number | null) {
	if (!pid || process.platform === "win32")
		return { cwd: null, sessionId: null };
	const result = await exec(
		"lsof",
		["-n", "-P", "-w", "-Ffn", "-p", String(pid)],
		{
			timeoutMs: 3000,
			maxBuffer: 4 * 1024 * 1024,
			lane: "background",
		},
	);
	// lsof uses canonical paths even when HOME points through a symlink.
	const directory = antigravityConversations();
	const canonical = await realpath(dirname(directory)).catch(() =>
		dirname(directory),
	);
	return antigravitySession(
		result.stdout,
		join(canonical, basename(directory)),
	);
}

export async function antigravitySession(
	descriptors: string,
	directory: string,
) {
	const { cwd, sessions, log, presence } = antigravityFiles(
		descriptors,
		directory,
	);
	// The CLI holds the active conversation's lock even when it opens a child's
	// database or subscribes to that child's updates in the same process.
	if (presence.length)
		return { cwd, sessionId: presence.length === 1 ? presence[0]! : null };
	const hint =
		log &&
		antigravityActiveConversation(
			await tailAsync(log, 512 * 1024).catch(() => ""),
		);
	if (hint) {
		if (sessions.length)
			return { cwd, sessionId: sessions.includes(hint) ? hint : null };
		// Idle CLI sessions can close every database but keep their own log open.
		const file = await lstat(join(directory, `${hint}.db`)).catch(() => null);
		return { cwd, sessionId: file?.isFile() ? hint : null };
	}
	return { cwd, sessionId: sessions.length === 1 ? sessions[0]! : null };
}

export function antigravityActiveConversation(log: string) {
	let id: string | null = null;
	for (const line of log.split("\n")) {
		const match =
			/^[I]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+server\.go:\d+\] Starting conversation update stream for ([0-9a-f-]+)\s*$/i.exec(
				line,
			);
		if (match?.[1] && ANTIGRAVITY_SESSION_ID.test(match[1])) id = match[1];
	}
	return id;
}

/** Only interactive and print sessions own a native conversation. */
export function nativeAntigravityProcess(args: string) {
	if (!antigravityIdent.matchProcess(args)) return false;
	const first = args.trim().split(/\s+/, 2)[1];
	return (
		!first ||
		!/^(?:acp|agentapi|agents?|changelog|help|install|mcp|mic-serve|models|plugins?|remote-control|update|--help|-h|--version)$/.test(
			first,
		)
	);
}

export const antigravityIdent: HarnessIdent = {
	id: "antigravity",
	label: "Google Antigravity",
	matchProcess: (args) =>
		/(?:^|\/)agy(?=\s|$)/.test(args.split(/\s/, 1)[0] ?? ""),
	async onSessionReady({ sessionId }) {
		if (
			!sessionId ||
			process.env.ANTIGRAVITY_CONVERSATION_ID !== sessionId ||
			!process.env.ANTIGRAVITY_LS_ADDRESS
		)
			return;
		const { startNativeWake } = await import("../native-wake.ts");
		await startNativeWake("antigravity", sessionId);
	},
	async identify({ pid, sessionId, cwd }) {
		const found = await antigravityProcess(pid);
		return { sessionId: sessionId ?? found.sessionId, cwd: found.cwd ?? cwd };
	},
	lateSession: {
		async find(registration, exclude) {
			const { sessionId } = await antigravityProcess(registration.pid);
			return sessionId && !exclude.has(sessionId) ? sessionId : null;
		},
		async adopt(registration, sessionId) {
			registration.sessionId = sessionId;
		},
	},
};

/** A legacy MCP registered without a host PID. Its generation names the MCP client. */
export function legacyMcpGeneration(generation: string | undefined) {
	const match = /^(\d{1,9})\.([0-9a-z]{6,12})$/.exec(generation ?? "");
	const pid = Number(match?.[1]);
	const time = Number.parseInt(match?.[2] ?? "", 36);
	return pid > 1 && Number.isSafeInteger(time) ? { pid, time } : null;
}

export function legacyMcpMatchesBirth(generationTime: number, birth: number) {
	return (
		Number.isFinite(birth) &&
		generationTime >= birth &&
		generationTime - birth <= 30_000
	);
}

export async function antigravityMcpHost(
	generation: string | undefined,
	cwd: string,
	table: ReadonlyMap<number, ProcessInfo>,
) {
	const parsed = legacyMcpGeneration(generation);
	if (!parsed) return null;
	const child = table.get(parsed.pid);
	const command = child?.args.trim() ?? "";
	const newline = command.indexOf(" ");
	if (
		newline < 0 ||
		!/^(?:node|bun)(?:\.exe)?$/.test(basename(command.slice(0, newline)))
	)
		return null;
	if (command.slice(newline + 1) !== `${currentCli()} mcp`) return null;
	let parent = child;
	for (let depth = 0; depth < 16 && parent; depth++) {
		parent = table.get(parent.ppid);
		if (!parent || !antigravityIdent.matchProcess(parent.args)) continue;
		const [birth, actual] = await Promise.all([
			exec("ps", ["-p", String(parsed.pid), "-o", "lstart="], {
				timeoutMs: 1000,
				maxBuffer: 1024,
				lane: "background",
				env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
			}),
			antigravityProcess(parsed.pid),
		]);
		if (
			actual.cwd !== cwd ||
			!birth.ok ||
			!legacyMcpMatchesBirth(
				parsed.time,
				Date.parse(`${birth.stdout.trim()} UTC`),
			)
		)
			return null;
		return parent.pid;
	}
	return null;
}
