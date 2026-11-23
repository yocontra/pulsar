import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { exec, type Lane } from "../exec.ts";
import type { ProcessInfo } from "../processes.ts";

/**
 * Talking to OpenCode's background service (OpenCode 2.2.5).
 *
 * The service writes its URL, password and pid to
 * `$XDG_STATE_HOME/opencode/service.json` (HTTP Basic, user `opencode`).
 * Requests go there over HTTP first: no child process per call. When that
 * fails, the same request goes through `opencode api`, run from the
 * service's own executable: the daemon's PATH may find another, older
 * `opencode` first (Homebrew's 1.x has no `api` command and prints its
 * banner instead), which made every scan, push and prompt read fail.
 */

const SERVICE_ARGS = /opencode(\S*)? serve\b.*--service/;

/** OpenCode's shared background server process, if one runs (never starts one). */
function opencodeServiceProcess(
	table: Map<number, ProcessInfo>,
): ProcessInfo | null {
	for (const p of table.values()) if (SERVICE_ARGS.test(p.args)) return p;
	return null;
}

/** True when OpenCode's shared background server is running. */
export function opencodeServiceRunning(
	table: Map<number, ProcessInfo>,
): boolean {
	return opencodeServiceProcess(table) !== null;
}

/** The service's own executable: argv[0] of the process `service.json` names. */
function serviceExe(
	table: Map<number, ProcessInfo>,
	servicePid: number | null,
): string | null {
	const p = servicePid ? table.get(servicePid) : undefined;
	const argv0 = p && SERVICE_ARGS.test(p.args) ? p.args.split(/\s+/)[0]! : "";
	return isAbsolute(argv0) && /^opencode/i.test(basename(argv0)) ? argv0 : null;
}

/** OpenCode's own installer puts it here (`curl … | bash`). */
export const OPENCODE_HOME_BIN = () =>
	join(process.env.HOME || homedir(), ".opencode", "bin", "opencode");

/** The first major version with `opencode api` and the 2.x service. */
const MIN_MAJOR = 2;

/** `opencode --version` by executable, kept while the file is unchanged. */
const versions = new Map<string, { mtimeMs: number; version: string | null }>();

/** An executable's version ("2.2.5"), or null when it does not say. */
async function opencodeVersion(bin: string): Promise<string | null> {
	const path = isAbsolute(bin) ? bin : await whichAsync(bin);
	if (!path) return null;
	const st = await stat(path).catch(() => null);
	if (!st) return null;
	const hit = versions.get(path);
	if (hit && hit.mtimeMs === st.mtimeMs) return hit.version;
	const r = await exec(path, ["--version"], { timeoutMs: 4000 });
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(r.ok ? r.stdout : "");
	const version = m ? m[0] : null;
	if (versions.size > 50) versions.clear();
	versions.set(path, { mtimeMs: st.mtimeMs, version });
	return version;
}

/** True unless the version is known and too old for `opencode api`. */
function apiCapable(version: string | null): boolean {
	if (!version) return true;
	return Number(version.split(".")[0]) >= MIN_MAJOR;
}

/**
 * An `opencode` that a PATH finds first but that is too old for
 * `opencode api` (doctor: the daemon's PATH), or null.
 */
export async function staleOpencodeOnPath(
	pathEnv: string,
): Promise<{ path: string; version: string } | null> {
	const path = await whichAsync("opencode", pathEnv);
	if (!path) return null;
	const version = await opencodeVersion(path);
	return version && !apiCapable(version) ? { path, version } : null;
}

async function whichAsync(
	name: string,
	pathEnv = process.env.PATH ?? "",
): Promise<string | null> {
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		const p = join(dir, name);
		if (
			await access(p, constants.X_OK).then(
				() => true,
				() => false,
			)
		)
			return p;
	}
	return null;
}

/**
 * The `opencode` executable to run `opencode api` with, never trusting PATH
 * order alone (the daemon's PATH may find Homebrew's 1.x first, which has
 * no `api` and prints its banner): the running service's own executable;
 * else the one on PATH when it is new enough (or does not say); else
 * OpenCode's installer location; else plain `opencode`.
 */
export async function opencodeBin(
	table: Map<number, ProcessInfo>,
	servicePid: number | null,
): Promise<string> {
	const own = serviceExe(table, servicePid);
	if (own) return own;
	if (apiCapable(await opencodeVersion("opencode"))) return "opencode";
	const home = OPENCODE_HOME_BIN();
	if (
		await access(home, constants.X_OK).then(
			() => true,
			() => false,
		)
	)
		return home;
	return "opencode";
}

