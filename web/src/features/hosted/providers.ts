import type { HostedProvider } from "../../../../src/hosted/wire.ts";

export const providers = {
	copilot: { name: "GitHub Copilot", origin: "https://github.com" },
	codex: { name: "Codex Cloud", origin: "https://chatgpt.com" },
	cursor: { name: "Cursor Cloud", origin: "https://cursor.com" },
} satisfies Record<HostedProvider, { name: string; origin: string }>;

export function taskUrl(
	url: string | null | undefined,
	provider: HostedProvider,
) {
	if (!url) return;
	try {
		const u = new URL(url);
		if (u.origin === providers[provider].origin && !u.username && !u.password)
			return `${u.origin}${u.pathname}`;
	} catch {
		// Ignore unrecognized links supplied by the provider or a peer.
	}
}
