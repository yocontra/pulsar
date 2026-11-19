/**
 * Finish and fail notifications: the "Agent activity" settings section and
 * the in-app coordinator (toasts, sounds, badge). Both load after the first
 * paint; this file stays small (first-load budget).
 */
import { lazy, Suspense } from "react";
import { registerSettingsSection } from "../../lib/registry.tsx";

const Desktop = lazy(() =>
	import("./Section.tsx").then((m) => ({ default: m.DesktopSection })),
);
const Phone = lazy(() =>
	import("./Section.tsx").then((m) => ({ default: m.PhoneSection })),
);

registerSettingsSection({
	id: "agent-activity",
	title: "Agent activity",
	desktop: () => (
		<Suspense fallback={null}>
			<Desktop />
		</Suspense>
	),
	phone: () => (
		<Suspense fallback={null}>
			<Phone />
		</Suspense>
	),
});

if (typeof window !== "undefined")
	setTimeout(() => {
		import("./coordinator.ts").then(
			(m) => m.start(),
			() => {},
		);
	}, 0);
