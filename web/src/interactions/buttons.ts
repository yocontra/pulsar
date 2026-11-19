/** Button classes for interaction cards: the desktop `btn` set or the phone's `m-btn` set. */
export function btn(
	mobile: boolean,
	kind: "primary" | "secondary" | "danger",
): string {
	if (mobile)
		return kind === "primary"
			? "m-btn m-allow"
			: kind === "danger"
				? "m-btn danger"
				: "m-btn gray";
	return kind === "primary"
		? "btn primary"
		: kind === "danger"
			? "btn danger-outline"
			: "btn";
}
