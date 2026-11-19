import { lazyCrypto } from "./lazy.ts";

/** JSON with object keys sorted, so equal values serialize (and hash) equally. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_k, v) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(
					Object.keys(v)
						.sort()
						.map((k) => [k, (v as Record<string, unknown>)[k]]),
				)
			: v,
	);
}

export const sha256hex = (s: string) =>
	lazyCrypto().createHash("sha256").update(s).digest("hex");
