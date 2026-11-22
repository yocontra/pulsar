import { lazy } from "../../lib/lazy.tsx";
import { observer } from "../../lib/signals.ts";
import type { ActionsRequest } from "./actions.ts";
import { actionsRequest } from "./actions.ts";

const Sheet = lazy<{ req: ActionsRequest }>(
	() => import("./ActionsSheet.tsx"),
	() => <></>,
	{ layer: true },
);

/** The open action sheet (ui/actions.ts `showActions`). */
function ActionsHostImpl() {
	const req = actionsRequest.value;
	return req ? <Sheet key={req.id} req={req} /> : null;
}

export const ActionsHost = observer(ActionsHostImpl);
