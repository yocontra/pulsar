/**
 * Extension points, so features add UI without editing shared JSX:
 *
 * - Slots: `registerSlot("session.header", { id, component })` renders the
 *   component wherever the layout puts `<Slot name="session.header" … />`
 *   (sidebar header, session header, composer toolbar left/right). An empty
 *   slot renders nothing at all.
 * - Settings sections: a desktop and/or phone body under a title, after the
 *   built-in sections.
 * - Cmd-K: commands (shown with no query, and when their label matches) and
 *   result providers (searched as the operator types).
 * - Pages: `#/<name>/<arg>?<params>` routes rendered by both layouts.
 *
 * Each `register*` returns its unregister. Features register from
 * `src/features/<name>/register.tsx`, which src/features.ts loads at start:
 * keep those files to metadata and `lazy()` components (they count toward
 * the first-load budget), and import nothing that reads the route at load.
 */
import type { ComponentType, ReactNode, RefObject } from "react";
import type { AgentRow } from "../api/types.ts";
import type { Target } from "../components/Composer.tsx";
import type { ComposerDraft } from "./composer-draft.ts";
import { type Route, registerPageName } from "./hash.ts";
import { observer, type Signal, signal } from "./signals.ts";

interface Entry {
	/** Unique within its registry; a feature name is a good prefix. */
	id: string;
	/** Lower first; ties keep registration order. Default 0. */
	order?: number;
}

/** An ordered, observable list of entries. */
export class Registry<T extends Entry> {
	readonly entries: Signal<T[]> = signal<T[]>([]);

	add(entry: T): () => void {
		if (this.entries.value.some((e) => e.id === entry.id))
			throw new Error(`duplicate registration: ${entry.id}`);
		// Stable: equal orders keep the order they were added in.
		this.entries.value = [...this.entries.value, entry]
			.map((e, i) => ({ e, i }))
			.sort((a, b) => (a.e.order ?? 0) - (b.e.order ?? 0) || a.i - b.i)
			.map(({ e }) => e);
		return () => {
			this.entries.value = this.entries.value.filter((e) => e !== entry);
		};
	}

	/** The entries now (an observer re-renders when they change). */
	list(): T[] {
		return this.entries.value;
	}
}

// ----------------------------------------------------------------- slots

/** What the composer's toolbar slots get. */
export interface ComposerSlotProps {
	target: Target;
	/** The phone's one-row composer. */
	compact: boolean;
	/** A send is being checked or sent. */
	busy: boolean;
	/** The draft has text. */
	hasText: boolean;
	/** The draft's textarea (read or insert text). */
	textarea: RefObject<HTMLTextAreaElement | null>;
	/** Attached files and `@` picks of this draft (lib/composer-draft.ts). */
	draft: ComposerDraft;
}

/** Every slot and the props its components get. */
export interface SlotProps {
	/** Actions in the sidebar header (desktop) and Home's header (phone). */
	"sidebar.header": { mobile: boolean };
	/** Actions in a session's header, next to Stop. */
	"session.header": { agent: AgentRow; mobile: boolean };
	/** The composer toolbar's left end (attach). */
	"composer.left": ComposerSlotProps;
	/** The composer toolbar's right end, before Send (send / stop). */
	"composer.right": ComposerSlotProps;
	/** Above the composer's text field (attachment tiles, the `@` menu). */
	"composer.top": ComposerSlotProps;
}

export type SlotName = keyof SlotProps;

export interface SlotEntry<K extends SlotName> extends Entry {
	component: ComponentType<SlotProps[K]>;
	/** Render on one layout only (skeletons leave no placeholder on the other). */
	only?: "desktop" | "phone";
}

const slots: { [K in SlotName]: Registry<SlotEntry<K>> } = {
	"sidebar.header": new Registry(),
	"session.header": new Registry(),
	"composer.left": new Registry(),
	"composer.right": new Registry(),
	"composer.top": new Registry(),
};

export function registerSlot<K extends SlotName>(
	name: K,
	entry: SlotEntry<K>,
): () => void {
	return slots[name].add(entry);
}

/** What is registered in a slot (tests, and layouts that need a count). */
export function slotEntries<K extends SlotName>(name: K): SlotEntry<K>[] {
	return slots[name].list();
}

