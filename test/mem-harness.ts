/**
 * Memory measurement for pulsar's processes: the MCP server, the hook, the
 * pi/omp extension (inside a stand-in host) and the daemon. Used by
 * `scripts/mem-report.ts` and `test/memory.test.ts`.
 *
 * Everything runs from the built `dist/` in a throwaway HOME and
 * PULSAR_HOME, with scanners off. Only processes started here are killed.
 *
 * Numbers: `footprint` is macOS's phys_footprint (what Activity Monitor
 * calls Memory; RSS on Linux), the honest per-process cost. `heap` comes
 * from a probe preloaded into the child: on SIGUSR2 it runs a full GC and
 * writes `process.memoryUsage()` to a file.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonRuntimeFlags } from "../src/lazy.ts";

export const ROOT = join(import.meta.dirname, "..");
/** The build under test; PULSAR_MEM_DIST points at another (e.g. an older build to compare). */
const DIST = process.env.PULSAR_MEM_DIST ?? join(ROOT, "dist");
export const CLI = join(DIST, "cli.js");
export const EXTENSION = join(DIST, "extension.js");

export type Runtime = "node" | "bun";

const binaries = new Map<Runtime, string>();
/** The runtime's real binary (version-manager shims need the real HOME). */
export function runtimeBinary(runtime: Runtime): string {
	let bin = binaries.get(runtime);
	if (!bin && runtime === "node" && process.env.PULSAR_MEM_NODE)
		bin = process.env.PULSAR_MEM_NODE;
	if (!bin) {
		bin = execFileSync(
			runtime,
			["-e", "process.stdout.write(process.execPath)"],
			{ encoding: "utf8" },
		);
		binaries.set(runtime, bin);
	}
	return bin;
}

export interface Usage {
	/** phys_footprint (macOS) or RSS (Linux), bytes. */
	footprint: number;
	/** V8/JSC heap in use after a full GC, bytes. */
	heapUsed: number;
	heapTotal: number;
	external: number;
	rss: number;
}

export const MB = 1024 * 1024;
export const mb = (n: number) => `${(n / MB).toFixed(1)} MB`;

