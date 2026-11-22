/**
 * `pulsar doctor`'s results as data, shared by the CLI (which prints them)
 * and the daemon (which serves them to the app, `GET /diagnostics`). Also
 * what a machine's report may say once it leaves the machine: redacted on
 * the way out, checked and bounded on the way in. No I/O here: the daemon
 * imports this module.
 */

import { clean } from "../federation/protocol.ts";
import type {
	DiagCheck,
	DiagFacts,
	DiagHarness,
	DiagLevel,
	LocalDiagnostics,
} from "../http/wire.ts";
import { newer } from "../util.ts";

const MARK: Record<DiagLevel, string> = { ok: "✓", note: "·", bad: "✗" };

/** A check as one CLI line: `✗ text: fix`. */
export function checkLine(c: Pick<DiagCheck, "level" | "text" | "fix">) {
	return `${MARK[c.level]} ${c.fix ? `${c.text}: ${c.fix}` : c.text}`;
}

/** Collects checks in order; `group` names where the next ones belong. */
export class Checks {
	readonly list: DiagCheck[] = [];
	group = "daemon";
	private readonly onAdd: ((c: DiagCheck) => void) | undefined;

	constructor(onAdd?: (c: DiagCheck) => void) {
		this.onAdd = onAdd;
	}

	private add(level: DiagLevel, text: string, fix?: string) {
		const c = { group: this.group, level, text, fix: fix ?? null };
		this.list.push(c);
		this.onAdd?.(c);
	}

	ok = (text: string) => this.add("ok", text);
	bad = (text: string, fix?: string) => this.add("bad", text, fix);
	note = (text: string, fix?: string) => this.add("note", text, fix);

	get problems(): number {
		return this.list.filter((c) => c.level === "bad").length;
	}
}

/** The doctor's machine-readable answer (`pulsar doctor --json`). */
export interface DoctorJson {
	version: string;
	checks: DiagCheck[];
	facts: DiagFacts;
}

/*
 * Redaction. Doctor's text names files and repeats error messages, which
 * may carry an account name, a key or a token. Before a report leaves the
 * machine: the home folder becomes `~` (and so does any other user's), and
 * anything shaped like a credential becomes `[redacted]`.
 */
const SECRETS: RegExp[] = [
	// Tailscale auth and API keys.
	/\btskey-[A-Za-z0-9-]+/g,
	// GitHub, OpenAI/Anthropic-style, Slack, AWS and npm tokens.
	/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g,
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bnpm_[A-Za-z0-9]{20,}/g,
	// JSON web tokens.
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	// Long runs of hex or base64 with a digit in them (keys, secrets,
	// signatures). Never across `/` or `.`, so file paths stay whole.
	/\b[A-Fa-f0-9]{32,}\b/g,
	/(?<![A-Za-z0-9+_./-])(?=[A-Za-z+_-]*\d)[A-Za-z0-9+_-]{40,}={0,2}(?![A-Za-z0-9+_./-])/g,
];

