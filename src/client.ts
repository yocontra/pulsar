import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { currentCli, socketPath } from "./paths.ts";
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
function cliEntry(): string {
	// Prefer the installed `current` version, so a session still running an older
	// copy never restarts an outdated daemon after an upgrade.
	const installed = currentCli();
	if (existsSync(installed)) return installed;
	const here = fileURLToPath(new URL(".", import.meta.url));
	const js = `${here}cli.js`;
	return existsSync(js) ? js : `${here}cli.ts`;
}

/** Starts the daemon detached, so it outlives the session that started it. */
export function spawnDaemon() {
	const child = spawn(process.execPath, [cliEntry(), "daemon"], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();
}

async function sleep(ms: number) {
	await new Promise((r) => setTimeout(r, ms));
}

/** Connects to the daemon, starting it first when no daemon answers. */
export async function connectDaemon(autoStart = true): Promise<Socket> {
	const path = socketPath();
	try {
		return await tryConnect(path);
	} catch (err) {
		if (!autoStart) throw err;
	}
	spawnDaemon();
	for (let i = 0; i < 50; i++) {
		await sleep(100);
		try {
			return await tryConnect(path);
		} catch {}
	}
	throw new Error(`pulsar daemon did not start (socket ${path})`);
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
		this.socket = socket;
		readFrames(socket, (frame) => this.onFrame(frame));
		socket.on("close", () => {
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
			return Promise.reject(new Error("not connected to the pulsar daemon"));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(id);
							reject(
								new Error(
									`pulsar daemon did not answer ${method} in ${timeoutMs} ms`,
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
