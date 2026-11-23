import { link, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { pidAlive, processStart } from "./processes.ts";

/**
 * One daemon per socket. Before it binds, a daemon creates `<socket>.lock`
 * exclusively (a hard link of a finished file) with its pid and start time. A lock whose
 * process is gone is stale and removed: its pid is dead, or now names
 * another process (started at another time; the lock outlives reboots and
 * pids repeat). Two starters can both find the same stale lock, so the
 * winner reads the lock back after a moment; whoever doesn't find its own
 * pid there gives up. A running daemon also checks that the lock and the
 * socket are still its own (`owns`) and exits when they aren't, so a daemon
 * that lost a race never keeps running unreachable.
 */
export class DaemonLock {
	readonly path: string;
	private held = false;

	constructor(socketPath: string) {
		this.path = `${socketPath}.lock`;
	}

	/** The pid in the lock file, or null when there is none (or it's unreadable). */
	async holder(): Promise<number | null> {
		return (await this.read())?.pid ?? null;
	}

	private async read(): Promise<{ pid: number; start: string | null } | null> {
		try {
			const [first, second] = (await readFile(this.path, "utf8")).split("\n");
			const pid = Number(first?.trim());
			if (!Number.isInteger(pid) || pid <= 0) return null;
			return { pid, start: second?.trim() || null };
		} catch {
			return null;
		}
	}

	/** The holder is a live process, and the same one that took the lock. */
	private async live(held: {
		pid: number;
		start: string | null;
	}): Promise<boolean> {
		if (!pidAlive(held.pid)) return false;
		// A lock from before start times were kept: the pid is all we have.
		if (!held.start) return true;
		const now = await processStart(held.pid);
		return now === null || now === held.start;
	}

	/** Takes the lock; false when another live process holds it. */
	async acquire(): Promise<boolean> {
		const start = (await processStart(process.pid)) ?? "";
		// The lock appears whole or not at all: written to a private file, then
		// linked into place (link fails if the lock exists). A lock created
		// empty and filled later looked half-written to a concurrent starter
		// for as long as `ps` took (seconds on a loaded machine), which then
		// removed it and took its own: two daemons, or none.
		const tmp = `${this.path}.${process.pid}.tmp`;
		await writeFile(tmp, `${process.pid}\n${start}\n`, { mode: 0o600 });
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					await link(tmp, this.path);
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
					const held = await this.read();
					if (held && held.pid !== process.pid && (await this.live(held)))
						return false;
					// Stale (its daemon died) or unreadable. `live` may have taken
					// seconds: remove it only if it is still the lock judged stale,
					// not one another starter took meanwhile; then try again.
					const now = await this.read();
					if (now?.pid === held?.pid && now?.start === held?.start)
						await unlink(this.path).catch(() => {});
					continue;
				}
				// Another starter may have removed a stale lock just after we made
				// ours and linked its own: only the pid left in the file wins.
				await new Promise((r) => setTimeout(r, 50));
				if ((await this.holder()) === process.pid) {
					this.held = true;
					return true;
				}
				return false;
			}
			return false;
		} finally {
			await unlink(tmp).catch(() => {});
		}
	}

	/** A live daemon holds the lock (it may be starting, or too busy to accept). */
	async heldByLive(): Promise<boolean> {
		const held = await this.read();
		return !!held && held.pid !== process.pid && (await this.live(held));
	}

	/** True while the lock still names this process. */
	async owns(): Promise<boolean> {
		return this.held && (await this.holder()) === process.pid;
	}

	async release() {
		if (!this.held) return;
		this.held = false;
		if ((await this.holder()) === process.pid)
			await unlink(this.path).catch(() => {});
	}
}

/**
 * The background service's claim on a socket (`<socket>.service.lock`),
 * held while it runs. An on-demand start that finds it held by a live
 * process steps aside: the service is starting and would only stop it.
 */
export function serviceClaim(socketPath: string): DaemonLock {
	return new DaemonLock(`${socketPath}.service`);
}

/** The inode of a path, or null when it's gone. */
export async function inodeOf(path: string): Promise<number | null> {
	try {
		return (await stat(path)).ino;
	} catch {
		return null;
	}
}
