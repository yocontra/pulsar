/**
 * Pulsar design system: the light entry. Safe to import from any initial
 * route: no Radix menus, Streamdown, Shiki or Markdown here. Heavy pieces
 * (the conversation, code, diffs, approval details) are in
 * `ds/conversation.ts`; import that from a lazy route chunk.
 *
 * Tokens are CSS: styles/tokens.css (--ds-*), loaded by globals.css.
 * Ionic: import styles/ionic-theme.css after Ionic's core CSS.
 * See web/DESIGN.md for the full contract.
 */
export {
	AgentAvatar,
	type AvatarSize,
	HarnessGlyph,
	type HarnessKey,
	harnessKey,
	harnessName,
} from "../components/ui/agent-avatar.tsx";
export { AgentMark } from "../components/ui/agent-mark.tsx";
export { Kbd } from "../components/ui/kbd.tsx";
export {
	Skeleton,
	SkeletonAvatar,
	SkeletonGroup,
	SkeletonText,
} from "../components/ui/skeleton.tsx";
export {
	type AgentState,
	AgentStatus,
	CountBadge,
	NeedsBadge,
	StatusBadge,
	StatusDot,
	type Tone,
} from "../components/ui/status.tsx";
export {
	age,
	ago,
	badgeCount,
	clock,
	duration,
	needYou,
	noun,
	num,
	plural,
	STATUS_LABEL,
	shortModel,
	since,
	timer,
} from "../lib/format.ts";
export { WAKE_TAG, WAKE_WHY, wakeSummary } from "../lib/wake.ts";
