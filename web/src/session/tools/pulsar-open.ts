/**
 * Opens an agent's session from a Pulsar card. Loaded on the first click
 * only: the transcript renderer (also used outside the app) never loads
 * the API client or the router up front.
 */
import { api } from "../../api/client.ts";
import { navigate } from "../../lib/router.ts";

/** Opens the agent by id, or finds it by name first; false when nobody has that name now. */
export async function openAgent(p: {
	id?: string;
	name: string;
}): Promise<boolean> {
	if (p.id) {
		navigate({ view: "agent", id: p.id });
		return true;
	}
	try {
		const page = await api.agents({ selector: p.name, limit: 5 });
		const a =
			page.items.find((x) => x.name === p.name || x.id === p.name) ??
			(page.items.length === 1 ? page.items[0] : undefined);
		if (!a) return false;
		navigate({ view: "agent", id: a.id });
		return true;
	} catch {
		return false;
	}
}
