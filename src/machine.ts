import { execFile } from "node:child_process";
import { hostname } from "node:os";

/**
 * A machine name usable as a selector value (`machine=<name>`): lowercase,
 * no whitespace, commas, `|` or `=`.
 */
export function cleanMachineName(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[\s,|=]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** `os.hostname()` without a trailing `.local`. */
export function hostMachineName(host = hostname()): string {
	return cleanMachineName(host.replace(/\.local\.?$/i, "")) || "localhost";
}

/** The MagicDNS short name in `tailscale status --json` output, or null. */
export function magicDnsName(status: unknown): string | null {
	if (!status || typeof status !== "object") return null;
	const s = status as { BackendState?: unknown; Self?: { DNSName?: unknown } };
	if (s.BackendState !== undefined && s.BackendState !== "Running") return null;
	const dns = typeof s.Self?.DNSName === "string" ? s.Self.DNSName : "";
	return cleanMachineName(dns.split(".")[0] ?? "") || null;
}

/** Where the Tailscale CLI lives: on PATH, or inside the macOS app. */
export const TAILSCALE_BINS = [
	"tailscale",
	"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

const CACHE_MS = 10 * 60_000;
let cached: { at: number; name: Promise<string | null> } | null = null;

function statusFrom(bin: string, timeoutMs: number): Promise<string | null> {
	return new Promise((resolve) => {
		try {
			execFile(
				bin,
				["status", "--json"],
				{ timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
				(err, stdout) => {
					if (err) return resolve(null);
					try {
						resolve(magicDnsName(JSON.parse(stdout)));
					} catch {
						resolve(null);
					}
				},
			).on("error", () => resolve(null));
		} catch {
			resolve(null);
		}
	});
}

/**
 * This node's MagicDNS short name; null when Tailscale is missing, stopped
 * or slow. Cached for ten minutes per process. Never throws.
 */
export function tailscaleName(timeoutMs = 2000): Promise<string | null> {
	const now = Date.now();
	if (cached && now - cached.at < CACHE_MS) return cached.name;
	const name = (async () => {
		for (const bin of TAILSCALE_BINS) {
			const found = await statusFrom(bin, timeoutMs);
			if (found) return found;
		}
		return null;
	})();
	cached = { at: now, name };
	return name;
}
