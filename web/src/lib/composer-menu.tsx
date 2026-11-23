/**
 * The phone composer's + menu: composer parts (attach, commands) add their
 * entries here and stay mounted for what must outlive the menu (file
 * inputs, sheets). The menu itself is mobile/ComposerPlus.tsx.
 */
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

export interface ComposerAction {
	id: string;
	label: string;
	icon?: ReactNode;
	/** Lower first. */
	order?: number;
	disabled?: boolean;
	run: () => void;
}

interface Api {
	set: (a: ComposerAction) => void;
	remove: (id: string) => void;
}

const Ctx = createContext<Api | null>(null);

/** The + menu's entries, and the provider value that fills them. */
export function useComposerActions(): [ComposerAction[], Api] {
	const [map, setMap] = useState<Map<string, ComposerAction>>(new Map());
	const set = useCallback((a: ComposerAction) => {
		setMap((m) => new Map(m).set(a.id, a));
	}, []);
	const remove = useCallback((id: string) => {
		setMap((m) => {
			if (!m.has(id)) return m;
			const n = new Map(m);
			n.delete(id);
			return n;
		});
	}, []);
	const api = useMemo(() => ({ set, remove }), [set, remove]);
	const list = useMemo(
		() => [...map.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
		[map],
	);
	return [list, api];
}

export function ComposerActionsProvider({
	value,
	children,
}: {
	value: Api;
	children: ReactNode;
}) {
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Add an entry to the + menu while mounted (phone composer only: no-op
 * without a provider). `run` may change every render; the entry stays.
 */
export function useComposerAction(a: ComposerAction | null) {
	const api = useContext(Ctx);
	const run = useRef(a?.run);
	run.current = a?.run;
	// A new element each render: read at set time, never a dependency.
	const icon = useRef(a?.icon);
	icon.current = a?.icon;
	const id = a?.id;
	const label = a?.label;
	const order = a?.order;
	const disabled = a?.disabled;
	useEffect(() => {
		if (!api || !id || !label) return;
		api.set({
			id,
			label,
			order,
			disabled,
			icon: icon.current,
			run: () => run.current?.(),
		});
	}, [api, id, label, order, disabled]);
	useEffect(() => {
		if (!api || !id) return;
		return () => api.remove(id);
	}, [api, id]);
}
