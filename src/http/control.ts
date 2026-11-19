import type { TailscaleRunner } from "./identity.ts";

/**
 * The control server this node's tailnet uses: Tailscale's hosted one
 * (tailscale.com) or a self-hosted one (Headscale). Only wording and the
 * checks that exist on tailscale.com alone depend on it: the admin console,
 * the HTTPS Certificates toggle and `tailscale cert`.
 */
export interface ControlPlane {
	kind: "tailscale" | "custom";
	/** `https://headscale.corp.example`; null when unknown. */
	url: string | null;
}

/** Tailscale's own control servers (`controlplane.tailscale.com`, `login.tailscale.com`). */
function tailscaleHosted(host: string): boolean {
	const h = host.toLowerCase();
	return h === "tailscale.com" || h.endsWith(".tailscale.com");
}

/** From a ControlURL (`tailscale debug prefs`); empty means Tailscale's default. */
export function classifyControlUrl(
	url: string | null | undefined,
): ControlPlane {
	const u = (url ?? "").trim();
	if (!u) return { kind: "tailscale", url: null };
	try {
		const host = new URL(u).hostname;
		return { kind: tailscaleHosted(host) ? "tailscale" : "custom", url: u };
	} catch {
		return { kind: "custom", url: u };
	}
}

/**
 * The fallback when prefs are unreadable: tailscale.com gives every tailnet
 * a MagicDNS suffix under `ts.net`; any other suffix is a self-hosted server.
 */
export function controlFromSuffix(
	suffix: string | null | undefined,
): ControlPlane {
	const s = (suffix ?? "").toLowerCase().replace(/\.$/, "");
	const hosted = s === "ts.net" || s.endsWith(".ts.net");
	return { kind: hosted || !s ? "tailscale" : "custom", url: null };
}

/**
 * Reads the ControlURL from `tailscale debug prefs` (read-only LocalAPI; no
 * operator rights needed), else guesses from the MagicDNS suffix.
 */
export async function readControlPlane(
	run: TailscaleRunner,
	suffix: string | null,
): Promise<ControlPlane> {
	const r = await run(["debug", "prefs"], 3000);
	if (r.ok) {
		try {
			const prefs = JSON.parse(r.stdout) as { ControlURL?: unknown };
			if (typeof prefs.ControlURL === "string")
				return classifyControlUrl(prefs.ControlURL);
		} catch {}
	}
	return controlFromSuffix(suffix);
}

/** How setup and doctor name the control server. */
export function controlLabel(c: ControlPlane): string {
	if (c.kind === "tailscale") return "tailscale.com";
	if (!c.url) return "a self-hosted control server";
	try {
		return `self-hosted (${new URL(c.url).host})`;
	} catch {
		return `self-hosted (${c.url})`;
	}
}
