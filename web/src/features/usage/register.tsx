/**
 * Usage (tokens and cost): the page, its sidebar and Home buttons, the
 * Cmd-K command and mod+U, and the session header's usage line. Metadata
 * and lazy chunks only (this file is in the first load).
 */
import { ChartColumnIcon } from "lucide-react";
import { lazy } from "../../lib/lazy.tsx";
import {
	type PageProps,
	registerCommand,
	registerPage,
	registerSlot,
	type SlotProps,
} from "../../lib/registry.tsx";
import { navigate } from "../../lib/router.ts";
import { observer } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";

const none = () => <></>;
const UsageDesktop = lazy<PageProps>(() =>
	import("../../usage/UsagePages.tsx").then((m) => ({
		default: m.UsageDesktop,
	})),
);
const UsagePhone = lazy<PageProps>(() =>
	import("../../usage/UsagePages.tsx").then((m) => ({ default: m.UsagePhone })),
);
const AgentUsage = lazy<{ agentId: string }>(
	() => import("../../usage/AgentUsage.tsx"),
	none,
);

const offered = () => can("usage");
const open = () => navigate({ view: "page", name: "usage" });

registerPage({ name: "usage", desktop: UsageDesktop, phone: UsagePhone });

registerSlot("sidebar.header", {
	id: "usage",
	component: observer(({ mobile }: SlotProps["sidebar.header"]) => {
		if (!offered()) return null;
		// The phone reaches Usage from its tab bar (mobile/tabs.ts).
		if (mobile) return null;
		return (
			<button
				type="button"
				className="d-btn ghost sm icon"
				aria-label="Usage"
				title="Usage (⌘U)"
				onMouseEnter={() => void UsageDesktop.preload()}
				onClick={open}
			>
				<ChartColumnIcon />
			</button>
		);
	}),
});

registerSlot("session.header", {
	id: "usage",
	component: observer(({ agent, mobile }: SlotProps["session.header"]) =>
		// Subagents count toward their parent's session.
		!mobile && offered() && !agent.id.includes("/sub:") ? (
			<AgentUsage agentId={agent.id} />
		) : null,
	),
});

registerCommand({
	id: "usage.open",
	label: "Usage",
	group: "Go to",
	keys: ["mod", "U"],
	keywords: ["tokens", "cost", "spend", "price"],
	when: offered,
	run: open,
});

// mod+U opens the page from anywhere, also while typing (like Cmd-K).
if (typeof window !== "undefined")
	window.addEventListener("keydown", (e) => {
		if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
		if (e.key !== "u" && e.key !== "U") return;
		if (!offered()) return;
		// A dialog or menu is open: leave the key to it.
		if (document.querySelector('.d-pop, .d-menu, [role="dialog"]')) return;
		e.preventDefault();
		open();
	});
