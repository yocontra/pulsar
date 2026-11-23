/**
 * Slash commands and modes in the composer (slash.tsx, one lazy chunk loaded
 * with the first composer): the `/` menu, the phone's command sheet, and
 * the mode chip.
 */
import { lazy } from "../../lib/lazy.tsx";
import { registerSlot } from "../../lib/registry.tsx";

const none = () => <></>;
const load = () => import("./slash.tsx");

registerSlot("composer.top", {
	id: "composer.slash",
	component: lazy(() => load().then((m) => ({ default: m.SlashMenu })), none),
});
registerSlot("composer.top", {
	id: "composer.mode",
	order: -10,
	component: lazy(
		() => load().then((m) => ({ default: m.ModeChipPhone })),
		none,
	),
});
registerSlot("composer.left", {
	id: "composer.slash-button",
	order: -8,
	component: lazy(() => load().then((m) => ({ default: m.SlashButton })), none),
});
registerSlot("composer.left", {
	id: "composer.mode",
	order: 20,
	component: lazy(
		() => load().then((m) => ({ default: m.ModeChipDesktop })),
		none,
	),
});