function SlotImpl({ name, props }: { name: SlotName; props: object }) {
	const mobile = (props as { mobile?: boolean }).mobile;
	const list = (slots[name].list() as SlotEntry<SlotName>[]).filter(
		(e) => !e.only || mobile === undefined || (e.only === "phone") === mobile,
	);
	if (list.length === 0) return null;
	return (
		<>
			{list.map((e) => {
				const C = e.component as ComponentType<object>;
				return <C key={e.id} {...props} />;
			})}
		</>
	);
}
const ObservedSlot = observer(SlotImpl);

/** Renders a slot's components in order; nothing when empty. */
export function Slot<K extends SlotName>({
	name,
	...props
}: { name: K } & SlotProps[K]) {
	return <ObservedSlot name={name} props={props} />;
}

// ------------------------------------------------------- settings sections

export interface SettingsSection extends Entry {
	/** The section heading (desktop nav and heading, phone group title). */
	title: string;
	/** Desktop body, under the heading (rows in a `d-card d-set-card` list). */
	desktop?: ComponentType;
	/** Phone body: IonItems inside the group's inset list. */
	phone?: ComponentType;
	/** Shown only while this is true (e.g. a feature the daemon offers). */
	when?: () => boolean;
}

export const settingsSections = new Registry<SettingsSection>();

export function registerSettingsSection(s: SettingsSection): () => void {
	return settingsSections.add(s);
}

/** Sections to show now, on this layout. */
export function shownSettingsSections(mobile: boolean): SettingsSection[] {
	return settingsSections
		.list()
		.filter((s) => (mobile ? s.phone : s.desktop) && (s.when?.() ?? true));
}

// ------------------------------------------------------------------ Cmd-K

export interface PaletteCommand extends Entry {
	label: string;
	/** Default "Actions". */
	group?: string;
	icon?: ReactNode;
	/** Shortcut keys shown on the right (`["mod", "U"]`). */
	keys?: string[];
	/** More words that match a query. */
	keywords?: string[];
	when?: () => boolean;
	run: () => void;
}

export interface PaletteResult {
	key: string;
	label: string;
	sub?: ReactNode;
	icon?: ReactNode;
	trail?: ReactNode;
	run: () => void;
}

export interface PaletteProvider extends Entry {
	/** The group heading its results show under ("In messages"). */
	group: string;
	/** Results for a query (debounced; aborted when the query changes). */
	search: (q: string, signal: AbortSignal) => Promise<PaletteResult[]>;
}

export const paletteCommands = new Registry<PaletteCommand>();
export const paletteProviders = new Registry<PaletteProvider>();

export function registerCommand(c: PaletteCommand): () => void {
	return paletteCommands.add(c);
}

export function registerPaletteProvider(p: PaletteProvider): () => void {
	return paletteProviders.add(p);
}

/** Commands to list: all (shown) with no query, else those whose words match. */
export function matchingCommands(q: string): PaletteCommand[] {
	const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return paletteCommands.list().filter((c) => {
		if (!(c.when?.() ?? true)) return false;
		if (words.length === 0) return true;
		const hay = [c.label, ...(c.keywords ?? [])].join(" ").toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

// ------------------------------------------------------------------ pages

export interface PageProps {
	/** The path after the name (`#/usage/7d` → "7d"), or "". */
	arg: string;
	params: Record<string, string>;
}

export interface PageEntry {
	/** The first path segment (`usage` → `#/usage`): lowercase letters, digits, dashes. */
	name: string;
	/** The desktop's main pane; without it the desktop shows Home. */
	desktop?: ComponentType<PageProps> & { preload?: () => Promise<unknown> };
	/** The phone's page (its own IonHeader/IonContent, like the others). */
	phone?: ComponentType<PageProps> & { preload?: () => Promise<unknown> };
}

const pages = new Map<string, PageEntry>();

export function registerPage(p: PageEntry): () => void {
	if (pages.has(p.name)) throw new Error(`duplicate page: ${p.name}`);
	registerPageName(p.name);
	pages.set(p.name, p);
	return () => {
		if (pages.get(p.name) === p) pages.delete(p.name);
	};
}

/** The registered page for a `page` route. */
export function pageFor(r: Route): PageEntry | undefined {
	return r.view === "page" ? pages.get(r.name) : undefined;
}

/** A page route's component props. */
export function pageProps(r: Extract<Route, { view: "page" }>): PageProps {
	return { arg: r.arg ?? "", params: r.params ?? {} };
}
