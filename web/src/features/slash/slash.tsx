/**
 * Slash commands and modes in the composer (lib/registry.tsx slots):
 *
 * - `SlashMenu` (composer.top): typing `/` at the start of the draft opens
 *   the agent's commands and skills; Enter or Tab inserts `/name ` and
 *   leaves the caret for arguments. Under a command line, a note says it
 *   runs in the agent's session, with "Send as text" to send it as a
 *   message instead.
 * - `SlashButton` (composer.left, phone): a sheet of the same list with
 *   search, recent commands first; tap inserts, Run sends a command that
 *   takes no arguments at once.
 * - `ModeChip` (composer.left on desktop, composer.top on the phone): the
 *   agent's mode; tap to switch (Prove Human).
 */
import {
	CheckIcon,
	ChevronDownIcon,
	SquareSlashIcon,
	TerminalIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
	AgentModes,
	AgentRow,
	CommandCatalog,
	CommandEntry,
} from "../../api/types.ts";
import { useComposerAction } from "../../lib/composer-menu.tsx";
import type { ComposerSlotProps } from "../../lib/registry.tsx";
import { observer } from "../../lib/signals.ts";
import {
	commandLine,
	insertText,
	needsTerminal,
	rankCommands,
	slashToken,
} from "../../lib/slash.ts";
import {
	catalogFor,
	chooseMode,
	modesFor,
	noteRecent,
	recentFor,
	runNow,
	switchMode,
} from "./data.ts";
import "./slash.css";

const agentOf = (p: ComposerSlotProps): AgentRow | null =>
	p.target.kind === "agent" ? p.target.agent : null;

const SOURCE: Record<CommandEntry["source"], string> = {
	builtin: "built-in",
	project: "project",
	user: "user",
	plugin: "plugin",
	agent: "agent",
};

function Badge({ c }: { c: CommandEntry }) {
	return (
		<span className={`slash-badge s-${c.source}`}>
			{c.skill
				? c.source === "builtin"
					? "skill"
					: `${SOURCE[c.source]} skill`
				: SOURCE[c.source]}
		</span>
	);
}

/** Replaces text in the field the way typing would (React sees an input event). */
function replaceText(
	ta: HTMLTextAreaElement,
	start: number,
	end: number,
	text: string,
) {
	ta.focus();
	ta.setRangeText(text, start, end, "end");
	ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The agent's `/` list, loaded once the menu or sheet first needs it. */
function useCatalog(agentId: string | null, want: boolean) {
	const [cat, setCat] = useState<CommandCatalog | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!agentId || !want) return;
		let live = true;
		catalogFor(agentId).then(
			(c) => {
				if (!live) return;
				setCat(c);
				setError(null);
			},
			(e: unknown) => live && setError((e as Error).message),
		);
		return () => {
			live = false;
		};
	}, [agentId, want]);
	return { cat: cat?.agentId === agentId ? cat : null, error };
}

const MENU_ID = "composer-slash";

// ------------------------------------------------------------------ menu

