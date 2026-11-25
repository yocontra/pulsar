import { harnessUi } from "../../harnesses/index.ts";
import { cx as cn } from "../../lib/cx.ts";
import { STATUS_LABEL } from "../../lib/format.ts";

/**
 * Harness identity: the harness's own mark (from its UI adapter in
 * web/src/harnesses/) in one color on a tinted rounded square, so lists are
 * scannable by harness at a glance. Unknown harnesses get their initial.
 * Colors come from the `--ds-h-<harness>-*` tokens.
 */
export type HarnessKey =
	| "claude"
	| "codex"
	| "opencode"
	| "pi"
	| "omp"
	| "cursor"
	| "gemini"
	| "vscode"
	| "other";

/** "claude-code", "Claude", "codex-cli" → a known harness key. */
export function harnessKey(harness: string | null | undefined): HarnessKey {
	const h = (harness ?? "").toLowerCase();
	if (h.includes("claude")) return "claude";
	if (h.includes("codex")) return "codex";
	if (h.includes("opencode") || h === "oc") return "opencode";
	if (h.includes("omp")) return "omp";
	if (h === "pi" || h.startsWith("pi-") || h.startsWith("pi ")) return "pi";
	if (h.includes("cursor")) return "cursor";
	if (h.includes("gemini")) return "gemini";
	if (h.includes("vscode") || h.includes("vs code")) return "vscode";
	return "other";
}

/** A harness's display name: "Claude Code", "Codex"; unknown ones as given. */
export function harnessName(harness: string | null | undefined): string {
	const k = harnessKey(harness);
	if (harness === "cli") return "Terminal";
	return harnessUi(k === "other" ? harness : k).name ?? (harness || "Agent");
}

export function HarnessGlyph({
	harness,
	size = 16,
}: {
	harness: string | null | undefined;
	size?: number;
}) {
	const k = harnessKey(harness);
	const icon = k === "other" ? undefined : harnessUi(k).icon;
	if (!icon)
		return (
			<span className="ds-avatar-initial" aria-hidden="true">
				{(harness?.trim()[0] ?? "A").toUpperCase()}
			</span>
		);
	return (
		<svg
			width={size}
			height={size}
			viewBox={icon.viewBox}
			fill={icon.stroke ? "none" : "currentColor"}
			stroke={icon.stroke ? "currentColor" : undefined}
			strokeWidth={icon.stroke ? 2.2 : undefined}
			strokeLinecap="round"
			strokeLinejoin="round"
			fillRule={icon.evenOdd ? "evenodd" : undefined}
			aria-hidden="true"
			data-mark={k}
		>
			{icon.paths.map((d) => (
				<path key={d} d={d} />
			))}
		</svg>
	);
}

export type AvatarSize = "xs" | "sm" | "md" | "list" | "lg";
/** 18 / 24 / 32 / 40 (a two-line list row) / 44 px. */
const PX: Record<AvatarSize, number> = {
	xs: 18,
	sm: 24,
	md: 32,
	list: 40,
	lg: 44,
};

/**
 * An agent's avatar: its harness mark, with an optional status dot in the
 * corner. `label` names it for VoiceOver; decorative when omitted.
 */
export function AgentAvatar({
	harness,
	size = "md",
	status,
	label,
	className,
}: {
	harness: string | null | undefined;
	size?: AvatarSize;
	/** Draws a small status dot on the corner (shape + color). */
	status?: keyof typeof STATUS_LABEL;
	label?: string;
	className?: string;
}) {
	const k = harnessKey(harness);
	const px = PX[size];
	return (
		<span
			className={cn("ds-avatar", `ds-avatar--${size}`, className)}
			data-harness={k}
			aria-hidden={label ? undefined : true}
			title={
				status
					? `${harnessName(harness)} · ${STATUS_LABEL[status]}`
					: harnessName(harness)
			}
		>
			{label && <span className="sr-only">{label}</span>}
			<HarnessGlyph harness={harness} size={Math.round(px * 0.56)} />
			{status && (
				<span className={`ds-avatar-status s-${status}`} aria-hidden="true" />
			)}
		</span>
	);
}
