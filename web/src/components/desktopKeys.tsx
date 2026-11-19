import {
	CodeIcon,
	CopyIcon,
	MegaphoneIcon,
	MessageSquareIcon,
	PinIcon,
	SendIcon,
	SquareIcon,
} from "lucide-react";
import { useEffect } from "react";
import type { TreeNode } from "../api/types.ts";
import { openPrompt } from "../approval/focus.ts";
import { askStop } from "../data/pending.ts";
import { back, navigate, route } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import {
	attention,
	can,
	expanded,
	nodes,
	pins,
	selection,
	setExpanded,
	toggleExpanded,
	togglePin,
	toggleSelect,
} from "../lib/store.ts";
import { showHelp, showPalette, showQr } from "./chrome.tsx";
import { desktopRows, focusKey, openRow, type Row } from "./Tree.tsx";

export interface Menu {
	x: number;
	y: number;
	node: TreeNode;
}

function ContextMenuImpl({
	menu,
	onClose,
}: {
	menu: Menu;
	onClose: () => void;
}) {
	const n = menu.node;
	const pinned = pins.value.some((p) => p.id === n.id);
	const copy = (s: string) => {
		void navigator.clipboard?.writeText(s).catch(() => {});
		onClose();
	};
	useEffect(() => {
		const close = () => onClose();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		addEventListener("click", close);
		addEventListener("blur", close);
		addEventListener("keydown", onKey);
		return () => {
			removeEventListener("click", close);
			removeEventListener("blur", close);
			removeEventListener("keydown", onKey);
		};
	}, []);
	const item = (
		label: string,
		fn: () => void,
		cls = "",
		Icon?: typeof PinIcon,
	) => (
		<button type="button" role="menuitem" className={cls} onClick={fn}>
			{Icon ? <Icon aria-hidden="true" /> : <span className="d-menu-ico" />}
			{label}
		</button>
	);
	return (
		<div
			className="context-menu d-menu"
			role="menu"
			style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
		>
			{item(
				n.kind === "agent" ? "Open session" : "Message everyone…",
				() => {
					onClose();
					if (n.agent) navigate({ view: "agent", id: n.agent.id });
					else navigate({ view: "node", id: n.id });
				},
				"",
				n.kind === "agent" ? MessageSquareIcon : SendIcon,
			)}
			{n.kind !== "agent" &&
				item(
					"Open in Broadcast",
					() => navigate({ view: "broadcast", selector: n.selector }),
					"",
					MegaphoneIcon,
				)}
			{n.agent?.canStop &&
				can("stop") &&
				item(
					"Stop…",
					() => {
						// Open the session and ask there (Stop always confirms).
						const id = n.agent!.id;
						navigate({ view: "agent", id });
						setTimeout(() => askStop(id), 0);
					},
					"danger",
					SquareIcon,
				)}
			<span className="d-menu-sep" role="separator" />
			{item(
				pinned ? "Unpin" : "Pin to sidebar",
				() => togglePin(n),
				"",
				PinIcon,
			)}
			{item("Copy address", () => copy(n.agent?.address ?? n.id), "", CopyIcon)}
			{item("Copy selector", () => copy(n.selector), "", CodeIcon)}
		</div>
	);
}

const FOCUSABLE = new Set<Row["t"]>([
	"attn",
	"recent",
	"pin",
	"node",
	"offline",
	"more",
	"subs",
	"sub",
]);
let needsIdx = -1;
/** Keys that belong to whatever has focus, unless that is the page or the tree. */
const FOCUS_KEYS = new Set([
	"Enter",
	" ",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
]);

export function installDesktopKeys(filterRef: {
	current: HTMLElement | null;
}): () => void {
	{
		const onKey = (e: KeyboardEvent) => {
			// An IME is composing: its Enter and Escape are not ours.
			if (e.isComposing) return;
			const t = e.target as HTMLElement;
			const typing =
				t.tagName === "INPUT" ||
				t.tagName === "TEXTAREA" ||
				t.isContentEditable;
			const mod = e.metaKey || e.ctrlKey;
			if (mod && e.key.toLowerCase() === "k") {
				e.preventDefault();
				showPalette.value = !showPalette.value;
				return;
			}
			// A dialog is open (Radix handles its own Esc and focus): the
			// shell's shortcuts stay out of the way.
			if (
				document.querySelector(
					'.d-pop, .d-menu, [role="dialog"][data-state="open"]',
				)
			)
				return;
			if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
				e.preventDefault();
				navigate({ view: "broadcast", selector: "*" });
				return;
			}
			if (mod && e.key === ".") {
				e.preventDefault();
				dispatchEvent(new Event("pulsar:stop"));
				return;
			}
			if (e.key === "Escape") {
				if (showPalette.value || showHelp.value || showQr.value) {
					showPalette.value = showHelp.value = showQr.value = false;
					return;
				}
				if (typing) {
					t.blur();
					return;
				}
				if (route.value.view !== "home" && route.value.view !== "broadcast")
					back();
				return;
			}
			if (typing || mod || e.altKey) return;
			// A focused button, the diff or a resizer keeps its own Enter, Space
			// and arrows.
			const onTree =
				t === document.body ||
				t === document.documentElement ||
				t.closest(".tree") !== null;
			if (!onTree && FOCUS_KEYS.has(e.key)) return;
			const rows = desktopRows.value.filter((r) => FOCUSABLE.has(r.t));
			const cur = rows.findIndex((r) => r.key === focusKey.value);
			const focused = rows[cur];
			const node = focused?.t === "node" ? nodes.get(focused.id) : undefined;
			switch (e.key) {
				case "/":
					e.preventDefault();
					filterRef.current?.querySelector("input")?.focus();
					break;
				case "j":
				case "ArrowDown":
					e.preventDefault();
					focusKey.value =
						rows[Math.min(rows.length - 1, cur + 1)]?.key ?? null;
					break;
				case "k":
				case "ArrowUp":
					e.preventDefault();
					focusKey.value = rows[Math.max(0, cur - 1)]?.key ?? null;
					break;
				case "h":
				case "ArrowLeft":
					if (node && node.kind !== "agent" && expanded.value.has(node.id))
						setExpanded(node.id, false);
					break;
				case "l":
				case "ArrowRight":
					if (node && node.kind !== "agent") setExpanded(node.id, true);
					break;
				case "Enter":
					if (!focused) break;
					// A focused row button would also click itself: open once.
					e.preventDefault();
					openRow(focused);
					break;
				case "n": {
					const items = attention.value;
					if (!items.length) break;
					needsIdx = (needsIdx + 1) % items.length;
					const it = items[needsIdx]!;
					it.kind === "approval"
						? void openPrompt(it.agent.id)
						: navigate({ view: "agent", id: it.agent.id });
					break;
				}
				case "x":
				case " ":
					if (node?.agent) {
						e.preventDefault();
						toggleSelect(node.agent.id);
					} else if (node) {
						e.preventDefault();
						toggleExpanded(node.id);
					}
					break;
				case "b":
					if (selection.value.size)
						navigate({ view: "ids", ids: [...selection.value] });
					break;
				case "?":
					showHelp.value = true;
					break;
			}
		};
		// Capture: run before Radix's own Esc handling, so an open dialog is
		// still in the DOM when we check for one.
		addEventListener("keydown", onKey, true);
		return () => removeEventListener("keydown", onKey, true);
	}
}

export const ContextMenu = observer(ContextMenuImpl);
