/**
 * In-app note when a plan usage limit passes a warning threshold or is
 * reached (the daemon's `limit` event, once per window per threshold).
 * Follows the "In-app notifications" switch; OS notifications come from
 * Web Push (sw.js).
 */
import { GaugeIcon } from "lucide-react";
import { createElement } from "react";
import type { ServerEvents } from "../../api/types.ts";
import { live, queryClient } from "../../data/runtime.ts";
import { harnessName } from "../../ds/index.ts";
import { navigate } from "../../lib/router.ts";
import { toast } from "../../lib/toast.ts";
import { inApp } from "../notify/prefs.ts";
import { limitsKey, resetText, warningText } from "./model.ts";

/** Handles one `limit` event (exported for tests). */
export function onLimit(w: ServerEvents["limit"]) {
	void queryClient.invalidateQueries({ queryKey: limitsKey });
	void queryClient.invalidateQueries({ queryKey: ["agentUsage"] });
	if (!inApp.value) return;
	void toast(warningText(w, harnessName(w.harness)), {
		id: `limit:${w.harness}:${w.label}`,
		tone: w.reached ? "error" : "warning",
		description: resetText(w.resetsAt) ?? undefined,
		duration: 12_000,
		icon: createElement(GaugeIcon, { size: 16, "aria-hidden": true }),
		action: {
			label: "Open usage",
			onClick: () => navigate({ view: "page", name: "usage" }),
		},
	});
}

let started = false;

export function start() {
	if (started) return;
	started = true;
	live.on("limit", onLimit);
}
