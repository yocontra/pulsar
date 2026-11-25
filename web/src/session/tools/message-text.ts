/** Decode a whole message field only. Ordinary prose can also mention tokens. */
export function messageContent(raw: string): { text: string; note?: string } {
	const token = raw.trim();
	if (
		token.length < 8 ||
		token.length > 128 * 1024 ||
		(token.length < 24 && !token.endsWith("=")) ||
		!/^[A-Za-z0-9+/_-]+={0,2}$/.test(token)
	)
		return { text: raw };

	try {
		const base64 = token.replaceAll("-", "+").replaceAll("_", "/");
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		// Fernet's version byte, timestamp, IV, AES blocks and 32-byte MAC.
		if (
			token.startsWith("gAAAA") &&
			bytes[0] === 0x80 &&
			bytes.length >= 73 &&
			(bytes.length - 57) % 16 === 0
		)
			return {
				text: "",
				note: "The transcript stores this message encrypted.",
			};
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
	return { text: raw };
}
