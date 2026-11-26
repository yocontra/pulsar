/** Fernet envelopes have a version, timestamp, IV, whole AES blocks and MAC. */
export const ENCRYPTED_MESSAGE =
	"The transcript stores this message encrypted.";

export function readableToolText(text: string): string {
	if (!text.includes("gAAAA")) return text;
	return text.replace(
		/(?<![A-Za-z0-9_-])gAAAA[A-Za-z0-9_-]{93,}={0,2}(?![A-Za-z0-9_-])/g,
		(token) => {
			const length = token.replace(/=+$/, "").length;
			const bytes = Math.floor((length * 3) / 4);
			return length % 4 !== 1 && bytes >= 73 && (bytes - 57) % 16 === 0
				? ENCRYPTED_MESSAGE
				: token;
		},
	);
}

/** Keep the original object when none of its display fields changed. */
export function readableToolInput(value: unknown, depth = 0): unknown {
	if (depth >= 64) return value;
	if (typeof value === "string") return readableToolText(value);
	if (Array.isArray(value)) {
		const items = value.map((v) => readableToolInput(v, depth + 1));
		return items.some((v, i) => v !== value[i]) ? items : value;
	}
	if (!value || typeof value !== "object") return value;
	let copy: Record<string, unknown> | undefined;
	for (const [key, field] of Object.entries(value)) {
		const visible = readableToolInput(field, depth + 1);
		if (visible !== field) {
			copy ??= { ...value };
			copy[key] = visible;
		}
	}
	return copy ?? value;
}

/** Decode a whole message field only. Ordinary prose can also mention tokens. */
export function messageContent(raw: string): { text: string; note?: string } {
	const visible = readableToolText(raw);
	const token = visible.trim();
	if (token === ENCRYPTED_MESSAGE) return { text: "", note: token };
	if (
		token.length < 8 ||
		token.length > 128 * 1024 ||
		(token.length < 24 && !token.endsWith("=")) ||
		!/^[A-Za-z0-9+/_-]+={0,2}$/.test(token)
	)
		return { text: visible };

	try {
		const base64 = token.replaceAll("-", "+").replaceAll("_", "/");
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (
			text.trim() &&
			!Array.from(text).some((c) => {
				const n = c.charCodeAt(0);
				return (
					(n < 32 && !["\t", "\r", "\n"].includes(c)) || (n >= 127 && n <= 159)
				);
			})
		)
			return { text };
	} catch {
		// A word or identifier can look like Base64. Keep the original text.
	}
	return { text: visible };
}
