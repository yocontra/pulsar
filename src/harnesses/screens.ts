/**
 * Reads a harness TUI from a tmux capture (`capture-pane -p -e`, with its
 * colours): which mode its footer shows, and whether its input box is empty.
 * Pure functions over text, so tests run on captured fixtures
 * (test/fixtures/panes/, recorded from the installed CLIs).
 *
 * Every reader fails closed: a screen it does not recognise (a dialog, a
 * picker, a version that draws its footer differently) is `recognized:
 * false`, and nothing is typed into it.
 */

export type ScreenHarness = "claude" | "codex" | "opencode";

export interface Screen {
	/** The harness's normal prompt screen: an input box and its footer. */
	recognized: boolean;
	/** The mode the footer shows (the harness's own mode id); null when it shows none we know. */
	mode: string | null;
	/** `empty`: nothing typed (a dim placeholder counts as empty); `draft`: someone's unsent text. */
	input: "empty" | "draft" | null;
}

const UNRECOGNIZED: Screen = { recognized: false, mode: null, input: null };

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are the input.
const SGR = /\x1b\[[0-9;:?]*[A-Za-z]/g;
const OTHER_ESC =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are the input.
	/\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;

export function stripAnsi(s: string): string {
	return s.replace(OTHER_ESC, "").replace(SGR, "");
}

/** True when the text right after `marker` on a raw line starts dim (a placeholder). */
function dimAfter(raw: string, marker: string): boolean {
	const at = raw.indexOf(marker);
	if (at < 0) return false;
	const rest = raw.slice(at + marker.length);
	// Spaces and SGRs before the first visible character, in any order.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are the input.
	const lead = /^(?:\x1b\[[0-9;]*m|\s)*/.exec(rest)?.[0] ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are the input.
	const codes = lead.match(/\x1b\[[0-9;]*m/g) ?? [];
	return codes.some((c) => c.slice(2, -1).split(";").includes("2"));
}

function lines(ansi: string): { raw: string[]; plain: string[] } {
	const raw = ansi.replace(/\r/g, "").split("\n");
	return { raw, plain: raw.map((l) => stripAnsi(l)) };
}

/** A box rule: dashes across, maybe with a label (the session name) set in it. */
const RULE = /^─{20,}(?: [^─]{1,80} ─+)?\s*$/;

/** Claude Code's footer words for each permission mode (2.1.330: `<indicator> on`). */
const CLAUDE_FOOTER: Array<[RegExp, string]> = [
	[/\bmanual mode on\b/, "default"],
	[/\baccept edits on\b/, "acceptEdits"],
	[/\bplan mode on\b/, "plan"],
	[/\bauto mode on\b/, "auto"],
	[/\bbypass permissions on\b/, "bypassPermissions"],
	[/\bdon't ask on\b/, "dontAsk"],
];

/**
 * Claude Code: the input box is a `❯` line at column 0 between two rules; the
 * mode is in the footer under the bottom rule. A `❯` that is indented is a
 * menu row, and one with no rule above it is a dialog's choice.
 */
export function readClaude(ansi: string): Screen {
	const { raw, plain } = lines(ansi);
	for (let i = plain.length - 1; i > 0; i--) {
		if (!plain[i]!.startsWith("❯") || !RULE.test(plain[i - 1]!)) continue;
		let end = -1;
		for (let j = i + 1; j < Math.min(plain.length, i + 30); j++)
			if (RULE.test(plain[j]!)) {
				end = j;
				break;
			}
		if (end < 0) return UNRECOGNIZED;
		const first = plain[i]!.slice(1).trim();
		const more = plain.slice(i + 1, end).some((l) => l.trim() !== "");
		const input: Screen["input"] =
			more || (first !== "" && !dimAfter(raw[i]!, "❯")) ? "draft" : "empty";
		const footer = plain
			.slice(end + 1, end + 5)
			.join("\n")
			.toLowerCase();
		let mode: string | null = null;
		for (const [re, id] of CLAUDE_FOOTER)
			if (re.test(footer)) {
				mode = id;
				break;
			}
		// Older builds draw nothing for the default mode but the shortcuts hint.
		if (!mode && /\? for shortcuts/.test(footer)) mode = "default";
		return { recognized: true, mode, input };
	}
	return UNRECOGNIZED;
}

/**
 * Codex: the composer is a `›` line at column 0 with the model line and the
 * shortcuts hint under it; `Plan mode (⇧tab to cycle)` there means plan.
 */
export function readCodex(ansi: string): Screen {
	const { raw, plain } = lines(ansi);
	for (let i = plain.length - 1; i >= 0; i--) {
		if (!plain[i]!.startsWith("›")) continue;
		const below = plain.slice(i + 1, i + 6);
		// The model line (`  <model> <effort> · <folder>`) closes the composer;
		// the shortcuts hint under it hides while someone types.
		const modelLine = below.findIndex((l) => /^ {2}\S[^·]* · [~/]/.test(l));
		if (modelLine < 0) return UNRECOGNIZED;
		const extra = below.slice(0, modelLine).some((l) => l.trim() !== "");
		const first = plain[i]!.slice(1).trim();
		const input: Screen["input"] =
			extra || (first !== "" && !dimAfter(raw[i]!, "›")) ? "draft" : "empty";
		const mode = below
			.slice(modelLine, modelLine + 2)
			.some((l) => /\bPlan mode\b/.test(l))
			? "plan"
			: "default";
		return { recognized: true, mode, input };
	}
	return UNRECOGNIZED;
}

/** OpenCode's placeholder colour (its muted grey) at the start of the input line. */
const OPENCODE_MUTED =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are the input.
	/┃(?:\x1b\[[0-9;]*m)*\s*(?:\x1b\[[0-9;]*m)*\x1b\[38;2;128;128;128m/;

/**
 * OpenCode: a box of `┃` lines whose last row names the agent
 * (`Build · <model>`), with `shift+tab agents` in the hints under it.
 */
export function readOpencode(ansi: string): Screen {
	const { raw, plain } = lines(ansi);
	for (let i = plain.length - 1; i >= 0; i--) {
		const m = /┃\s+(Build|Plan)\s+·/.exec(plain[i]!);
		if (!m) continue;
		const hints = plain.slice(i + 1, i + 4).join("\n");
		if (!/shift\+tab|ctrl\+p/.test(hints)) return UNRECOGNIZED;
		let draft = false;
		for (let j = i - 1; j >= 0 && plain[j]!.includes("┃"); j--) {
			const text = plain[j]!.slice(plain[j]!.indexOf("┃") + 1).trim();
			if (text && !OPENCODE_MUTED.test(raw[j]!)) draft = true;
		}
		return {
			recognized: true,
			mode: m[1]!.toLowerCase(),
			input: draft ? "draft" : "empty",
		};
	}
	return UNRECOGNIZED;
}

export function readScreen(harness: ScreenHarness, ansi: string): Screen {
	switch (harness) {
		case "claude":
			return readClaude(ansi);
		case "codex":
			return readCodex(ansi);
		case "opencode":
			return readOpencode(ansi);
	}
}
