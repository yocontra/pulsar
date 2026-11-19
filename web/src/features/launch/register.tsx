/**
 * New agent (features/launch): the sidebar's and Home's header button,
 * Cmd-K, mod+alt+N, a project's "New agent in…", and the draft page
 * `#/new`. Metadata and lazy parts only: this file loads at start.
 */
import { SquarePenIcon } from "lucide-react";
import { lazy } from "../../lib/lazy.tsx";
import {
	registerCommand,
	registerPage,
	registerPaletteProvider,
	registerSlot,
} from "../../lib/registry.tsx";
import { observer } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";
import { openDraft } from "./open.ts";

const none = () => <></>;
const PhoneButton = lazy(() => import("./PhoneButton.tsx"), none);

function NewAgentButtonImpl({ mobile }: { mobile: boolean }) {
	if (!can("launch")) return null;
	if (mobile) return <PhoneButton />;
	return (
		<button
			type="button"
			className="d-btn ghost sm icon"
			aria-label="New agent"
			title="New agent"
			onClick={() => openDraft()}
		>
			<SquarePenIcon />
		</button>
	);
}

registerSlot("sidebar.header", {
	id: "launch.new",
	component: observer(NewAgentButtonImpl),
});

registerPage({
	name: "new",
	desktop: lazy(() => import("./DraftDesktop.tsx")),
	phone: lazy(() => import("./DraftPhone.tsx")),
});

registerCommand({
	id: "launch.new",
	label: "New agent",
	keys: ["mod", "alt", "N"],
	keywords: ["start", "launch", "spawn", "create"],
	when: () => can("launch"),
	run: () => openDraft(),
});

registerPaletteProvider({
	id: "launch.in",
	group: "New agent in…",
	search: async (q, signal) => {
		if (!can("launch")) return [];
		const m = await import("./provider.tsx");
		return m.searchProjects(q, signal);
	},
});

// mod+alt+N (by key position: alt+N types a dead key on a Mac).
if (typeof window !== "undefined")
	window.addEventListener("keydown", (e) => {
		if (
			(e.metaKey || e.ctrlKey) &&
			e.altKey &&
			!e.shiftKey &&
			e.code === "KeyN" &&
			!e.isComposing &&
			can("launch")
		) {
			e.preventDefault();
			openDraft();
		}
	});
