/**
 * Git actions (commit, push, PR) in the session header: the desktop split
 * button and the phone's branch button with its sheet. Metadata and lazy
 * chunks only (this file loads at start).
 */
import type { AgentRow } from "../../api/types.ts";
import { lazy } from "../../lib/lazy.tsx";
import { registerSlot } from "../../lib/registry.tsx";

type Props = { agent: AgentRow; mobile: boolean };
const none = () => <></>;
const Desktop = lazy<Props>(() => import("./GitDesktop.tsx"), none);
const Phone = lazy<Props>(() => import("./GitPhone.tsx"), none);

registerSlot("session.header", {
	id: "git",
	component: (p: Props) => (p.mobile ? <Phone {...p} /> : <Desktop {...p} />),
});
