import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * tailscaled's LocalAPI, asked directly instead of through the `tailscale`
 * CLI. A CLI run costs a process (and on macOS the app binary's startup): 0.7
 * to 1 s on a loaded Mac, against 10 to 80 ms for the same whois over the
 * LocalAPI. Where pulsar finds it follows tailscale's own CLI
 * (safesocket_darwin.go, safesocket_unix.go):
 *
 * - macOS standalone app ("macsys"): `/Library/Tailscale/ipnport` is a
 *   symlink to the TCP port on 127.0.0.1; `/Library/Tailscale/sameuserproof-<port>`
 *   holds the token (readable by the admin group).
 * - macOS App Store app: a file `sameuserproof-<port>-<token>` in the app's
 *   group container (`~/Library/Group Containers/io.tailscale.ipn.macos`).
 * - tailscaled (Linux, the open-source macOS daemon): a unix socket.
 *
 * The token goes in HTTP Basic auth (empty user) and never into a log.
 * Anything unexpected (no endpoint, refused, 401/403, a bad answer) is a
 * failure the caller answers by falling back to the CLI.
 */
export type LocalApiEndpoint =
	| { kind: "tcp"; port: number; token: string }
	| { kind: "unix"; path: string };

export interface LocalApiFs {
	readlink(path: string): Promise<string>;
	readFile(path: string): Promise<string>;
	readdir(path: string): Promise<string[]>;
	isSocket(path: string): Promise<boolean>;
}

const realFs: LocalApiFs = {
	readlink: (p) => readlink(p),
	readFile: (p) => readFile(p, "utf8"),
	readdir: (p) => readdir(p),
	isSocket: async (p) => (await stat(p)).isSocket(),
};

const MACSYS_DIR = "/Library/Tailscale";
const UNIX_SOCKETS = [
	"/var/run/tailscale/tailscaled.sock",
	"/run/tailscale/tailscaled.sock",
	"/var/run/tailscaled.socket",
];

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
	try {
		return await fn();
	} catch {
		return null;
	}
}

function port(s: string | null | undefined): number | null {
	if (!s || !/^\d{1,5}$/.test(s)) return null;
	const n = Number(s);
	return n > 0 && n < 65536 ? n : null;
}

/** Where this machine's LocalAPI is, or null (the caller uses the CLI). */
export async function discoverLocalApi(
	opts: { platform?: NodeJS.Platform; home?: string; fs?: LocalApiFs } = {},
): Promise<LocalApiEndpoint | null> {
	const platform = opts.platform ?? process.platform;
	const fs = opts.fs ?? realFs;
	if (platform === "darwin") {
		const p = port(
			await attempt(() => fs.readlink(join(MACSYS_DIR, "ipnport"))),
		);
		if (p) {
			const token = (
				await attempt(() => fs.readFile(join(MACSYS_DIR, `sameuserproof-${p}`)))
			)?.trim();
			if (token) return { kind: "tcp", port: p, token };
		}
		const shared = join(
			opts.home ?? homedir(),
			"Library",
			"Group Containers",
			"io.tailscale.ipn.macos",
		);
		for (const name of (await attempt(() => fs.readdir(shared))) ?? []) {
			const m = /^sameuserproof-(\d+)-(.+)$/.exec(name);
			const p2 = port(m?.[1]);
			if (p2 && m?.[2]) return { kind: "tcp", port: p2, token: m[2] };
		}
	}
	for (const path of UNIX_SOCKETS)
		if (await attempt(() => fs.isSocket(path))) return { kind: "unix", path };
	return null;
}

export interface LocalApiResponse {
	status: number;
	body: string;
}

/** One GET to the LocalAPI; rejects on a connection error or timeout. */
export function localApiGet(
	ep: LocalApiEndpoint,
	path: string,
	timeoutMs: number,
): Promise<LocalApiResponse> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				...(ep.kind === "tcp"
					? {
							host: "127.0.0.1",
							port: ep.port,
							auth: `:${ep.token}`,
						}
					: { socketPath: ep.path }),
				path,
				method: "GET",
				// tailscaled's CSRF guard for LocalAPI calls.
				headers: { Host: "local-tailscaled.sock", "Sec-Tailscale": "localapi" },
				timeout: timeoutMs,
				agent: false,
			},
			(res) => {
				const chunks: Buffer[] = [];
				let size = 0;
				res.on("data", (c: Buffer) => {
					size += c.length;
					if (size > 4 * 1024 * 1024) req.destroy(new Error("too large"));
					else chunks.push(c);
				});
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
				res.on("error", reject);
			},
		);
		req.on("timeout", () => req.destroy(new Error("LocalAPI timed out")));
		req.on("error", reject);
		req.end();
	});
}
