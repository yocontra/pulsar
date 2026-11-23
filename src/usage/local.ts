/**
 * Local models: tokens a model on the operator's own hardware answered
 * cost nothing, so their usage is priced at $0 instead of left unpriced.
 *
 * A record is local when the provider that answered it is: the provider's
 * base URL in the harness's own config points at this machine or a
 * private network, or (with no URL in the config) the provider is a
 * local runtime by name (Ollama, LM Studio, llama.cpp, MLX, vLLM). A model
 * name alone never makes a record local. The scanner stores a local
 * record's model id with `LOCAL_TAG` appended, so the tag travels with
 * the tokens to every machine that prices them.
 *
 * A loopback proxy in front of a hosted API also reads as local ($0).
 */

import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";

export { isLocalModel, LOCAL_TAG, modelName, tagLocal } from "./prices.ts";

/** Local runtimes by provider name, used only when the config gives no URL. */
const LOCAL_NAMES = new Set([
	"ollama",
	"lmstudio",
	"lm-studio",
	"llama.cpp",
	"llamacpp",
	"llama-cpp",
	"mlx",
	"mlx-lm",
	"vllm",
	"local",
	// Codex's `--oss` provider (Ollama on this machine).
	"oss",
]);

/** Ollama's hosted models (`glm-5.3-flash:cloud`, `gpt-oss:120b-cloud`) run on Ollama's servers. */
const CLOUD_ID = /[:-]cloud$/i;

function privateV4(ip: string): boolean {
	const [a = -1, b = -1] = ip.split(".").map(Number);
	return (
		a === 127 ||
		a === 10 ||
		a === 0 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254) ||
		// Carrier-grade NAT: Tailscale and similar private overlays.
		(a === 100 && b >= 64 && b <= 127)
	);
}

/**
 * A base URL on this machine or a private network: loopback, private and
 * link-local ranges, Tailscale's 100.64/10 and `*.ts.net`, and `.local`,
 * `.lan`, `.home.arpa` names. An unparseable URL is not local.
 */
export function isLocalUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	host = host.replace(/^\[|\]$/g, "");
	if (!host) return false;
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (/\.(local|lan|home\.arpa|ts\.net)$/.test(host)) return true;
	const v = isIP(host);
	if (v === 4) return privateV4(host);
	if (v === 6) {
		if (host === "::1" || host === "::") return true;
		// IPv4-mapped: URL writes ::ffff:192.168.0.2 as ::ffff:c0a8:2.
		const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
		if (mapped) {
			const hi = Number.parseInt(mapped[1]!, 16);
			const lo = Number.parseInt(mapped[2]!, 16);
			return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
		}
		// fc00::/7 (unique local) and fe80::/10 (link-local).
		return /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
	}
	return false;
}

/** A harness's configured providers: base URL (null when none) and model ids. */
export type Providers = Map<
	string,
	{ baseUrl: string | null; models: string[] }
>;

/** Whether `provider` serving `model` runs locally, per the harness config. */
export function isLocalProvider(
	provider: string,
	model: string,
	providers: Providers,
): boolean {
	if (CLOUD_ID.test(model)) return false;
	const p = provider.trim().toLowerCase();
	const url = providers.get(p)?.baseUrl;
	if (url) return isLocalUrl(url);
	return LOCAL_NAMES.has(p);
}

/**
 * Model ids the config lists only under local providers: what history
 * written before tagging can be retagged by.
 */
export function localOnlyModels(providers: Providers): Set<string> {
	const local = new Set<string>();
	const remote = new Set<string>();
	for (const [name, p] of providers)
		for (const m of p.models)
			(isLocalProvider(name, m, providers) ? local : remote).add(m);
	for (const m of remote) local.delete(m);
	return local;
}

