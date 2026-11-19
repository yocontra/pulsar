import { SquarePenIcon } from "lucide-react";
import type { PaletteResult } from "../../lib/registry.tsx";
import { openDraft } from "./open.ts";
import { launchOptions } from "./state.ts";

/** Cmd-K "New agent in…": this machine's projects matching the query. */
export async function searchProjects(
	q: string,
	signal: AbortSignal,
): Promise<PaletteResult[]> {
	const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	const o = await launchOptions("");
	if (signal.aborted) return [];
	return o.projects
		.filter((p) => {
			const hay = `${p.name} ${p.path}`.toLowerCase();
			return words.every((w) => hay.includes(w));
		})
		.slice(0, 6)
		.map((p) => ({
			key: `launch:${p.path}`,
			label: `New agent in ${p.name}`,
			sub: p.path,
			icon: <SquarePenIcon />,
			run: () => openDraft({ cwd: p.path }),
		}));
}
