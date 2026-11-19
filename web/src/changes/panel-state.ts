/**
 * The desktop changes panel: open or closed and its width, per device. With
 * no stored choice it opens only in a window at least 1600 px wide (the
 * conversation keeps room beside the sidebar).
 */
import { signal } from "../lib/signals.ts";

const OPEN_KEY = "pulsar.changes.open";
const WIDTH_KEY = "pulsar.changes.width";
const MODE_KEY = "pulsar.changes.mode";
/** Auto-open from this window width. */
export const WIDE = 1600;
export const PANEL_MIN = 320;
export const PANEL_DEFAULT = 560;
export const PANEL_STEP = 16;

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
function write(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {}
}

/** The widest the panel may be: 60 % of the window (the conversation keeps the rest). */
export function panelMax(): number {
	return Math.max(PANEL_MIN, Math.round(innerWidth * 0.6));
}
export function clampPanel(w: number): number {
	return Math.min(panelMax(), Math.max(PANEL_MIN, Math.round(w)));
}

const storedOpen = read(OPEN_KEY);
export const changesOpen = signal<boolean>(
	storedOpen === null ? innerWidth >= WIDE : storedOpen === "1",
);
export const panelWidth = signal<number>(
	clampPanel(Number(read(WIDTH_KEY)) || PANEL_DEFAULT),
);
export const changesMode = signal<"worktree" | "base">(
	read(MODE_KEY) === "base" ? "base" : "worktree",
);

export function setChangesOpen(open: boolean, save = true) {
	changesOpen.value = open;
	if (save) write(OPEN_KEY, open ? "1" : "0");
}
export function toggleChanges() {
	setChangesOpen(!changesOpen.peek());
}
export function setPanelWidth(w: number, save = true) {
	panelWidth.value = clampPanel(w);
	if (save) write(WIDTH_KEY, String(panelWidth.peek()));
}
export function setChangesMode(mode: "worktree" | "base") {
	changesMode.value = mode;
	write(MODE_KEY, mode);
}

/** ⌘\ (Ctrl+\ elsewhere) toggles the panel. */
export const SHORTCUT_LABEL = /Mac|iPhone|iPad/.test(
	navigator.platform || navigator.userAgent,
)
	? "⌘\\"
	: "Ctrl+\\";
export function isToggleKey(e: KeyboardEvent): boolean {
	return (e.metaKey || e.ctrlKey) && !e.altKey && e.code === "Backslash";
}
