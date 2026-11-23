import { spawn } from "node:child_process";
import { access, stat, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { DaemonLock, serviceClaim } from "./daemon-lock.ts";
import { daemonRuntimeFlags } from "./lazy.ts";
import { checkedSocketPath, currentCli } from "./paths.ts";
import { type Frame, RpcError, readFrames, writeFrame } from "./rpc.ts";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

function tryConnect(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect(path);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

/** The CLI entry the daemon is started from (works from src/ and from dist/). */
async function cliEntry(): Promise<string> {
	const exists = (p: string) =>
		access(p).then(
			() => true,
			() => false,
		);
	// Prefer the installed `current` version, so a session still running an older
	// copy never restarts an outdated daemon after an upgrade.
	const installed = currentCli();
	if (await exists(installed)) return installed;
	const here = fileURLToPath(new URL(".", import.meta.url));
	const js = `${here}cli.js`;
	return (await exists(js)) ? js : `${here}cli.ts`;
}

/** Starts the daemon detached, so it outlives the session that started it. */
async function spawnDaemon() {
	const child = spawn(
		process.execPath,
		[...daemonRuntimeFlags(), await cliEntry(), "daemon"],
		{
			detached: true,
			stdio: "ignore",
			env: process.env,
		},
	);
	child.unref();
}

async function sleep(ms: number) {
	await new Promise((r) => setTimeout(r, ms));
}

/** At most one `daemon` start per this long, per client and across clients. */
export const SPAWN_GAP_MS = 3000;
let lastSpawn = 0;

/**
 * Whether this client should start a daemon now. Not when a live daemon
 * holds the lock (it is starting, or too busy to accept: another one would
 * only pile on) or the service's claim, nor within SPAWN_GAP_MS of this or any other client's last
 * start (a stamp file next to the socket).
 */
export async function maySpawn(
	path: string,
	now = Date.now(),
): Promise<boolean> {
	if (now - lastSpawn < SPAWN_GAP_MS || deciding) return false;
	// One decision at a time in this process: the checks below await.
	deciding = true;
	try {
		if (await new DaemonLock(path).heldByLive()) return false;
		// The background service is starting (it claims the machine first):
		// wait for it rather than start an on-demand daemon it must stop.
		if (await serviceClaim(path).heldByLive()) return false;
		const stamp = `${path}.spawn`;
		try {
			if (now - (await stat(stamp)).mtimeMs < SPAWN_GAP_MS) return false;
		} catch {}
		await writeFile(stamp, "").catch(() => {});
		lastSpawn = now;
		return true;
	} finally {
		deciding = false;
	}
}
let deciding = false;

/** Connects to the daemon, starting it first when no daemon answers. */
async function connectDaemon(autoStart = true): Promise<Socket> {
	const path = await checkedSocketPath();
	try {
		return await tryConnect(path);
	} catch (err) {
		if (!autoStart) throw err;
	}
	if (await maySpawn(path)) await spawnDaemon();
	// Wait for it (or the one already starting), backing off: 100 ms to 500 ms, ~6 s in all.
	let delay = 100;
	for (let waited = 0; waited < 6000; waited += delay) {
		await sleep(delay);
		delay = Math.min(delay * 1.5, 500);
		try {
			return await tryConnect(path);
		} catch {}
	}
	throw new Error(`Pulsar daemon did not start (socket ${path})`);
}

/** A connection to the daemon with request/response and pushed events. */
export class DaemonClient {
	private socket: Socket | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private listeners = new Map<string, Set<(data: unknown) => void>>();
	private closeHandlers = new Set<() => void>();

	async connect(autoStart = true) {
		const socket = await connectDaemon(autoStart);
		// Never leak a connection: a reconnect closes the one it replaces
		// (whose close then notifies nobody; this one is current).
		const old = this.socket;
		this.socket = socket;
		if (old && !old.destroyed) old.destroy();
		readFrames(socket, (frame) => {
			if (this.socket === socket) this.onFrame(frame);
		});
		socket.on("close", () => {
			if (this.socket !== socket && this.socket !== null) return;
			for (const p of this.pending.values())
				p.reject(new Error("daemon connection closed"));
			this.pending.clear();
			for (const h of this.closeHandlers) h();
		});
		socket.on("error", () => {});
		return this;
	}

	get connected() {
		return !!this.socket && !this.socket.destroyed;
	}

	private onFrame(frame: Frame) {
		if ("event" in frame) {
			for (const fn of this.listeners.get(frame.event) ?? []) fn(frame.data);
			return;
		}
		if (!("id" in frame)) return;
		const p = this.pending.get(frame.id);
		if (!p) return;
		this.pending.delete(frame.id);
		if ("error" in frame)
			p.reject(new RpcError(frame.error.code, frame.error.message));
		else if ("result" in frame) p.resolve(frame.result);
	}

	call<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
		const socket = this.socket;
		if (!socket || socket.destroyed)
			return Promise.reject(new Error("not connected to the Pulsar daemon"));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(id);
							reject(
								new Error(
									`Pulsar daemon did not answer ${method} in ${timeoutMs} ms`,
								),
							);
						}, timeoutMs)
					: null;
			this.pending.set(id, {
				resolve: (v) => {
					if (timer) clearTimeout(timer);
					resolve(v as T);
				},
				reject: (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				},
			});
			writeFrame(socket, { id, method, params });
		});
	}

	on(event: string, fn: (data: unknown) => void) {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(fn);
	}

	onClose(fn: () => void) {
		this.closeHandlers.add(fn);
	}

	close() {
		this.socket?.end();
		this.socket = null;
	}
}
