/**
 * Diagnostics: `pulsar doctor` for every machine in the pool. The page,
 * its Cmd-K command and a Settings section that opens it. Metadata and
 * lazy chunks only (this file is in the first load).
 */
import { lazy } from "../../lib/lazy.tsx";
import {
	type PageProps,
	registerCommand,
	registerPage,
	registerSettingsSection,
} from "../../lib/registry.tsx";
import { navigate } from "../../lib/router.ts";
import { can } from "../../lib/store.ts";

const none = () => <></>;
const Desktop = lazy<PageProps>(() =>
	import("./DiagnosticsPages.tsx").then((m) => ({
		default: m.DiagnosticsDesktop,
	})),
);
const Phone = lazy<PageProps>(() =>
	import("./DiagnosticsPages.tsx").then((m) => ({
		default: m.DiagnosticsPhone,
	})),
);
const DesktopSection = lazy<{ close: () => void }>(
	() => import("./Section.tsx"),
	none,
);
const PhoneSection = lazy<object>(() => import("./PhoneSection.tsx"), none);

const offered = () => can("diagnostics");

registerPage({ name: "diagnostics", desktop: Desktop, phone: Phone });

registerSettingsSection({
	id: "diagnostics",
	title: "Diagnostics",
	when: offered,
	desktop: ({ close }) => <DesktopSection close={close} />,
	phone: () => <PhoneSection />,
});

registerCommand({
	id: "diagnostics.open",
	label: "Diagnostics",
	group: "Go to",
	keywords: [
		"doctor",
		"health",
		"check",
		"version",
		"tailscale",
		"certificate",
	],
	when: offered,
	run: () => navigate({ view: "page", name: "diagnostics" }),
});
