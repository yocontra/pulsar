/**
 * Shared by the load benchmarks (listperf.ts, sessionperf.ts): a real
 * throwaway daemon (web/e2e/real/daemon.ts: temp HOME and PULSAR_HOME,
 * scanners off, fake agents) behind a TCP latency proxy.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { connect, createServer, type Socket } from "node:net";
import { resolve } from "node:path";

export const arg = (name: string, fallback: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1]! : fallback;
};

export const DAEMON_PORT = 47000 + Math.floor(Math.random() * 900);
export const PROXY_PORT = DAEMON_PORT + 950;

export function startDaemon(
	extra: Record<string, string> = {},
): Promise<ChildProcess> {
	const child = spawn(
		process.execPath,
		[resolve(import.meta.dir, "../e2e/real/daemon.ts")],
		{
			env: {
				...process.env,
				PULSAR_REAL_PORT: String(DAEMON_PORT),
				PULSAR_REAL_CONTROL_PORT: String(DAEMON_PORT + 1),
				PULSAR_NATIVE_PRESENCE: "off",
				PULSAR_NO_SCAN: "1",
				...extra,
			},
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	return new Promise((ok, fail) => {
		child.stdout!.on("data", (d: Buffer) => {
			if (String(d).includes("real daemon:")) ok(child);
		});
		child.on("exit", (c) => fail(new Error(`daemon exited ${c}`)));
	});
}

/** A TCP proxy adding `oneWay` ms to every chunk, in order, both ways. */
export function startProxy(oneWay: number, target = DAEMON_PORT) {
	// The daemon checks Host and Origin: rewrite the proxy's port (same
	// length) to the daemon's on the way up.
	const fromPort = Buffer.from(`127.0.0.1:${PROXY_PORT}`);
	const toPort = Buffer.from(`127.0.0.1:${DAEMON_PORT}`);
	const rewrite = (d: Buffer) => {
		let i = d.indexOf(fromPort);
		while (i !== -1) {
			toPort.copy(d, i);
			i = d.indexOf(fromPort, i + 1);
		}
		return d;
	};
	const pipe = (from: Socket, to: Socket, up: boolean) => {
		let last = 0;
		from.on("data", (raw: Buffer) => {
			const d = up ? rewrite(raw) : raw;
			const at = Math.max(Date.now() + oneWay, last);
			last = at;
			setTimeout(() => to.write(d), at - Date.now());
		});
		from.on("end", () => setTimeout(() => to.end(), oneWay + 1));
		from.on("error", () => to.destroy());
	};
	const server = createServer((client) => {
		const up = connect(target, "127.0.0.1");
		// The handshake's SYN/SYN-ACK: one RTT before the client may send.
		client.pause();
		setTimeout(() => {
			client.resume();
			pipe(client, up, true);
			pipe(up, client, false);
		}, oneWay * 2);
	});
	return new Promise<typeof server>((ok) =>
		server.listen(PROXY_PORT, "127.0.0.1", () => ok(server)),
	);
}
