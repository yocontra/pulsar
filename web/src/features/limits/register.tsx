/**
 * Plan usage limits: the session header note, the "Usage limits" settings
 * section and the in-app warning toast. The Usage page's section is in the
 * usage chunk (Limits.tsx). Metadata and lazy chunks only (first load).
 */
import { lazy } from "../../lib/lazy.tsx";
import {
	registerSettingsSection,
	registerSlot,
	type SlotProps,
} from "../../lib/registry.tsx";
import { observer } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";

const none = () => <></>;
const LimitChip = lazy<{ agentId: string; mobile: boolean }>(
	() => import("./LimitChip.tsx"),
	none,
);
const Desktop = lazy<object>(
	() => import("./Section.tsx").then((m) => ({ default: m.DesktopSection })),
	none,
);
const Phone = lazy<object>(
	() => import("./Section.tsx").then((m) => ({ default: m.PhoneSection })),
	none,
);

registerSlot("session.header", {
	id: "limits",
	component: observer(({ agent, mobile }: SlotProps["session.header"]) =>
		can("usage") && !agent.id.includes("/sub:") ? (
			<LimitChip agentId={agent.id} mobile={mobile} />
		) : null,
	),
});

registerSettingsSection({
	id: "usage-limits",
	title: "Usage limits",
	when: () => can("usage"),
	desktop: () => <Desktop />,
	phone: () => <Phone />,
});

if (typeof window !== "undefined")
	setTimeout(() => {
		import("./toast.ts").then(
			(m) => m.start(),
			() => {},
		);
	}, 0);
