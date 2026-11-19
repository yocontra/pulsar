import { navigate } from "../../lib/router.ts";

/** Opens the new-agent draft (optionally on a machine, in a project). */
export function openDraft(
	p: { machine?: string; project?: string; cwd?: string } = {},
) {
	const params: Record<string, string> = {};
	for (const [k, v] of Object.entries(p)) if (v) params[k] = v;
	navigate({ view: "page", name: "new", params });
}