function SlashMenuImpl(p: ComposerSlotProps) {
	const agent = agentOf(p);
	const [open, setOpen] = useState<{ q: string; end: number } | null>(null);
	const [text, setText] = useState("");
	const [active, setActive] = useState(0);
	const { cat, error } = useCatalog(
		agent?.id ?? null,
		open !== null || text.startsWith("/"),
	);
	const items = cat
		? rankCommands(cat.commands, open?.q ?? "", recentFor(cat.harness))
		: [];
	const state = useRef({ open, items, active });
	state.current = { open, items, active };
	const list = useRef<HTMLDivElement>(null);
	const pickRef = useRef<((c: CommandEntry) => void) | null>(null);

	useEffect(() => {
		const ta = p.textarea.current;
		if (!ta || !agent) return;
		let dismissed = false;
		const check = () => {
			setText(ta.value);
			const t =
				ta.selectionStart === ta.selectionEnd
					? slashToken(ta.value, ta.selectionStart)
					: null;
			if (!t) dismissed = false;
			setOpen((o) =>
				t && !dismissed ? (o && o.q === t.q && o.end === t.end ? o : t) : null,
			);
		};
		const pick = (c: CommandEntry) => {
			const o = state.current.open;
			if (!o || needsTerminal(c)) return;
			replaceText(
				ta,
				0,
				o.end + (ta.value[o.end] === " " ? 1 : 0),
				insertText(c),
			);
			setOpen(null);
			dismissed = true;
		};
		pickRef.current = pick;
		const key = (e: KeyboardEvent) => {
			const { open, items, active } = state.current;
			if (!open || e.isComposing) return;
			const n = items.length;
			const stop = () => {
				e.preventDefault();
				e.stopPropagation();
			};
			if (e.key === "ArrowDown" && n) {
				stop();
				setActive((active + 1) % n);
			} else if (e.key === "ArrowUp" && n) {
				stop();
				setActive((active - 1 + n) % n);
			} else if (
				(e.key === "Enter" || e.key === "Tab") &&
				n &&
				!e.metaKey &&
				!e.ctrlKey &&
				!e.shiftKey
			) {
				const c = items[active]!;
				stop();
				pick(c);
			} else if (e.key === "Escape") {
				stop();
				dismissed = true;
				setOpen(null);
			}
		};
		const close = () => setOpen(null);
		ta.addEventListener("input", check);
		ta.addEventListener("click", check);
		ta.addEventListener("keyup", check);
		ta.addEventListener("blur", close);
		ta.addEventListener("keydown", key, true);
		check();
		return () => {
			pickRef.current = null;
			ta.removeEventListener("input", check);
			ta.removeEventListener("click", check);
			ta.removeEventListener("keyup", check);
			ta.removeEventListener("blur", close);
			ta.removeEventListener("keydown", key, true);
		};
	}, [p.textarea, agent?.id]);

	useEffect(() => setActive(0), [open?.q]);

	useEffect(() => {
		const ta = p.textarea.current;
		if (!ta) return;
		if (open) {
			ta.setAttribute("aria-controls", MENU_ID);
			ta.setAttribute("aria-expanded", "true");
			if (items[active])
				ta.setAttribute("aria-activedescendant", `${MENU_ID}-${active}`);
		} else if (ta.getAttribute("aria-controls") === MENU_ID) {
			ta.removeAttribute("aria-controls");
			ta.removeAttribute("aria-activedescendant");
			ta.removeAttribute("aria-expanded");
		}
		list.current
			?.querySelector<HTMLElement>(`#${MENU_ID}-${active}`)
			?.scrollIntoView({ block: "nearest" });
	}, [open, active, items.length, p.textarea]);

	if (!agent) return null;
	const root = p.textarea.current?.closest<HTMLElement>(".composer");
	const portal = (el: ReactNode) => (root ? createPortal(el, root) : el);

	if (!open) {
		// Under a command line: where it goes, and the way out.
		const line = commandLine(text);
		if (!line || p.draft.files.value.length) return null;
		const asText = p.draft.asText.value;
		return (
			<div className="slash-note" data-testid="slash-note">
				<TerminalIcon aria-hidden="true" />
				<span>
					{asText
						? "Sends as a message."
						: cat && !cat.runnable
							? `Can't run commands here: ${cat.reason ?? "unsupported"}`
							: `Runs ${line.split(" ")[0]} in ${agent.name}'s session (Prove Human).`}
				</span>
				<button
					type="button"
					className="link"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => {
						p.draft.asText.value = !asText;
					}}
				>
					{asText ? "Run as command" : "Send as text"}
				</button>
			</div>
		);
	}

	const pick = (c: CommandEntry) => pickRef.current?.(c);
	return portal(
		<div
			className="slash-menu"
			id={MENU_ID}
			role="listbox"
			aria-label="Commands"
			ref={list}
			data-testid="slash-menu"
		>
			{cat && !cat.runnable && (
				<p className="slash-empty slash-warn">
					{cat.reason ?? "Pulsar can't run commands for this agent."}
				</p>
			)}
			{error ? (
				<p className="slash-empty">{error}</p>
			) : !cat ? (
				<p className="slash-empty" role="status">
					Loading commands…
				</p>
			) : !items.length ? (
				<p className="slash-empty">No matching commands.</p>
			) : (
				items.map((c, i) => (
					<div
						key={c.name}
						id={`${MENU_ID}-${i}`}
						role="option"
						tabIndex={-1}
						aria-selected={i === active}
						aria-disabled={needsTerminal(c) || undefined}
						className="slash-item"
						onMouseDown={(e) => {
							e.preventDefault();
							pick(c);
						}}
						onMouseEnter={() => setActive(i)}
					>
						<span className="slash-name">/{c.name}</span>
						{c.args && <span className="slash-args">{c.args}</span>}
						<span className="slash-desc">
							{needsTerminal(c)
								? "Opens a dialog only the terminal can answer"
								: c.description}
						</span>
						<Badge c={c} />
					</div>
				))
			)}
		</div>,
	);
}
export const SlashMenu = observer(SlashMenuImpl);

// --------------------------------------------------------- phone sheet

function SlashButtonImpl(p: ComposerSlotProps) {
	const agent = agentOf(p);
	const [open, setOpen] = useState(false);
	const [mounted, setMounted] = useState(false);
	// In the composer's + menu; the sheet stays mounted here.
	useComposerAction(
		agent
			? {
					id: "slash.commands",
					label: "Skills & Commands",
					icon: <SquareSlashIcon className="size-5" aria-hidden="true" />,
					order: 0,
					run: () => {
						setMounted(true);
						setOpen(true);
					},
				}
			: null,
	);
	if (!agent) return null;
	return (
		<>
			{mounted && (
				<CommandSheet
					agent={agent}
					open={open}
					onClose={() => setOpen(false)}
					onClosed={() => setMounted(false)}
					onInsert={(c) => {
						const ta = p.textarea.current;
						setOpen(false);
						if (!ta) return;
						noteRecent(agent.harness, c.name);
						p.draft.asText.value = false;
						replaceText(ta, 0, ta.value.length, insertText(c));
					}}
				/>
			)}
		</>
	);
}
export const SlashButton = observer((p: ComposerSlotProps) =>
	p.compact ? <SlashButtonImpl {...p} /> : null,
);

