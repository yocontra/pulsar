import { ArrowUpRightIcon } from "lucide-react";
import { pageFor } from "../lib/registry.tsx";
import { navigate, type Route } from "../lib/router.ts";

/** The file viewer's page (`#/file/<agent id>?path=<path>`), when a feature registers it. */
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
	if (!pageFor(r)) return null;
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