export interface ServiceEndpoint {
	url: string;
	auth: string;
	pid: number | null;
}

/** The service's URL and password from its `service.json`; null when unreadable. */
async function serviceEndpoint(): Promise<ServiceEndpoint | null> {
	const state =
		process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	try {
		const s = JSON.parse(
			await readFile(join(state, "opencode", "service.json"), "utf8"),
		) as { url?: unknown; password?: unknown; pid?: unknown };
		if (
			typeof s.url !== "string" ||
			!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/.test(s.url)
		)
			return null;
		const auth =
			typeof s.password === "string" && s.password
				? `Basic ${Buffer.from(`opencode:${s.password}`).toString("base64")}`
				: "";
		return {
			url: s.url.replace(/\/$/, ""),
			auth,
			pid: typeof s.pid === "number" ? s.pid : null,
		};
	} catch {
		return null;
	}
}

export type ApiResult =
	| { ok: true; body: unknown }
	| { ok: false; status: number | null; error: string };

export interface ApiOptions {
	/** JSON request body. */
	body?: unknown;
	timeoutMs?: number;
	lane?: Lane;
	/** HTTP to the service only, never `opencode api` (an optional read). */
	httpOnly?: boolean;
}

/**
 * One request to the running service: HTTP, then `opencode api` from the
 * service's executable. Callers check that the service runs first
 * (`opencode api` starts one when none does).
 */
export async function opencodeRequest(
	table: Map<number, ProcessInfo>,
	method: "GET" | "POST" | "DELETE",
	path: string,
	opts: ApiOptions = {},
): Promise<ApiResult> {
	const timeoutMs = opts.timeoutMs ?? 8000;
	const ep = await serviceEndpoint();
	let httpError: ApiResult | null = null;
	if (ep)
		try {
			const r = await fetch(ep.url + path, {
				method,
				headers: {
					...(ep.auth ? { authorization: ep.auth } : {}),
					...(opts.body !== undefined
						? { "content-type": "application/json" }
						: {}),
				},
				...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
				signal: AbortSignal.timeout(timeoutMs),
			});
			const text = await r.text();
			if (r.ok) {
				try {
					return { ok: true, body: text ? JSON.parse(text) : null };
				} catch {
					return { ok: true, body: text };
				}
			}
			httpError = {
				ok: false,
				status: r.status,
				error: `${r.status} ${text.slice(0, 300)}`,
			};
			// A read is tried again through the CLI unless the service said 404
			// (a session that is gone). A write (a prompt, a reply, an
			// interrupt) only when the service refused it unread (auth
			// changed): a 5xx may have done it, and twice is worse than not.
			const retry =
				method === "GET"
					? r.status !== 404
					: r.status === 401 || r.status === 403;
			if (!retry) return httpError;
		} catch (e) {
			// A write that timed out may have reached the service: never sent twice.
			const name = (e as Error).name;
			if (
				method !== "GET" &&
				(name === "TimeoutError" || name === "AbortError")
			)
				return { ok: false, status: null, error: "timed out" };
		}
	if (opts.httpOnly)
		return httpError ?? { ok: false, status: null, error: "no service" };
	const r = await exec(
		await opencodeBin(table, ep?.pid ?? null),
		[
			"api",
			method,
			path,
			...(opts.body !== undefined ? ["-d", JSON.stringify(opts.body)] : []),
		],
		{
			timeoutMs,
			maxBuffer: 32 * 1024 * 1024,
			lane: opts.lane ?? "background",
		},
	);
	if (!r.ok)
		return httpError ?? { ok: false, status: null, error: r.error ?? "failed" };
	try {
		return { ok: true, body: r.stdout.trim() ? JSON.parse(r.stdout) : null };
	} catch {
		return { ok: false, status: null, error: "not JSON" };
	}
}

/** A GET's body, unwrapped from the service's `{data: …}`; null when it failed. */
export async function opencodeGet<T>(
	table: Map<number, ProcessInfo>,
	path: string,
	opts: Omit<ApiOptions, "body"> = {},
): Promise<T | null> {
	const r = await opencodeRequest(table, "GET", path, opts);
	if (!r.ok) return null;
	const body = r.body as { data?: T } | T | null;
	if (body && typeof body === "object" && "data" in body)
		return (body as { data?: T }).data ?? null;
	return body as T | null;
}