/** Escapes a string for a RegExp. */
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One string of a report, safe to show on another machine. */
export function redact(text: string, home: string): string {
	let s = text;
	// `Authorization: Bearer x`, `token=x`, `password: x`, `user:pass@host`.
	s = s.replace(
		/\b(bearer|basic)\s+(?!\[redacted\])[^\s"',;)\]}]+/gi,
		"$1 [redacted]",
	);
	s = s.replace(
		/\b([A-Za-z_-]*(?:token|secret|password|passwd|apikey|api_key|auth|key|sig|signature|credential)s?"?\s*[=:]\s*"?)(?!\[redacted\])[^\s"'&,;)\]}]+/gi,
		"$1[redacted]",
	);
	s = s.replace(
		/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
		"$1[redacted]@",
	);
	if (home && home !== "/")
		s = s.replace(new RegExp(`${reEscape(home)}(?=/|\\b|$)`, "g"), "~");
	s = s.replace(/(^|[\s'"(=:])\/(?:Users|home)\/[^/\s'")]+/g, "$1~");
	for (const re of SECRETS) s = s.replace(re, "[redacted]");
	return s;
}

/** A report with every string redacted. */
export function redactReport(
	r: LocalDiagnostics,
	home: string,
): LocalDiagnostics {
	const red = (v: string) => redact(v, home);
	const ts = r.facts.tailscale;
	return {
		...r,
		checks: r.checks.map((c) => ({
			...c,
			text: red(c.text),
			fix: c.fix === null ? null : red(c.fix),
		})),
		facts: {
			...r.facts,
			tailscale: ts && { ...ts, version: ts.version && red(ts.version) },
			harnesses: r.facts.harnesses.map((h) => ({
				...h,
				version: h.version && red(h.version),
			})),
		},
	};
}

/*
 * Taking a report as data: a peer's (over federation) or the doctor child's
 * (its stdout). Every field checked and bounded; unknown levels dropped.
 */
const LEVELS = new Set<DiagLevel>(["ok", "note", "bad"]);
const MAX_CHECKS = 200;

/** A string without control or bidi characters, bounded; null when empty. */
function text(v: unknown, max: number): string | null {
	return typeof v === "string" ? clean(v, max) || null : null;
}

function num(v: unknown, max: number): number | null {
	const n = Number(v);
	return v !== null && v !== "" && Number.isFinite(n)
		? Math.max(-max, Math.min(max, n))
		: null;
}

function obj(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

export function cleanChecks(v: unknown): DiagCheck[] {
	const out: DiagCheck[] = [];
	for (const raw of Array.isArray(v) ? v.slice(0, MAX_CHECKS) : []) {
		const c = obj(raw);
		const t = text(c.text, 500);
		if (!t || !LEVELS.has(c.level as DiagLevel)) continue;
		out.push({
			group: text(c.group, 40) ?? "other",
			level: c.level as DiagLevel,
			text: t,
			fix: text(c.fix, 300),
		});
	}
	return out;
}

export function cleanFacts(v: unknown): DiagFacts {
	const f = obj(v);
	const ts = f.tailscale ? obj(f.tailscale) : null;
	const harnesses: DiagHarness[] = [];
	for (const raw of Array.isArray(f.harnesses)
		? f.harnesses.slice(0, 20)
		: []) {
		const h = obj(raw);
		const id = text(h.id, 40);
		if (!id) continue;
		harnesses.push({
			id,
			label: text(h.label, 40) ?? id,
			version: text(h.version, 60),
			configured: h.configured === true,
		});
	}
	return {
		tailscale: ts && {
			state: text(ts.state, 30) ?? "unknown",
			version: text(ts.version, 60),
			dnsName: text(ts.dnsName, 260),
			magicDns: typeof ts.magicDns === "boolean" ? ts.magicDns : null,
		},
		certDays: num(f.certDays, 100_000),
		harnesses,
	};
}

/** A machine's report from elsewhere; null when it is not one. */
export function cleanLocalDiagnostics(v: unknown): LocalDiagnostics | null {
	const r = obj(v);
	const version = text(r.version, 40);
	if (!version || !Array.isArray(r.checks)) return null;
	const lag = r.eventLoop ? obj(r.eventLoop) : null;
	return {
		version,
		platform: text(r.platform, 20) ?? "unknown",
		uptimeS: Math.max(0, num(r.uptimeS, 1e9) ?? 0),
		agents: Math.max(0, Math.floor(num(r.agents, 1e6) ?? 0)),
		eventLoop: lag && {
			p99: Math.max(0, num(lag.p99, 1e7) ?? 0),
			max: Math.max(0, num(lag.max, 1e7) ?? 0),
			stalls: Math.max(0, Math.floor(num(lag.stalls, 1e9) ?? 0)),
		},
		checks: cleanChecks(r.checks),
		facts: cleanFacts(r.facts),
		checkedAt: Math.max(0, num(r.checkedAt, 1e15) ?? 0),
	};
}

/**
 * Version skew: the newest version in the pool, and for each machine on an
 * older one, what to do. Unknown versions are left out.
 */
export function versionSkew(
	machines: { name: string; version: string | null }[],
): { newest: string | null; upgrade: Map<string, string> } {
	let newest: string | null = null;
	for (const m of machines)
		if (m.version && (!newest || newer(m.version, newest))) newest = m.version;
	const upgrade = new Map<string, string>();
	if (newest)
		for (const m of machines)
			if (m.version && newer(newest, m.version))
				upgrade.set(
					m.name,
					`upgrade pulsar on ${m.name} (${m.version}; newest is ${newest})`,
				);
	return { newest, upgrade };
}