const unquote = (v: string) =>
	v
		.replace(/\s+#.*$/, "")
		.trim()
		.replace(/^(["'])(.*)\1$/, "$2");

/**
 * pi and omp `models.json`: `{ providers: { <name>: { baseUrl, models: [{ id }] } } }`.
 */
export function providersFromJson(text: string): Providers {
	const out: Providers = new Map();
	let d: unknown;
	try {
		d = JSON.parse(text);
	} catch {
		return out;
	}
	const ps = (d as { providers?: unknown })?.providers;
	if (!ps || typeof ps !== "object" || Array.isArray(ps)) return out;
	for (const [name, v] of Object.entries(ps as Record<string, unknown>)) {
		if (!v || typeof v !== "object") continue;
		const p = v as { baseUrl?: unknown; models?: unknown };
		const models = Array.isArray(p.models)
			? p.models
					.map((m) => (m as { id?: unknown })?.id)
					.filter((id): id is string => typeof id === "string" && !!id)
			: [];
		out.set(name.toLowerCase(), {
			baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : null,
			models,
		});
	}
	return out;
}

/**
 * omp's `models.yml`, the same shape as `models.json` in block YAML. Reads
 * only `providers` → name → `baseUrl` and the model list's `id`s; anything
 * else (flow style, anchors) yields fewer providers, never wrong ones.
 */
export function providersFromYaml(text: string): Providers {
	const out: Providers = new Map();
	const lines = text.split(/\r?\n/);
	let rootIndent = -1;
	let nameIndent = -1;
	let current: { baseUrl: string | null; models: string[] } | null = null;
	let keyIndent = -1;
	for (const raw of lines) {
		if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
		const indent = raw.length - raw.trimStart().length;
		const line = raw.trim();
		if (rootIndent < 0) {
			if (/^providers:\s*(#.*)?$/.test(line)) rootIndent = indent;
			continue;
		}
		if (indent <= rootIndent) break;
		if (nameIndent < 0) nameIndent = indent;
		if (indent === nameIndent) {
			const m = /^("[^"]+"|'[^']+'|[^:\s][^:]*):\s*(#.*)?$/.exec(line);
			current = null;
			keyIndent = -1;
			if (!m) continue;
			current = { baseUrl: null, models: [] };
			out.set(unquote(m[1]!).toLowerCase(), current);
			continue;
		}
		if (!current || indent < nameIndent) continue;
		if (keyIndent < 0) keyIndent = indent;
		if (indent === keyIndent) {
			const b = /^baseUrl:\s*(.+)$/.exec(line);
			if (b) current.baseUrl = unquote(b[1]!) || null;
			continue;
		}
		const id = /^(?:-\s+)?id:\s*(.+)$/.exec(line);
		if (id && indent > keyIndent) {
			const v = unquote(id[1]!);
			if (v) current.models.push(v);
		}
	}
	return out;
}

/**
 * Codex `config.toml`: `[model_providers.<name>]` tables with `base_url`.
 * Codex records name no model per provider, so `models` stays empty.
 */
export function providersFromToml(text: string): Providers {
	const out: Providers = new Map();
	let current: { baseUrl: string | null; models: string[] } | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		const t = /^\[\s*model_providers\.("?)([^"\]]+)\1\s*\]/.exec(line);
		if (t) {
			current = { baseUrl: null, models: [] };
			out.set(t[2]!.trim().toLowerCase(), current);
			continue;
		}
		if (line.startsWith("[")) {
			current = null;
			continue;
		}
		const b = current && /^base_url\s*=\s*(.+)$/.exec(line);
		if (current && b) current.baseUrl = unquote(b[1]!) || null;
	}
	return out;
}

const read = (path: string) =>
	readFile(path, "utf8").catch(() => null as string | null);

/**
 * A harness's providers, from the config folder next to its sessions
 * folder (`~/.omp/agent/sessions` → `~/.omp/agent/models.yml`). Later
 * files override earlier ones, as omp's `models.yml` overrides JSON.
 */
export async function readProviders(
	harness: "codex" | "pi" | "omp",
	sessionsRoot: string,
): Promise<Providers> {
	const dir = dirname(sessionsRoot);
	if (harness === "codex") {
		const t = await read(join(dir, "config.toml"));
		return t ? providersFromToml(t) : new Map();
	}
	const out: Providers = new Map();
	const json = await read(join(dir, "models.json"));
	if (json) for (const [k, v] of providersFromJson(json)) out.set(k, v);
	for (const f of ["models.yaml", "models.yml"]) {
		const y = await read(join(dir, f));
		if (y) for (const [k, v] of providersFromYaml(y)) out.set(k, v);
	}
	return out;
}
