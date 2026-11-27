import { useEffect } from "react";
import { live } from "../data/runtime.ts";
import { showToast } from "../lib/store.ts";

export function useSessionNotice(id: string) {
	useEffect(
		() =>
			live.on("sessionNotice", (notice) => {
				if (notice.agentId === id)
					showToast(
						[notice.title, notice.description].filter(Boolean).join(" · "),
						notice.severity === "info" ? "ok" : "warn",
					);
			}),
		[id],
	);
}
