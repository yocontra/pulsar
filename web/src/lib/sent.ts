/**
 * Message ids this tab sent, so a sent bubble shows its delivery state only
 * for our own fresh sends (an old or foreign message's receipts may be gone).
 * Kept per tab in sessionStorage; at most the last 50.
 */
const KEY = "pulsar.sentHere";

function read(): string[] {
	try {
		return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as string[];
	} catch {
		return [];
	}
}

export function noteSent(id: string) {
	try {
		const ids = [...read().filter((x) => x !== id), id].slice(-50);
		sessionStorage.setItem(KEY, JSON.stringify(ids));
	} catch {}
}

export function sentHere(id: string): boolean {
	return read().includes(id);
}
