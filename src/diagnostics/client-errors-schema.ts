/**
 * The shape `POST /api/v1/client-errors` accepts (src/transport/http.ts and
 * the mock). Strict and bounded: anything else is refused.
 */
import { z } from "zod";
import { CLIENT_ERROR_KINDS, type ClientErrorReport } from "./client-errors.ts";

/** The body limit: a report is a few hundred bytes. */
export const CLIENT_ERROR_MAX_BYTES = 8 * 1024;

const text = (max: number) => z.string().max(max);

export const ClientErrorBody = z
	.object({
		kind: z.enum(CLIENT_ERROR_KINDS),
		build: text(64),
		urls: z.array(text(300)).max(5),
		error: z.object({ name: text(80), message: text(500) }).strict(),
		sw: z
			.object({
				controller: text(64).nullable(),
				state: text(40),
				caches: z.array(text(80)).max(10),
				failed: z.array(text(300)).max(5),
			})
			.strict(),
		online: z.boolean(),
		standalone: z.boolean(),
		ua: text(400),
		route: text(300),
		reloaded: z.boolean(),
		at: z.number().int().min(0).max(1e15),
	})
	.strict() satisfies z.ZodType<ClientErrorReport>;

/** The body as text (a beacon may send `text/plain`), checked: a report or null. */
export function parseClientError(raw: string): ClientErrorReport | null {
	if (raw.length > CLIENT_ERROR_MAX_BYTES) return null;
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return null;
	}
	const r = ClientErrorBody.safeParse(v);
	return r.success ? r.data : null;
}
