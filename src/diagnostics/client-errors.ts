/**
 * App load errors the app reports about itself (`POST /api/v1/client-errors`,
 * web/public/boot.js): a chunk, module or service worker that didn't load on
 * the operator's device. The daemon logs one line per report and keeps the
 * last few in memory for `pulsar doctor` (through `status`) and with it the
 * app's Diagnostics page. Reports carry no message text, drafts or tokens:
 * build ids, file names, error names and messages, and the device's state.
 * No I/O and no zod here: the daemon's service imports it.
 */

/** What failed to load. */
export const CLIENT_ERROR_KINDS = [
	// The entry, a <script>/<link> or an error before the app mounted (boot.js).
	"boot",
	// A lazy screen's chunk (src/lib/lazy.tsx), before or after its reload.
	"chunk",
	// The lazy Ionic components or their style registry (src/mobile).
	"ionic",
	// A module-load error seen by window `error`/`unhandledrejection`.
	"module",
	// The service worker: register, install or activate.
	"sw-register",
	"sw-install",
	"sw-activate",
] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

/** One report, as the route accepts it (src/diagnostics/client-errors-schema.ts). */
export interface ClientErrorReport {
	kind: ClientErrorKind;
	/** The page's build (`<meta name="pulsar-build">`), or the worker's. */
	build: string;
	/** The files that failed, when known (`/_app/x.js`). */
	urls: string[];
	error: { name: string; message: string };
	sw: {
		/** The controlling worker's build, from a message to it; null without one. */
		controller: string | null;
		/** The registration: `active`, `installing`, `waiting`, `none`, `unsupported`. */
		state: string;
		caches: string[];
		/** Build files the worker failed to fetch lately (`/_app/x.js 404`). */
		failed: string[];
	};
	online: boolean;
	standalone: boolean;
	ua: string;
	/** The hash route, without a query (`/a/:id`). */
	route: string;
	/** The page reloaded for this failure already (boot.js's one retry). */
	reloaded: boolean;
	/** When the device saw it (ms). */
	at: number;
}

/** A report as kept: what it said and when the daemon got it. */
export interface ClientErrorEntry extends ClientErrorReport {
	receivedAt: number;
}

/** `status.clientErrors`: what doctor shows. */
export interface ClientErrorSummary {
	/** Reports kept (the last `KEEP`). */
	count: number;
	/** Reports refused by the rate limit since the daemon started. */
	dropped: number;
	byBuild: Record<string, number>;
	byUrl: Record<string, number>;
	last: {
		receivedAt: number;
		kind: ClientErrorKind;
		build: string;
		url: string | null;
		error: string;
	} | null;
}

/** Reports kept in memory. */
export const KEEP = 50;
/** Reports accepted per minute from every device together. */
export const PER_MINUTE = 30;

/** One line of untrusted text: no control characters, bounded. */
export function oneLine(s: string, max = 200): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them
	const t = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The file a report is about: its first failing URL, else the worker's. */
export function failingUrl(r: ClientErrorReport): string | null {
	const u = r.urls[0] ?? r.sw.failed[0]?.split(" ")[0];
	if (!u) return null;
	try {
		// Same-origin URLs as paths; never a query.
		const p = new URL(u, "http://x");
		return p.pathname;
	} catch {
		return oneLine(u, 120);
	}
}

/** The daemon.log line for a report. */
export function clientErrorLine(r: ClientErrorReport): string {
	const err = oneLine(`${r.error.name}: ${r.error.message}`, 200);
	const sw = `${r.sw.controller ?? "none"}/${r.sw.state}`;
	const failed = r.sw.failed.length
		? ` swfailed=${oneLine(r.sw.failed.join(","), 200)}`
		: "";
	return oneLine(
		`client load error: kind=${r.kind} build=${r.build} sw=${sw} url=${failingUrl(r) ?? "-"} err=${err} route=${r.route || "/"} online=${r.online} standalone=${r.standalone} reloaded=${r.reloaded} caches=${r.sw.caches.join(",") || "-"}${failed} ua=${oneLine(r.ua, 160)}`,
		900,
	);
}

/** The last reports, and a rate limit over every device. */
export class ClientErrors {
	private readonly list: ClientErrorEntry[] = [];
	private window: number[] = [];
	private dropped = 0;
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Keeps a report; false when over the rate limit (not kept). */
	add(r: ClientErrorReport): boolean {
		const now = this.now();
		this.window = this.window.filter((t) => now - t < 60_000);
		if (this.window.length >= PER_MINUTE) {
			this.dropped++;
			return false;
		}
		this.window.push(now);
		this.list.push({ ...r, receivedAt: now });
		if (this.list.length > KEEP) this.list.shift();
		return true;
	}

	recent(): readonly ClientErrorEntry[] {
		return this.list;
	}

	summary(): ClientErrorSummary {
		const byBuild: Record<string, number> = {};
		const byUrl: Record<string, number> = {};
		for (const r of this.list) {
			byBuild[r.build] = (byBuild[r.build] ?? 0) + 1;
			const u = failingUrl(r) ?? "(unknown file)";
			byUrl[u] = (byUrl[u] ?? 0) + 1;
		}
		const l = this.list.at(-1);
		return {
			count: this.list.length,
			dropped: this.dropped,
			byBuild,
			byUrl,
			last: l
				? {
						receivedAt: l.receivedAt,
						kind: l.kind,
						build: l.build,
						url: failingUrl(l),
						error: oneLine(`${l.error.name}: ${l.error.message}`, 160),
					}
				: null,
		};
	}
}

/** `a: 3, b: 1`, most first, at most `n`. */
function top(counts: Record<string, number>, n: number): string {
	const all = Object.entries(counts).sort((a, b) => b[1] - a[1]);
	const shown = all.slice(0, n).map(([k, v]) => `${k}: ${v}`);
	if (all.length > n) shown.push(`${all.length - n} more`);
	return shown.join(", ");
}

/** "3 min ago" for doctor. */
function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 90) return `${s} s ago`;
	const m = Math.round(s / 60);
	if (m < 90) return `${m} min ago`;
	return `${Math.round(m / 60)} h ago`;
}

/**
 * Doctor's note about recent app load errors, or null when there are none
 * (older daemons send no summary).
 */
export function clientErrorNote(
	s: ClientErrorSummary | undefined,
	now = Date.now(),
): { text: string; fix: string } | null {
	if (!s || (!s.count && !s.dropped)) return null;
	const parts = [
		`recent app load errors: ${s.count} report(s)`,
		s.dropped ? `${s.dropped} more over the rate limit` : "",
	].filter(Boolean);
	let text = parts.join(", ");
	if (s.count) {
		text += `; by build: ${top(s.byBuild, 3)}; by file: ${top(s.byUrl, 3)}`;
		if (s.last)
			text += `; last ${ago(now - s.last.receivedAt)}: ${s.last.kind}, ${s.last.error}`;
	}
	return {
		text: oneLine(text, 480),
		fix: "each report is a `client load error` line in daemon.log",
	};
}
