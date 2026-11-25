import type { KeyboardEvent } from "react";

/** Arrow keys complement Tab and the buttons' native Enter and Space. */
export function moveFileFocus(
	e: KeyboardEvent,
	selector: string,
	tree = false,
) {
	if (
		e.altKey ||
		e.metaKey ||
		e.ctrlKey ||
		e.shiftKey ||
		e.nativeEvent.isComposing
	)
		return;
	const target = (e.target as HTMLElement).closest<HTMLButtonElement>(selector);
	if (!target) return;
	const rows = [
		...e.currentTarget.querySelectorAll<HTMLButtonElement>(selector),
	];
	const index = rows.indexOf(target);
	let next: HTMLButtonElement | null | undefined;
	switch (e.key) {
		case "ArrowDown":
			next = rows[index + 1];
			break;
		case "ArrowUp":
			next = rows[index - 1];
			break;
		case "Home":
			next = rows[0];
			break;
		case "End":
			next = rows.at(-1);
			break;
		case "ArrowRight":
			if (!tree) return;
			if (target.getAttribute("aria-expanded") === "false") target.click();
			else if (target.getAttribute("aria-expanded") === "true")
				next = target.parentElement?.querySelector<HTMLButtonElement>(
					`:scope > ul > li > ${selector}`,
				);
			break;
		case "ArrowLeft":
			if (!tree) return;
			if (target.getAttribute("aria-expanded") === "true") target.click();
			else
				next = target
					.closest("ul")
					?.parentElement?.closest("li")
					?.querySelector<HTMLButtonElement>(selector);
			break;
		default:
			return;
	}
	e.preventDefault();
	next?.focus();
}
