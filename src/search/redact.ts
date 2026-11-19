/**
 * Secrets taken out of text before it is stored for search. Transcripts are
 * the harness's own files; the search index is a second copy Pulsar keeps,
 * so anything that looks like a credential is replaced first. The patterns
 * favor common token shapes over completeness: the index never holds tool
 * output (where most secrets land), only what people and agents wrote.
 */

export const REDACTED = "[redacted]";

const PATTERNS: RegExp[] = [
	// PEM private keys, whole block.
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
	// Provider tokens by prefix.
	/\b(?:sk|rk|pk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bglpat-[A-Za-z0-9_-]{20,}/g,
	/\bxox[abpors]-[A-Za-z0-9-]{10,}/g,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
	/\bAIza[A-Za-z0-9_-]{35}\b/g,
	/\bnpm_[A-Za-z0-9]{36}\b/g,
	/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
	// JSON Web Tokens.
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	// Bearer tokens (an Authorization header's value).
	/(?<=\bbearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
	// Credentials in URLs: scheme://user:password@host.
	/(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
];

/** `password = …`, `API_KEY: "…"`, `"client_secret": "…"`: the value goes. */
const ASSIGNMENT =
	/\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi;

/** `text` with anything that looks like a secret replaced by `[redacted]`. */
export function redactSecrets(text: string): string {
	let out = text;
	for (const p of PATTERNS) out = out.replace(p, REDACTED);
	return out.replace(ASSIGNMENT, (_, key: string, value: string) =>
		value === REDACTED ? `${key}${value}` : `${key}${REDACTED}`,
	);
}