function CommandSheet({
	agent,
	open,
	onClose,
	onClosed,
	onInsert,
}: {
	agent: AgentRow;
	open: boolean;
	onClose: () => void;
	onClosed: () => void;
	onInsert: (c: CommandEntry) => void;
}) {
	const [q, setQ] = useState("");
	const [Sheet, setSheet] = useState<typeof import("./sheet.tsx") | null>(null);
	useEffect(() => {
		void import("./sheet.tsx").then(setSheet);
	}, []);
	const { cat, error } = useCatalog(agent.id, true);
	if (!Sheet) return null;
	const recent = cat ? recentFor(cat.harness) : [];
	const items = cat ? rankCommands(cat.commands, q, recent, 200) : [];
	return (
		<Sheet.CommandSheetView
			open={open}
			onClose={onClose}
			onClosed={onClosed}
			q={q}
			onQuery={setQ}
			cat={cat}
			error={error}
			items={items}
			recent={q ? [] : items.filter((c) => recent.includes(c.name))}
			onInsert={onInsert}
			onRun={(c) => {
				onClose();
				noteRecent(cat?.harness ?? agent.harness, c.name);
				void runNow(agent, `/${c.name}`);
			}}
		/>
	);
}

// -------------------------------------------------------------- mode chip

function useModes(agentId: string | null) {
	const [m, setM] = useState<AgentModes | null>(null);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!agentId) return;
		let live = true;
		modesFor(agentId).then(
			(x) => live && setM(x),
			() => live && setM(null),
		);
		return () => {
			live = false;
		};
	}, [agentId, tick]);
	return {
		m: m?.agentId === agentId ? m : null,
		refresh: () => setTick((t) => t + 1),
	};
}

function ModeChipImpl(p: ComposerSlotProps) {
	const agent = agentOf(p);
	const { m, refresh } = useModes(agent?.id ?? null);
	const [menu, setMenu] = useState(false);
	const [busy, setBusy] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const pop = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!menu) return;
		const away = (e: MouseEvent) => {
			const t = e.target as Node;
			if (!box.current?.contains(t) && !pop.current?.contains(t))
				setMenu(false);
		};
		const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", esc);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", esc);
		};
	}, [menu]);
	if (!agent || !m?.modes.length) return null;
	const current = m.modes.find((x) => x.id === m.current);
	const label = current?.label ?? "Mode";
	const title = [
		m.live
			? `Mode: ${label}`
			: current
				? `Mode: ${label} (last seen)`
				: "Mode unknown",
		m.canSwitch ? m.note : m.reason,
	]
		.filter(Boolean)
		.join(" · ");
	const chip = (
		<button
			type="button"
			className={`mode-chip${m.live ? "" : " is-stale"}${current?.id === "plan" ? " is-plan" : ""}`}
			aria-haspopup="menu"
			aria-expanded={menu}
			aria-label={title}
			title={title}
			disabled={busy}
			data-testid="mode-chip"
			onClick={() => {
				if (p.compact) void chooseMode(agent).then(refresh);
				else {
					refresh();
					setMenu((x) => !x);
				}
			}}
		>
			{label}
			<ChevronDownIcon aria-hidden="true" />
		</button>
	);
	if (p.compact) return <div className="mode-row">{chip}</div>;
	// Docked above the whole composer, like the `/` menu: the toolbar and
	// the dock clip what overflows them.
	const root = p.textarea.current?.closest<HTMLElement>(".composer");
	const docked = (el: ReactNode) => (root ? createPortal(el, root) : el);
	return (
		<div className="mode-box" ref={box}>
			{chip}
			{menu &&
				docked(
					<div
						ref={pop}
						className="mode-menu"
						role="menu"
						aria-label="Mode"
						data-testid="mode-menu"
					>
						{!m.canSwitch && (
							<p className="slash-empty slash-warn">{m.reason}</p>
						)}
						{m.canSwitch && m.note && <p className="slash-empty">{m.note}</p>}
						{m.modes.map((x) => (
							<button
								key={x.id}
								type="button"
								role="menuitemradio"
								aria-checked={x.id === m.current}
								className="mode-item"
								disabled={!m.canSwitch || x.id === m.current}
								onClick={async () => {
									setMenu(false);
									setBusy(true);
									await switchMode(agent, x.id, x.label);
									setBusy(false);
									refresh();
								}}
							>
								<span className="mode-check">
									{x.id === m.current && <CheckIcon aria-hidden="true" />}
								</span>
								<span className="mode-label">{x.label}</span>
								{x.hint && <span className="mode-hint">{x.hint}</span>}
							</button>
						))}
					</div>,
				)}
		</div>
	);
}
export const ModeChip = observer(ModeChipImpl);
/** The chip in the desktop toolbar (composer.left). */
export const ModeChipDesktop = observer((p: ComposerSlotProps) =>
	p.compact ? null : <ModeChipImpl {...p} />,
);
/** The chip above the phone's one-row composer (composer.top). */
export const ModeChipPhone = observer((p: ComposerSlotProps) =>
	p.compact ? <ModeChipImpl {...p} /> : null,
);
