/**
 * Read-only check: do the agents a pulsar daemon lists match the harness
 * processes running on this Mac?
 *
 *   bun scripts/live/verify-agents.ts [base-url] [--json] [--scanned-only]
 *
 * `base-url` defaults to $PULSAR_URL, else https://<this machine>:7337. It
 * only reads: `ps`, `lsof` (working folders), session files and logs, the
 * OpenCode service's HTTP API (GETs, only when the service already runs),
 * and the daemon's `GET /api/v1/agents`. It never runs `opencode api` (that
 * starts a service when none runs), never messages or stops an agent.
 *
 * Prints one line per harness process with its activity signals, then every
 * mismatch:
 *
 * - missing: a live session no agent shows
 * - duplicate: two live agents for one process (Claude, omp, pi)
 * - stale-session: an agent for a Claude session its process left (/resume, /clear)
 * - ghost: an agent whose process is gone
 * - stale-busy: busy, but the process is quiet (low CPU, log untouched for 10 min)
 * - idle-while-writing: idle, but the session log was written in the last 20 s
 * - status: Claude's own session record disagrees with the agent's status
 *
 * `--scanned-only` checks only Claude and OpenCode, the harnesses the daemon
 * finds by scanning; omp, pi, Codex, Cursor and Gemini appear only once they
 * connect (for a scratch daemon of a new build that no agent connects to).
 *
 * Exit code 1 when there is a mismatch.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { piSessionFile } from "../../src/harnesses/pi-sessions.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
/** Only harnesses the daemon scans itself (a scratch daemon nobody connects to). */
const scannedOnly = args.includes("--scanned-only");
const base = (
	args.find((a) => !a.startsWith("--")) ??
	process.env.PULSAR_URL ??
	`https://${hostname().replace(/\.local$/, "")}.taile9c930.ts.net:7337`
).replace(/\/$/, "");
const HOME = homedir();
const NOW = Date.now();
const QUIET_MS = 10 * 60_000;
const WRITING_MS = 20_000;

type Harness =
	| "claude"
	| "codex"
	| "codex-app-server"
	| "omp"
	| "pi"
	| "opencode"
	| "opencode-serve"
	| "cursor"
	| "gemini";

interface Proc {
	pid: number;
	ppid: number;
	cpu: number;
	etime: string;
	args: string;
}

interface Row {
	harness: Harness;
	pid: number;
	cpu: number;
	cwd: string | null;
	session: string | null;
	/** Status the harness itself reports (Claude's session record). */
	reported: string | null;
	/** Last write of the session log, ms. */
	logAt: number | null;
	note?: string;
}

interface AgentRow {
	id: string;
	name: string;
	harness: string;
	sessionId: string | null;
	pid: number | null;
	cwd: string | null;
	status: string;
	state: string;
	stateSince: number;
}

// ---- processes ----

