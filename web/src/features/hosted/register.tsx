import { CloudIcon } from "lucide-react";
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

const Desktop = lazy<PageProps>(() => import("./Desktop.tsx"));
const Phone = lazy<PageProps>(() => import("./Phone.tsx"));
const PhoneButton = lazy<{ open: () => void }>(
	() => import("./PhoneButton.tsx"),
	() => <></>,
);
const offered = () => can("hosted");
const open = () => navigate({ view: "page", name: "hosted" });

registerPage({ name: "hosted", desktop: Desktop, phone: Phone });
registerCommand({
	id: "hosted.open",
	label: "Hosted agents",
	group: "Go to",
	keywords: ["Copilot", "Codex Cloud", "Cursor"],
	when: offered,
	run: open,
});
registerSlot("sidebar.header", {
	id: "hosted.open",
	// Keep the desktop buttons to the right in place on older servers.
	order: -1,
	component: observer(({ mobile }: SlotProps["sidebar.header"]) => {
		if (!offered()) return null;
		if (mobile) return <PhoneButton open={open} />;
		return (
			<button
				type="button"
				className="d-btn ghost sm icon"
				aria-label="Hosted agents"
				title="Hosted agents"
				onClick={open}
			>
				<CloudIcon size={20} />
			</button>
		);
	}),
});
