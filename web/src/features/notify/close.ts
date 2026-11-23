/**
 * Closes the system notification of a prompt that was answered, denied or
 * expired. The push for it can't be taken back (Safari shows every push),
 * so the app closes it when it hears the prompt left pending: only while
 * Pulsar is open on this device. A later notice for the same agent
 * replaces it anyway (one tag per agent).
 */
import type { Approval } from "../../api/types.ts";

export async function closeAnswered(
	a: Pick<Approval, "requestId" | "state">,
	sw:
		| Pick<ServiceWorkerContainer, "getRegistration">
		| undefined = typeof navigator !== "undefined"
		? navigator.serviceWorker
		: undefined,
): Promise<number> {
	if (a.state === "pending" || !sw) return 0;
	let closed = 0;
	try {
		const reg = await sw.getRegistration();
		for (const n of (await reg?.getNotifications()) ?? [])
			if ((n.data as { id?: unknown } | null)?.id === a.requestId) {
				n.close();
				closed++;
			}
	} catch {}
	return closed;
}