function processes(): Proc[] {
	const out = execFileSync("ps", ["-axo", "pid=,ppid=,pcpu=,etime=,args="], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return out
		.split("\n")
		.map((l) => /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(l))
		.filter((m): m is RegExpExecArray => !!m)
		.map((m) => ({
			pid: Number(m[1]),
			ppid: Number(m[2]),
			cpu: Number(m[3]),
			etime: m[4]!,
			args: m[5]!,
		}));
}

function classify(p: Proc): Harness | null {
	// App bundles (Codex Computer Use) have spaces in their path: not a CLI.
	if (/\.app\//.test(p.args.split(" -")[0] ?? "")) return null;
	const argv = p.args.split(/\s+/);
	const exe = basename(argv[0] ?? "").toLowerCase();
	const sub = argv[1] ?? "";
	if (exe === "claude" || /\/claude\/versions\//.test(argv[0] ?? ""))
		return "claude";
	if (exe === "codex") {
		if (sub === "app-server")
			return argv.includes("daemon") ? null : "codex-app-server";
		if (["mcp", "mcp-server", "exec", "login", "proto"].includes(sub))
			return null;
		return "codex";
	}
	if (exe === "opencode" || exe.startsWith("opencode-")) {
		if (sub === "serve") return "opencode-serve";
		if (["api", "mcp", "run", "auth", "models", "upgrade"].includes(sub))
			return null;
		return "opencode";
	}
	if (
		/(^|\/)omp$/.test(argv[0] ?? "") ||
		/\/\.bun\/bin\/omp$/.test(argv[1] ?? "")
	)
		return "omp";
	if (exe === "pi" || /\/bin\/pi$/.test(argv[1] ?? "")) return "pi";
	if (exe === "cursor-agent") return "cursor";
	if (exe === "gemini" || /\/bin\/gemini$/.test(argv[1] ?? "")) return "gemini";
	return null;
}

function cwdOf(pid: number): string | null {
	try {
		const out = execFileSync(
			"lsof",
			["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
			{
				encoding: "utf8",
			},
		);
		const line = out.split("\n").find((l) => l.startsWith("n"));
		return line ? line.slice(1) : null;
	} catch {
		return null;
	}
}

const mtime = (file: string | null): number | null => {
	if (!file) return null;
	try {
		return statSync(file).mtimeMs;
	} catch {
		return null;
	}
};

/** Newest mtime of a file and the files in a folder (subagent logs). */
function newest(file: string | null, folder: string | null): number | null {
	let t = mtime(file);
	if (folder)
		try {
			for (const f of readdirSync(folder)) {
				const m = mtime(join(folder, f));
				if (m && (!t || m > t)) t = m;
			}
		} catch {}
	return t;
}

// ---- per harness ----

const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude");

function claudeRow(p: Proc): Row {
	let rec: Record<string, unknown> | null = null;
	try {
		rec = JSON.parse(
			readFileSync(join(claudeDir, "sessions", `${p.pid}.json`), "utf8"),
		);
	} catch {}
	const session = typeof rec?.sessionId === "string" ? rec.sessionId : null;
	const cwd = typeof rec?.cwd === "string" ? rec.cwd : cwdOf(p.pid);
	const dir =
		cwd && session
			? join(claudeDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
			: null;
	const status = typeof rec?.status === "string" ? rec.status : null;
	const waiting =
		typeof rec?.waitingFor === "string" ? ` (${rec.waitingFor})` : "";
	return {
		harness: "claude",
		pid: p.pid,
		cpu: p.cpu,
		cwd,
		session,
		reported: status ? `${status}${waiting}` : null,
		logAt: dir
			? newest(join(dir, `${session}.jsonl`), join(dir, session!, "subagents"))
			: null,
		...(rec ? {} : { note: "no session record (headless or old Claude)" }),
	};
}

interface OcService {
	url: string;
	auth: string;
	pid: number | null;
}

function opencodeService(procs: Proc[]): OcService | null {
	const state = process.env.XDG_STATE_HOME || join(HOME, ".local", "state");
	try {
		const s = JSON.parse(
			readFileSync(join(state, "opencode", "service.json"), "utf8"),
		) as { url?: string; password?: string; pid?: number };
		if (!s.url) return null;
		const pid = typeof s.pid === "number" ? s.pid : null;
		// Only a service that runs now: never one we would start.
		if (pid && !procs.some((p) => p.pid === pid)) return null;
		return {
			url: s.url.replace(/\/$/, ""),
			auth: s.password
				? `Basic ${Buffer.from(`opencode:${s.password}`).toString("base64")}`
				: "",
			pid,
		};
	} catch {
		return null;
	}
}

async function ocGet<T>(svc: OcService, path: string): Promise<T | null> {
	try {
		const r = await fetch(svc.url + path, {
			headers: svc.auth ? { authorization: svc.auth } : {},
			signal: AbortSignal.timeout(5000),
		});
		if (!r.ok) return null;
		const body = (await r.json()) as { data?: T } | T;
		return ((body as { data?: T }).data ?? body) as T;
	} catch {
		return null;
	}
}

type OcSession = {
	id: string;
	parentID?: string | null;
	time?: { updated?: number };
	location?: { directory?: string };
	directory?: string;
};

/** OpenCode: every running root session, and each TUI's newest session in its folder. */
async function opencodeRows(procs: Proc[], tuis: Proc[]): Promise<Row[]> {
	const svc = opencodeService(procs);
	const rows: Row[] = [];
	if (!svc) {
		for (const p of tuis)
			rows.push({
				harness: "opencode",
				pid: p.pid,
				cpu: p.cpu,
				cwd: cwdOf(p.pid),
				session: null,
				reported: null,
				logAt: null,
				note: "no OpenCode service runs (standalone TUI?)",
			});
		return rows;
	}
	const active =
		(await ocGet<Record<string, { type?: string }>>(
			svc,
			"/api/session/active",
		)) ?? {};
	const taken = new Set<string>();
	for (const [id, st] of Object.entries(active)) {
		const info = await ocGet<OcSession>(svc, `/api/session/${id}`);
		if (info?.parentID) continue;
		taken.add(id);
		rows.push({
			harness: "opencode",
			pid: svc.pid ?? 0,
			cpu: procs.find((p) => p.pid === svc.pid)?.cpu ?? 0,
			cwd: info?.location?.directory ?? info?.directory ?? null,
			session: id,
			reported: st?.type ?? null,
			logAt: info?.time?.updated ?? null,
			note: "running on the service",
		});
	}
	for (const p of tuis) {
		const cwd = cwdOf(p.pid);
		const running = rows.find(
			(r) => r.cwd === cwd && r.session && taken.has(r.session),
		);
		if (running) {
			running.note = `running; TUI pid ${p.pid} works in this folder`;
			continue;
		}
		const list =
			(cwd &&
				(await ocGet<OcSession[]>(
					svc,
					`/api/session?directory=${encodeURIComponent(cwd)}&parentID=null&limit=5&order=desc`,
				))) ||
			[];
		const s = list.find((x) => !taken.has(x.id));
		if (s) taken.add(s.id);
		rows.push({
			harness: "opencode",
			pid: p.pid,
			cpu: p.cpu,
			cwd,
			session: s?.id ?? null,
			reported: s ? "idle" : null,
			logAt: s?.time?.updated ?? null,
			note: "TUI (session guessed from its folder)",
		});
	}
	return rows;
}

/** Codex: the newest rollout a thread id names (searched by file name). */
function codexRollout(threadId: string): string | null {
	const root = join(HOME, ".codex", "sessions");
	try {
		const out = execFileSync(
			"find",
			[root, "-name", `rollout-*${threadId}.jsonl`, "-newermt", "-14 days"],
			{ encoding: "utf8" },
		);
		return out.split("\n").filter(Boolean).pop() ?? null;
	} catch {
		return null;
	}
}

function simpleRow(harness: Harness, p: Proc): Row {
	return {
		harness,
		pid: p.pid,
		cpu: p.cpu,
		cwd: cwdOf(p.pid),
		session: null,
		reported: null,
		logAt: null,
	};
}

// ---- daemon ----

const get = (url: string, origin: string) =>
	fetch(url, {
		headers: { "X-Pulsar": "1", Origin: origin },
		signal: AbortSignal.timeout(10_000),
	});

async function daemonAgents(): Promise<AgentRow[]> {
	const origin = new URL(base).origin;
	const items: AgentRow[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < 20; page++) {
		const url = `${base}/api/v1/agents${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
		let r = await get(url, origin);
		// 503: the daemon could not tell who calls in time; it asks to retry.
		for (let i = 0; r.status === 503 && i < 8; i++) {
			await new Promise((ok) => setTimeout(ok, 500 * (i + 1)));
			r = await get(url, origin);
		}
		if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
		const body = (await r.json()) as {
			items: AgentRow[];
			nextCursor: string | null;
		};
		items.push(...body.items);
		cursor = body.nextCursor;
		if (!cursor) break;
	}
	// Local agents only: a pool agent's id is `<machineId>/<id>`.
	return items.filter((a) => !a.id.includes("/"));
}

// ---- compare ----

const ago = (t: number | null) =>
	t === null ? "-" : `${Math.round((NOW - t) / 1000)}s`;

async function main() {
	const procs = processes();
	const byHarness = new Map<Harness, Proc[]>();
	for (const p of procs) {
		const h = classify(p);
		if (
			h &&
			(!scannedOnly ||
				h === "claude" ||
				h === "opencode" ||
				h === "opencode-serve")
		)
			byHarness.set(h, [...(byHarness.get(h) ?? []), p]);
	}
	const rows: Row[] = [];
	for (const p of byHarness.get("claude") ?? []) rows.push(claudeRow(p));
	for (const h of ["omp", "pi"] as const)
		for (const p of byHarness.get(h) ?? []) {
			const row = simpleRow(h, p);
			row.logAt = mtime(await piSessionFile(`.${h}`, row.cwd));
			rows.push(row);
		}
	for (const h of ["codex", "codex-app-server", "cursor", "gemini"] as const)
		for (const p of byHarness.get(h) ?? []) rows.push(simpleRow(h, p));
	rows.push(...(await opencodeRows(procs, byHarness.get("opencode") ?? [])));

	const agents = await daemonAgents();
	const live = agents.filter((a) => a.status !== "gone");
	const problems: string[] = [];
	const problem = (kind: string, text: string) =>
		problems.push(`${kind.padEnd(19)} ${text}`);
	const label = (a: AgentRow) =>
		`${a.name} (${a.id}, pid ${a.pid ?? "-"}, ${a.state})`;
	const alive = new Set(procs.map((p) => p.pid));
	const childrenOf = (pid: number) =>
		procs.filter(
			(p) => p.ppid === pid && !/cli\.js (mcp|hook)|pulsar.*mcp/.test(p.args),
		);

	for (const r of rows) {
		const mine = live.filter(
			(a) =>
				(r.harness === "codex" || r.harness === "codex-app-server"
					? a.harness === "codex"
					: a.harness === r.harness) &&
				(r.session ? a.sessionId === r.session : a.pid === r.pid),
		);
		if (r.harness === "claude") {
			const forPid = live.filter(
				(a) => a.harness === "claude" && a.pid === r.pid,
			);
			const current = forPid.filter((a) => a.sessionId === r.session);
			if (r.session && current.length === 0)
				problem(
					"missing",
					`claude pid ${r.pid} session ${r.session} (${r.cwd})`,
				);
			for (const a of forPid)
				if (r.session && a.sessionId !== r.session)
					problem(
						"stale-session",
						`${label(a)}: pid ${r.pid} now runs session ${r.session}`,
					);
			if (forPid.length > 1)
				problem(
					"duplicate",
					`claude pid ${r.pid}: ${forPid.map(label).join(", ")}`,
				);
			const a = current[0];
			if (a && r.reported) {
				const rec = r.reported.split(" ")[0];
				const want =
					rec === "busy"
						? "busy"
						: rec === "waiting"
							? // Blocked on a dialog: needs-you (relayed, or in the terminal).
								"needs-you"
							: "idle";
				if (!want.split("|").includes(a.state))
					problem("status", `${label(a)}: Claude's record says ${r.reported}`);
			}
		} else if (r.harness === "codex-app-server") {
			// Threads are checked by rollout below.
		} else if (r.harness === "codex") {
			// A Codex TUI talks to the app-server: its threads carry that pid.
		} else if (r.harness === "opencode-serve") {
		} else if (mine.length === 0) {
			problem(
				"missing",
				`${r.harness} pid ${r.pid}${r.session ? ` session ${r.session}` : ""} (${r.cwd ?? "?"})`,
			);
		} else if (mine.length > 1 && (r.harness === "omp" || r.harness === "pi")) {
			problem(
				"duplicate",
				`${r.harness} pid ${r.pid}: ${mine.map(label).join(", ")}`,
			);
		}
		for (const a of mine.length ? mine : []) {
			if (r.harness === "claude" && a.sessionId !== r.session) continue;
			const quiet =
				r.cpu < 1 &&
				r.logAt !== null &&
				NOW - r.logAt > QUIET_MS &&
				childrenOf(r.pid).length === 0;
			if (a.state === "busy" && quiet)
				problem(
					"stale-busy",
					`${label(a)}: cpu ${r.cpu}%, log quiet ${ago(r.logAt)}, busy for ${ago(a.stateSince)}`,
				);
			if (
				a.state === "idle" &&
				r.logAt !== null &&
				NOW - r.logAt < WRITING_MS &&
				!(r.harness === "claude" && r.reported?.includes("dialog open"))
			)
				problem(
					"idle-while-writing",
					`${label(a)}: log written ${ago(r.logAt)} ago, cpu ${r.cpu}%`,
				);
		}
	}

	// Codex threads: rollout activity against the agent's status.
	for (const a of live.filter((x) => x.harness === "codex" && x.sessionId)) {
		const t = mtime(codexRollout(a.sessionId!));
		rows.push({
			harness: "codex",
			pid: a.pid ?? 0,
			cpu: procs.find((p) => p.pid === a.pid)?.cpu ?? 0,
			cwd: a.cwd,
			session: a.sessionId,
			reported: null,
			logAt: t,
			note: "thread",
		});
		if (a.state === "idle" && t !== null && NOW - t < WRITING_MS)
			problem(
				"idle-while-writing",
				`${label(a)}: rollout written ${ago(t)} ago`,
			);
		if (a.state === "busy" && t !== null && NOW - t > QUIET_MS)
			problem("stale-busy", `${label(a)}: rollout quiet ${ago(t)}`);
	}
	if (
		(byHarness.get("codex")?.length ?? 0) > 0 &&
		!live.some((a) => a.harness === "codex")
	)
		problem("missing", "codex TUI runs but no codex agent is listed");

	for (const a of live)
		if (a.pid && !alive.has(a.pid))
			problem("ghost", `${label(a)}: process ${a.pid} is gone`);

	if (asJson) {
		console.log(
			JSON.stringify({ base, rows, agents: live, problems }, null, 2),
		);
	} else {
		console.log(`daemon: ${base}  (${live.length} live local agents)\n`);
		console.log(
			"harness            pid     cpu%  log-age  reported            session / cwd",
		);
		for (const r of rows)
			console.log(
				`${r.harness.padEnd(18)} ${String(r.pid).padEnd(7)} ${r.cpu.toFixed(1).padStart(5)}  ${ago(r.logAt).padStart(7)}  ${(r.reported ?? "-").padEnd(19).slice(0, 19)} ${r.session ?? "-"}  ${r.cwd ?? ""}${r.note ? `  [${r.note}]` : ""}`,
			);
		console.log("\nagents:");
		for (const a of live)
			console.log(
				`  ${a.state.padEnd(9)} ${a.name.padEnd(28)} ${a.id}  pid ${a.pid ?? "-"}`,
			);
		console.log(
			problems.length
				? `\n${problems.length} mismatch(es):\n${problems.map((p) => `  ${p}`).join("\n")}`
				: "\nno mismatches",
		);
	}
	process.exitCode = problems.length ? 1 : 0;
}

await main();
