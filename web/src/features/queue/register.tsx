/**
 * The queue strip: messages not yet in the agent's conversation, above the
 * composer's text field (Queue.tsx, one lazy chunk).
 */
import { lazy } from "../../lib/lazy.tsx";
import { registerSlot } from "../../lib/registry.tsx";

const none = () => <></>;

registerSlot("composer.top", {
	id: "queue.strip",
	order: -20,
	component: lazy(
		() => import("./Queue.tsx").then((m) => ({ default: m.QueueStrip })),
		none,
	),
});
