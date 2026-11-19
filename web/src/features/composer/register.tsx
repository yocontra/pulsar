/**
 * Composer attachments, the `@` file menu and Stop (attach.tsx, one lazy
 * chunk loaded with the first composer).
 */
import { lazy } from "../../lib/lazy.tsx";
import { registerSlot } from "../../lib/registry.tsx";

const none = () => <></>;
const load = () => import("./attach.tsx");

registerSlot("composer.left", {
	id: "composer.attach",
	order: -10,
	component: lazy(
		() => load().then((m) => ({ default: m.AttachButton })),
		none,
	),
});
registerSlot("composer.top", {
	id: "composer.attachments",
	component: lazy(() => load().then((m) => ({ default: m.ComposerTop })), none),
});
registerSlot("composer.right", {
	id: "composer.stop",
	order: 100,
	component: lazy(
		() => load().then((m) => ({ default: m.ComposerStop })),
		none,
	),
});
