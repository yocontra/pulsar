import { cx as cn } from "../../lib/cx.ts";

const APPLE =
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Key name → [Apple glyph, other platforms, spoken name]. */
const KEYS: Record<string, [string, string, string]> = {
	mod: ["⌘", "Ctrl", APPLE ? "Command" : "Control"],
	cmd: ["⌘", "Ctrl", APPLE ? "Command" : "Control"],
	ctrl: ["⌃", "Ctrl", "Control"],
	shift: ["⇧", "Shift", "Shift"],
	alt: ["⌥", "Alt", APPLE ? "Option" : "Alt"],
	option: ["⌥", "Alt", APPLE ? "Option" : "Alt"],
	enter: ["⏎", "Enter", APPLE ? "Return" : "Enter"],
	return: ["⏎", "Enter", APPLE ? "Return" : "Enter"],
	esc: ["esc", "Esc", "Escape"],
	escape: ["esc", "Esc", "Escape"],
	tab: ["⇥", "Tab", "Tab"],
	backspace: ["⌫", "Backspace", "Delete"],
	space: ["Space", "Space", "Space"],
	up: ["↑", "↑", "Up arrow"],
	down: ["↓", "↓", "Down arrow"],
	left: ["←", "←", "Left arrow"],
	right: ["→", "→", "Right arrow"],
	"↑": ["↑", "↑", "Up arrow"],
	"↓": ["↓", "↓", "Down arrow"],
	"↵": ["⏎", "Enter", APPLE ? "Return" : "Enter"],
	".": [".", ".", "Period"],
	"/": ["/", "/", "Slash"],
	"?": ["?", "?", "Question mark"],
};

/** How one key reads and is spoken on this platform. */
export function keyLabel(k: string): { glyph: string; spoken: string } {
	const hit = KEYS[k.toLowerCase()] ?? KEYS[k];
	if (!hit) return { glyph: k.length === 1 ? k.toUpperCase() : k, spoken: k };
	return { glyph: APPLE ? hit[0] : hit[1], spoken: hit[2] };
}

/**
 * A keyboard shortcut: <Kbd keys={["mod", "shift", "B"]} /> renders one chip,
 * ⌘⇧B on Apple platforms and Ctrl+Shift+B elsewhere. Hidden on touch-only
 * devices (styles/ds.css). A hint next to a labelled control is decorative
 * (hidden from screen readers); pass `spoken` where the shortcut is the
 * content (the shortcuts list) and it reads "Command Shift B".
 */
export function Kbd({
	keys,
	className,
	spoken = false,
}: {
	keys: string[];
	className?: string;
	spoken?: boolean;
}) {
	const parts = keys.map(keyLabel);
	return (
		<kbd
			className={cn("ds-kbd", className)}
			aria-hidden={spoken ? undefined : true}
		>
			{spoken && (
				<span className="sr-only">{parts.map((p) => p.spoken).join(" ")}</span>
			)}
			{parts.map((p, i) => (
				<span key={i} className="ds-key" aria-hidden="true">
					{!APPLE && i > 0 && <span className="ds-key-sep">+</span>}
					{p.glyph}
				</span>
			))}
		</kbd>
	);
}
