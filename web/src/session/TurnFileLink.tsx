import { ArrowUpRightIcon } from "lucide-react";
import { pageFor } from "../lib/registry.tsx";
import { navigate, type Route } from "../lib/router.ts";

/**
 * The file viewer's page (`#/file/<agent id>?path=<path>`, the path relative
 * to the agent's folder), when a feature registers it.
 */
const FILE_PAGE = "file";

/**
 * In a turn's change summary, a file's way to the file viewer. Renders
 * nothing while no file viewer is registered.
 */
export function TurnFileLink({
	agentId,
	path,
}: {
	agentId: string;
	path: string;
}) {
	const r: Route = {
		view: "page",
		name: FILE_PAGE,
		arg: agentId,
		params: { path },
	};
	// The viewer opens paths inside the agent's folder only (relative ones).
	if (path.startsWith("/") || !pageFor(r)) return null;
	return (
		<button
			type="button"
			className="ds-turnchg-open"
			aria-label={`Open ${path}`}
			title="Open file"
			onClick={() => navigate(r)}
		>
			<ArrowUpRightIcon aria-hidden="true" />
		</button>
	);
}
