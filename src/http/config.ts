import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../paths.ts";
import { type TailscaleSelf, tailscaleSelf } from "./identity.ts";

/** The port the app and API listen on. */
export const DEFAULT_PORT = 7337;

/**
 * How (and whether) the daemon serves the app:
 * - `off` (the default for now);
 * - `dev`: `PULSAR_DEV_IDENTITY=<login>`; plain HTTP on 127.0.0.1, every
 *   connection is that login;
 * - `tailscale`: the `remote` setting or `PULSAR_REMOTE=1`; TLS on this
 *   node's Tailscale addresses, identity from `tailscale whois`.
 */
export type RemoteConfig =
	| { mode: "off" }
	| { mode: "dev"; login: string; port: number }
	| { mode: "tailscale"; port: number };

export interface Settings {
	remote?: boolean;
	/**
	 * A certificate the operator brings instead of `tailscale cert` (needed
	 * on a self-hosted control server such as Headscale). Absolute paths.
	 */
	tls?: { cert: string; key: string; ca?: string };
	/** The WebAuthn RP id, when the MagicDNS suffix is not the one wanted. */
	rpId?: string;
}

/** The brought certificate from settings, when all its paths are strings. */
export function tlsSetting(
	settings: Settings,
): { cert: string; key: string; ca?: string } | null {
	const t = settings.tls;
	if (!t || typeof t.cert !== "string" || typeof t.key !== "string")
		return null;
	return {
		cert: t.cert,
		key: t.key,
		...(typeof t.ca === "string" && t.ca ? { ca: t.ca } : {}),
	};
}

function settingsPath() {
	return join(stateDir(), "settings.json");
}

function parseSettings(text: string): Settings {
	try {
		const raw = JSON.parse(text) as unknown;
		return raw && typeof raw === "object" ? (raw as Settings) : {};
	} catch {
		return {};
	}
}

/** The settings file, for CLI commands (`pulsar mesh`, setup, doctor). */
export function readSettings(): Settings {
	try {
		// sync-ok: CLI only; the daemon uses readSettingsAsync
		return parseSettings(readFileSync(settingsPath(), "utf8"));
	} catch {
		return {};
	}
}

/** The settings file, without blocking (the daemon). */
export async function readSettingsAsync(): Promise<Settings> {
	try {
		return parseSettings(await readFile(settingsPath(), "utf8"));
	} catch {
		return {};
	}
}

/** Merges into the settings file (CLI: `pulsar mesh`, setup). */
export function writeSettings(next: Settings) {
	// sync-ok: CLI only
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	// sync-ok: CLI only
	writeFileSync(
		settingsPath(),
		`${JSON.stringify({ ...readSettings(), ...next }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
}

/** The app port: `PULSAR_HTTP_PORT`, else 7337. */
export function envPort(env: NodeJS.ProcessEnv = process.env): number {
	const n = Number(env.PULSAR_HTTP_PORT);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

export function remoteConfig(
	env: NodeJS.ProcessEnv = process.env,
	settings: Settings = readSettings(),
): RemoteConfig {
	const dev = env.PULSAR_DEV_IDENTITY?.trim();
	if (dev) return { mode: "dev", login: dev, port: envPort(env) };
	const flag = env.PULSAR_REMOTE?.trim().toLowerCase();
	const on =
		flag === "1" || flag === "true" || flag === "on"
			? true
			: flag === "0" || flag === "false" || flag === "off"
				? false
				: settings.remote === true;
	return on ? { mode: "tailscale", port: envPort(env) } : { mode: "off" };
}

/**
 * The agent mesh is on: the app and the pool are served on this node (the
 * `remote` setting from `pulsar mesh on`, `PULSAR_REMOTE`, or dev mode).
 */
export function meshIsOn(): boolean {
	return remoteConfig().mode !== "off";
}

/** Why there is no app while the mesh is off. */
export const MESH_OFF = "the agent mesh is off; run `pulsar mesh on`";

/** `https://<node>.<MagicDNS suffix>:7337/` (no port for 443). */
export function tailnetUrl(dnsName: string, port: number): string {
	return `https://${dnsName}${port === 443 ? "" : `:${port}`}/`;
}

/**
 * The app's URL for this node: its MagicDNS name (the pool service name once
 * that exists), or the loopback address in dev mode. Null when the app is
 * off or Tailscale has no name for this node.
 */
export async function appUrl(
	cfg: RemoteConfig = remoteConfig(),
	self: () => Promise<TailscaleSelf | null> = () => tailscaleSelf(),
): Promise<string | null> {
	if (cfg.mode === "off") return null;
	if (cfg.mode === "dev") return `http://127.0.0.1:${cfg.port}/`;
	const me = await self();
	return me ? tailnetUrl(me.dnsName, cfg.port) : null;
}

/**
 * The app URL for `pulsar qr`, `pulsar ui` and setup, or the reason there is
 * none (the app is off, or Tailscale has no name for this node).
 */
export async function appUrlOrReason(
	cfg: RemoteConfig = remoteConfig(),
	self: () => Promise<TailscaleSelf | null> = () => tailscaleSelf(),
): Promise<{ url: string } | { reason: string }> {
	if (cfg.mode === "off") return { reason: MESH_OFF };
	const url = await appUrl(cfg, self);
	return url
		? { url }
		: {
				reason:
					"Tailscale has no name for this node (is it running and signed in?)",
			};
}