/** phys_footprint on macOS (`footprint`), RSS from /proc elsewhere. */
export function footprint(pid: number): number {
	if (process.platform === "darwin") {
		const out = execFileSync(
			"footprint",
			["-f", "bytes", "--noCategories", String(pid)],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		const m = /Footprint:\s*(\d+)\s*B/.exec(out);
		if (!m) throw new Error(`footprint: no total for ${pid}`);
		return Number(m[1]);
	}
	const status = readFileSync(`/proc/${pid}/status`, "utf8");
	const m = /VmRSS:\s*(\d+)\s*kB/.exec(status);
	return m ? Number(m[1]) * 1024 : 0;
}

const PROBE = `
const out = process.env.PULSAR_MEM_PROBE;
if (out) {
  const fs = await import("node:fs");
  process.on("SIGUSR2", () => {
    try {
      if (globalThis.Bun) globalThis.Bun.gc(true);
      else if (globalThis.gc) { globalThis.gc(); globalThis.gc(); }
      fs.writeFileSync(out + ".tmp", JSON.stringify(process.memoryUsage()));
      fs.renameSync(out + ".tmp", out);
    } catch {}
  });
}
`;

/** A private HOME + PULSAR_HOME and the env a child runs with. */
export class Sandbox {
	readonly dir = mkdtempSync(join(tmpdir(), "pulsar-mem-"));
	readonly home = join(this.dir, "home");
	readonly state = join(this.dir, "state");
	readonly probe = join(this.dir, "probe.mjs");
	private readonly children = new Set<ChildProcess>();
	private readonly servers = new Set<Server>();

	constructor() {
		mkdirSync(this.home, { recursive: true });
		mkdirSync(this.state, { recursive: true });
		writeFileSync(this.probe, PROBE);
	}

	env(extra: Record<string, string> = {}): Record<string, string> {
		const keep: Record<string, string> = {};
		for (const k of ["PATH", "TMPDIR", "LANG"])
			if (process.env[k]) keep[k] = process.env[k] as string;
		return {
			...keep,
			HOME: this.home,
			PULSAR_HOME: this.state,
			XDG_STATE_HOME: join(this.home, ".local", "state"),
			XDG_DATA_HOME: join(this.home, ".local", "share"),
			XDG_CONFIG_HOME: join(this.home, ".config"),
			PULSAR_INSTALL_ROOT: join(this.home, "install"),
			CLAUDE_CONFIG_DIR: join(this.home, ".claude"),
			PULSAR_NO_SCAN: "1",
			PULSAR_NO_RATE_LIMIT: "1",
			...extra,
		};
	}

	/** Spawns `runtime` with the probe preloaded. */
	spawn(
		runtime: Runtime,
		args: string[],
		opts: {
			env?: Record<string, string>;
			flags?: string[];
			probe?: boolean;
		} = {},
	): ChildProcess {
		const pre =
			opts.probe === false
				? []
				: runtime === "bun"
					? ["--preload", this.probe]
					: ["--expose-gc", "--import", this.probe];
		const child = spawn(
			runtimeBinary(runtime),
			[...pre, ...(opts.flags ?? []), ...args],
			{
				cwd: this.home,
				env: this.env(opts.env),
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		child.stderr?.resume();
		this.children.add(child);
		child.once("exit", () => this.children.delete(child));
		return child;
	}

	/** Footprint now, and the heap after a full GC (via the probe). */
	async usage(child: ChildProcess): Promise<Usage> {
		const pid = child.pid as number;
		const file = join(this.dir, `probe-${pid}.json`);
		rmSync(file, { force: true });
		child.kill("SIGUSR2");
		const t0 = Date.now();
		while (!existsSync(file)) {
			if (Date.now() - t0 > 10_000) throw new Error(`no probe from ${pid}`);
			await sleep(20);
		}
		const mem = JSON.parse(readFileSync(file, "utf8")) as NodeJS.MemoryUsage;
		// After the GC, so freed pages are not counted.
		await sleep(100);
		return {
			footprint: footprint(pid),
			heapUsed: mem.heapUsed,
			heapTotal: mem.heapTotal,
			external: mem.external,
			rss: mem.rss,
		};
	}

	/**
	 * Usage once V8 has handed freed pages back: it unmaps them lazily, tens
	 * of seconds after a GC. Polls until the footprint stops falling.
	 */
	async settled(child: ChildProcess, maxMs = 90_000): Promise<Usage> {
		const u = await this.usage(child);
		const pid = child.pid as number;
		let last = u.footprint;
		for (let waited = 0; waited < maxMs; waited += 10_000) {
			await sleep(10_000);
			const now = footprint(pid);
			if (now > last - 256 * 1024)
				return { ...u, footprint: Math.min(now, last) };
			last = now;
		}
		return { ...u, footprint: last };
	}

	/** A socket that accepts connections and never answers (a hung daemon). */
	async silentSocket(path: string): Promise<void> {
		const server = createServer((s) => s.resume());
		this.servers.add(server);
		await new Promise<void>((r) => server.listen(path, r));
	}

	async close() {
		for (const c of this.children) c.kill("SIGKILL");
		for (const s of this.servers) s.close();
		await sleep(100);
		rmSync(this.dir, { recursive: true, force: true });
	}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts a child whose probe file is keyed by its pid: the pid is known only
 * after spawn, so the probe path uses a placeholder the probe resolves.
 */
function spawnProbed(
	box: Sandbox,
	runtime: Runtime,
	args: string[],
	opts: {
		env?: Record<string, string>;
		flags?: string[];
		probe?: boolean;
	} = {},
): ChildProcess {
	return box.spawn(runtime, args, {
		...opts,
		env: { ...opts.env, PULSAR_MEM_PROBE: join(box.dir, "probe-PID.json") },
	});
}

// The probe expands PID itself.
const PROBE_PID = `
const tpl = process.env.PULSAR_MEM_PROBE;
if (tpl) process.env.PULSAR_MEM_PROBE = tpl.replace("PID", String(process.pid));
`;

/** Rewrites the probe so it resolves the PID placeholder first. */
export function installProbe(box: Sandbox) {
	writeFileSync(box.probe, PROBE_PID + PROBE);
}

/** Starts the built daemon and waits for its socket. */
export async function startDaemon(
	box: Sandbox,
	runtime: Runtime,
	flags: string[] = [],
): Promise<ChildProcess> {
	installProbe(box);
	// The flags clients and the service start it with (src/lazy.ts).
	const child = spawnProbed(box, runtime, [CLI, "daemon"], {
		flags: [
			...(runtime === "node" ? daemonRuntimeFlags("node") : []),
			...flags,
		],
	});
	const sock = join(box.state, "bus.sock");
	const t0 = Date.now();
	while (!existsSync(sock)) {
		if (child.exitCode !== null) throw new Error("daemon exited");
		if (Date.now() - t0 > 20_000) throw new Error("daemon did not start");
		await sleep(50);
	}
	return child;
}

/** Minimal newline JSON-RPC over the MCP child's stdio. */
export class StdioRpc {
	private nextId = 1;
	private buf = "";
	private readonly pending = new Map<number, (v: unknown) => void>();
	readonly notifications: unknown[] = [];

	readonly child: ChildProcess;

	constructor(child: ChildProcess) {
		this.child = child;
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			this.buf += chunk;
			let nl = this.buf.indexOf("\n");
			while (nl !== -1) {
				const line = this.buf.slice(0, nl);
				this.buf = this.buf.slice(nl + 1);
				nl = this.buf.indexOf("\n");
				if (!line.trim()) continue;
				const msg = JSON.parse(line) as { id?: number; result?: unknown };
				if (msg.id !== undefined && this.pending.has(msg.id)) {
					this.pending.get(msg.id)?.(msg);
					this.pending.delete(msg.id);
				} else if (this.notifications.length < 1000)
					this.notifications.push(msg);
			}
		});
	}

	request<T = unknown>(
		method: string,
		params: unknown = {},
		timeoutMs = 30_000,
	): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`${method} timed out`)),
				timeoutMs,
			);
			this.pending.set(id, (v) => {
				clearTimeout(timer);
				const msg = v as { result?: T; error?: { message: string } };
				if (msg.error) reject(new Error(msg.error.message));
				else resolve(msg.result as T);
			});
			this.child.stdin?.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	}

	notify(method: string, params: unknown = {}) {
		this.child.stdin?.write(
			`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
		);
	}

	async initialize() {
		await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "mem", version: "0" },
		});
		this.notify("notifications/initialized");
	}

	tool(name: string, args: Record<string, unknown> = {}) {
		return this.request<{ content: { text: string }[]; isError?: boolean }>(
			"tools/call",
			{ name, arguments: args },
		);
	}
}

/** Starts the built MCP server and completes the MCP handshake. */
export async function startMcp(
	box: Sandbox,
	runtime: Runtime,
	opts: { session?: string; flags?: string[]; probe?: boolean } = {},
): Promise<{ child: ChildProcess; rpc: StdioRpc; startMs: number }> {
	installProbe(box);
	const t0 = performance.now();
	const child = spawnProbed(box, runtime, [CLI, "mcp"], {
		flags: opts.flags,
		probe: opts.probe,
		env: {
			// Pull-only: test messages can never be pushed into a real session.
			PULSAR_HARNESS: "gemini",
			PULSAR_SESSION_ID: opts.session ?? "mem-session",
		},
	});
	const rpc = new StdioRpc(child);
	await rpc.initialize();
	const tools = await rpc.request<{ tools: unknown[] }>("tools/list");
	if (tools.tools.length < 5) throw new Error("mcp: too few tools");
	return { child, rpc, startMs: performance.now() - t0 };
}

const HOOK_INPUT = JSON.stringify({
	session_id: "mem-hook",
	hook_event_name: "PermissionRequest",
	tool_name: "Bash",
	tool_input: { command: "true" },
});

/**
 * The hook blocked on a daemon that never answers (its steady state while a
 * prompt is open), plus how long it takes to exit on input it ignores.
 */
export async function measureHook(
	runtime: Runtime,
): Promise<{ usage: Usage; plain: number; exitMs: number }> {
	const box = new Sandbox();
	try {
		installProbe(box);
		await box.silentSocket(join(box.state, "bus.sock"));
		// Startup cost: input it ignores, so it exits right after imports
		// (median of 5: the machine may be busy).
		const times: number[] = [];
		for (let i = 0; i < 5; i++) {
			const t0 = performance.now();
			const quick = box.spawn(runtime, [CLI, "hook", "claude-permission"], {
				probe: false,
			});
			quick.stdin?.end("{}");
			await new Promise((r) => quick.once("exit", r));
			times.push(performance.now() - t0);
		}
		const exitMs = times.sort((a, b) => a - b)[2] as number;
		const plain = box.spawn(runtime, [CLI, "hook", "claude-permission"], {
			probe: false,
		});
		plain.stdin?.end(HOOK_INPUT);
		const child = spawnProbed(box, runtime, [CLI, "hook", "claude-permission"]);
		child.stdin?.end(HOOK_INPUT);
		await sleep(1500);
		return {
			usage: await box.usage(child),
			plain: footprint(plain.pid as number),
			exitMs,
		};
	} finally {
		await box.close();
	}
}

const HOST = (extension: string | null) => `
const handlers = new Map();
const api = {
  on(e, h) { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
  sendMessage() {},
  registerMcpServer() {},
};
${extension ? `const mod = await import(${JSON.stringify(extension)}); mod.default(api);` : ""}
for (const h of handlers.get("session_start") ?? []) await h({}, {});
setInterval(() => {}, 1 << 30);
`;

/**
 * The extension's cost inside a host: a stand-in host process with and
 * without the extension loaded and connected.
 */
export async function measureExtension(
	box: Sandbox,
	runtime: Runtime,
): Promise<{ bare: Usage; loaded: Usage }> {
	installProbe(box);
	const bareFile = join(box.dir, "host-bare.mjs");
	const extFile = join(box.dir, "host-ext.mjs");
	writeFileSync(bareFile, HOST(null));
	writeFileSync(extFile, HOST(EXTENSION));
	const env = { PI_CODING_AGENT: "1" };
	const bare = spawnProbed(box, runtime, [bareFile], { env });
	const loaded = spawnProbed(box, runtime, [extFile, "pi"], { env });
	await sleep(2000);
	return { bare: await box.usage(bare), loaded: await box.usage(loaded) };
}
