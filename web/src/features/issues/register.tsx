/**
 * GitHub issue chip in the desktop session header, opening the issue
 * card; on the phone, the sheet the agent menu's "Issue #N" opens. Metadata and a lazy chunk only
 * (this file loads at start); the chunk loads only for an agent with an
 * issue.
 */
import type { AgentRow } from "../../api/types.ts";
import { lazy } from "../../lib/lazy.tsx";
import { registerSlot, type SlotProps } from "../../lib/registry.tsx";
import { observer } from "../../lib/signals.ts";
import { issueOf } from "./open.ts";

type Props = { agent: AgentRow; mobile: boolean; number: string };
const none = () => <></>;
const Desktop = lazy<Props>(() => import("./IssueDesktop.tsx"), none);
const Phone = lazy<Props>(() => import("./IssuePhone.tsx"), none);

registerSlot("session.header", {
	id: "issue",
	order: -10,
	component: observer(({ agent, mobile }: SlotProps["session.header"]) => {
		const n = issueOf(agent);
		if (!n) return null;
		return mobile ? (
			<Phone agent={agent} mobile number={n} />
		) : (
			<Desktop agent={agent} mobile={false} number={n} />
		);
	}),
});
