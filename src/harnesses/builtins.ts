/**
 * Each harness's own slash commands, for the composer's `/` menu. No harness
 * lists its built-ins through an API, so these are static, keyed by the CLI
 * version they were read from (`version`). A newer installed CLI still gets
 * this list; `builtinsFor` says it may be stale (doctor and the catalog show
 * that).
 *
 * Sources: Claude Code 2.1.330's own menu (each name typed into a private
 * tmux session and its menu row read back); Codex 0.171.0's command table
 * (binary strings); OpenCode 2.2.5's `slash:` registrations; pi 1.5.0's
 * docs/slash-commands.md; omp's builtin registry.
 *
 * `dialog`: run with no arguments, the command opens a picker or dialog in
 * the terminal that only someone at the terminal can answer. The menu offers
 * those only with arguments (`args`), or not at all when they take none.
 */

export interface BuiltinCommand {
	name: string;
	description: string;
	/** What goes after the name, shown as a hint (`<name>`, `[level]`). */
	args?: string;
	dialog?: boolean;
	terminalOnly?: boolean;
}

export interface BuiltinList {
	/** The CLI version this list was read from. */
	version: string;
	commands: BuiltinCommand[];
}

const c = (
	name: string,
	description: string,
	extra: Partial<BuiltinCommand> = {},
): BuiltinCommand => ({ name, description, ...extra });

const CLAUDE: BuiltinList = {
	version: "2.1.330",
	commands: [
		c("add-dir", "Add a working directory", { args: "<path>" }),
		c("advisor", "Let Claude consult a stronger model at key moments"),
		c("artifacts", "Browse your published and shared artifacts", {
			dialog: true,
		}),
		c("autocompact", "Set how full the context gets before auto-summarizing", {
			args: "<percent>",
			dialog: true,
		}),
		c(
			"background",
			"Send this session to the background and free the terminal",
		),
		c("batch", "Plan a large change; background agents each open a PR", {
			args: "<task>",
		}),
		c("branch", "Create a branch of the current conversation at this point"),
		c("btw", "Ask a side question without interrupting Claude", {
			args: "<question>",
		}),
		c("cd", "Move this session to a new working directory", { args: "<path>" }),
		c(
			"clear",
			"Start a new session with empty context; the old one stays in /resume",
		),
		c("code-review", "Review the current diff or a PR for bugs", {
			args: "[level] [target]",
		}),
		c("color", "Set the prompt bar color for this session", {
			args: "<color>",
			dialog: true,
		}),
		c("compact", "Free up context by summarizing the conversation so far", {
			args: "[instructions]",
		}),
		c("config", "Open settings", { dialog: true }),
		c("context", "Show what fills the context"),
		c("copy", "Copy the last response to clipboard"),
		c("debug", "Turn on debug logging and investigate problems"),
		c("diff", "Toggle the diff panel showing uncommitted changes"),
		c("doctor", "Health-check your setup and fix issues"),
		c("effort", "Set the model's effort level", {
			args: "<level>",
			dialog: true,
		}),
		c("exit", "Exit the CLI"),
		c("export", "Export this session to a file or clipboard", {
			args: "[file]",
			dialog: true,
		}),
		c("fast", "Toggle fast mode"),
		c("feedback", "Send feedback or report a bug", { dialog: true }),
		c(
			"fewer-permission-prompts",
			"Pre-approve safe read-only commands based on your usage",
		),
		c("focus", "Toggle focus view: just your prompt, summary, and response"),
		c(
			"fork",
			"Copy this conversation into a new background session and keep working here",
		),
		c("goal", "Set a goal Claude checks before stopping", { args: "<goal>" }),
		c("help", "Show help and available commands", { dialog: true }),
		c("hooks", "View hook configurations for tool events", { dialog: true }),
		c("ide", "Manage IDE integrations and show status", { dialog: true }),
		c("init", "Initialize a new CLAUDE.md file with codebase documentation"),
		c("insights", "Generate a report analyzing your Claude Code sessions"),
		c("keybindings", "Open your keyboard shortcuts file"),
		c("loop", "Repeat a prompt or command on an interval", {
			args: "[interval] <prompt>",
		}),
		c("mcp", "Manage MCP servers", { dialog: true }),
		c("memory", "Edit CLAUDE.md files and memory settings", { dialog: true }),
		c("model", "Switch model", { args: "<model>", dialog: true }),
		c("output-style", "List output styles or switch to one", {
			args: "<style>",
			dialog: true,
		}),
		c("permissions", "Manage allow and deny tool permission rules", {
			dialog: true,
		}),
		c("plan", "Turn on plan mode or view the plan", { args: "[description]" }),
		c("plugin", "Manage Claude Code plugins", { dialog: true }),
		c("recap", "Generate a one-line session recap now"),
		c("release-notes", "View release notes", { dialog: true }),
		c(
			"reload-plugins",
			"Activate pending plugin changes in the current session",
		),
		c(
			"reload-skills",
			"Pick up skills added or changed on disk during this session",
		),
		c("rename", "Rename the current conversation", { args: "<name>" }),
		c("restart", "Restart Claude Code and keep this session"),
		c("resume", "Resume a previous session", {
			args: "<session>",
			dialog: true,
		}),
		c("rewind", "Restore earlier code, conversation, or both", {
			dialog: true,
		}),
		c("schedule", "Create and manage routines: cloud agents on a schedule", {
			args: "<request>",
		}),
		c(
			"security-review",
			"Complete a security review of the pending changes on the current branch",
		),
		c("simplify", "Clean up the changed code without changing behavior"),
		c("skills", "List available skills", { dialog: true }),
		c(
			"status",
			"Show version, account, model, MCP servers, and setup warnings",
			{
				dialog: true,
			},
		),
		c("subtask", "Send a subagent off with your full context", {
			args: "<task>",
		}),
		c("tasks", "View and manage this session's background work", {
			dialog: true,
		}),
		c("theme", "Change the theme", { dialog: true }),
		c(
			"ultrareview",
			"Start a cloud agent that finds and verifies bugs in your branch",
		),
		c("usage", "Show session cost, plan usage, and activity stats", {
			dialog: true,
		}),
		c("workflows", "Browse running and completed workflows", { dialog: true }),
	],
};

const CODEX: BuiltinList = {
	version: "0.171.0",
	commands: [
		c("model", "Choose what model and reasoning effort to use", {
			dialog: true,
		}),
		c("permissions", "Choose what Codex is allowed to do", { dialog: true }),
		c("skills", "Use skills to improve how Codex performs specific tasks", {
			dialog: true,
		}),
		c("review", "Review my current changes and find issues"),
		c("rename", "Rename the current thread", { args: "<name>" }),
		c("new", "Start a new chat during a conversation"),
		c("resume", "Resume a saved chat", { dialog: true }),
		c("fork", "Fork the current chat"),
		c("init", "Create an AGENTS.md file with instructions for Codex"),
		c("compact", "Summarize conversation to prevent hitting the context limit"),
		c("recap", "Summarize the current conversation now"),
		c("plan", "Switch to Plan mode"),
		c("goal", "Set or view the goal for a long-running task", {
			args: "[goal]",
		}),
		c("side", "Start a side conversation", { args: "<question>" }),
		c("copy", "Copy the last response"),
		c("export", "Export the conversation as markdown"),
		c("diff", "Show git diff (including untracked files)"),
		c("mention", "Mention a file", { args: "<path>" }),
		c("status", "Show current session configuration and token usage"),
		c("cd", "Change the current working directory", { args: "<path>" }),
		c("pwd", "Show the current working directory"),
		c("usage", "View account usage"),
		c("mcp", "List MCP tools"),
		c("apps", "Manage apps", { dialog: true }),
		c("plugins", "Browse plugins", { dialog: true }),
		c("hooks", "View and manage lifecycle hooks", { dialog: true }),
		c("memories", "Configure memory use and generation", { dialog: true }),
		c("ps", "List background terminals"),
		c("clean", "Stop all background terminals"),
		c("clear", "Clear the terminal and start a new chat"),
		c("feedback", "Send logs to maintainers", { dialog: true }),
		c("logout", "Log out of Codex"),
		c("exit", "Exit Codex"),
	],
};

const OPENCODE: BuiltinList = {
	version: "2.2.5",
	commands: [
		c("agents", "Switch agent", { dialog: true }),
		c("btw", "Ask a side question", { args: "<question>" }),
		c("cd", "Change the working directory", { args: "<path>" }),
		c("clear", "Clear the screen"),
		c("compact", "Summarize the session"),
		c("copy", "Copy the last response"),
		c("diff", "Show the changes in this session"),
		c("editor", "Open the prompt in your editor", { dialog: true }),
		c("exit", "Exit OpenCode"),
		c("export", "Export the session"),
		c("fork", "Fork the session"),
		c("help", "Show help", { dialog: true }),
		c("mcps", "Show MCP servers", { dialog: true }),
		c("models", "Switch model", { dialog: true }),
		c("new", "Start a new session"),
		c("redo", "Redo the last undone message"),
		c("rename", "Rename the session", { args: "<name>" }),
		c("sessions", "Switch session", { dialog: true }),
		c("skills", "Browse skills", { dialog: true }),
		c("status", "Show status", { dialog: true }),
		c("themes", "Switch theme", { dialog: true }),
		c("undo", "Undo the last message"),
		c("usage", "Show usage"),
	],
};

const PI: BuiltinList = {
	version: "1.5.0",
	commands: [
		c("model", "Switch model", { args: "<model>", dialog: true }),
		c("thinking", "Set the thinking level", { args: "<level>", dialog: true }),
		c("new", "Start a new session"),
		c("resume", "Resume a session", { dialog: true }),
		c("name", "Name the session", { args: "<name>" }),
		c("fork", "Fork the session", { dialog: true }),
		c("compact", "Summarize the session", { args: "[instructions]" }),
		c("copy", "Copy the last response"),
		c("export", "Export the session", { args: "[file]" }),
		c("reload", "Reload extensions, prompts and skills"),
		c("session", "Show session info"),
		c("hotkeys", "Show keyboard shortcuts", { dialog: true }),
		c("settings", "Open settings", { dialog: true }),
		c("quit", "Quit pi"),
	],
};

const OMP: BuiltinList = {
	version: "19.1.0",
	commands: [
		c("plan", "Enter plan mode", { args: "[prompt]" }),
		c("vibe", "Toggle vibe mode"),
		c("goal", "Set, pause, resume or drop a goal", {
			args: "<set|pause|resume|drop>",
		}),
		c("loop", "Run a prompt in a loop", { args: "<prompt>" }),
		c("model", "Switch model", { args: "<model>", dialog: true }),
		c("effort", "Set the effort level", { args: "<level>", dialog: true }),
		c("fast", "Toggle fast mode"),
		c("new", "Start a new session"),
		c("compact", "Summarize the session", { args: "[instructions]" }),
		c("resume", "Resume a session", { dialog: true }),
		c("handoff", "Hand the work off to a new session", { args: "[note]" }),
		c("btw", "Ask a side question", { args: "<question>" }),
		c("retry", "Retry the last turn"),
		c("commit", "Commit the current changes"),
		c("todo", "Show the todo list"),
		c("skills", "Browse skills", { dialog: true }),
		c("mcp", "Manage MCP servers", { dialog: true }),
		c("session", "Show session info"),
		c("exit", "Exit omp"),
	],
};

// The reference linked by the installed CLI's antigravity-guide skill:
// https://antigravity.google/docs/cli/reference.md. Only the three read-only
// lookups below have an equivalent outside the native terminal.
const ANTIGRAVITY: BuiltinList = {
	version: "1.5.16",
	commands: [
		c("help", "List commands or look up one command", { args: "[command]" }),
		c("skills", "List installed skills matching a name", { args: "[name]" }),
		c("changelog", "Read the latest installed release notes"),
		c("add-dir", "Add a workspace folder", { terminalOnly: true }),
		c("agents", "Browse agents", { terminalOnly: true }),
		c("artifact", "Review artifacts", { terminalOnly: true }),
		c("boost", "Start a deep reasoning task", { terminalOnly: true }),
		c("browser", "Start a browser task", { terminalOnly: true }),
		c("btw", "Ask a side question", { terminalOnly: true }),
		c("clear", "Start a fresh conversation", { terminalOnly: true }),
		c("codesearch", "Search the workspace", { terminalOnly: true }),
		c("compact", "Compact the current conversation", { terminalOnly: true }),
		c("config", "Edit settings", { terminalOnly: true }),
		c("context", "Inspect context use", { terminalOnly: true }),
		c("copy", "Copy a response", { terminalOnly: true }),
		c("credits", "Check credits", { terminalOnly: true }),
		c("diff", "Review changes", { terminalOnly: true }),
		c("effort", "Set reasoning effort", { terminalOnly: true }),
		c("exit", "Close the terminal session", { terminalOnly: true }),
		c("feedback", "Send feedback", { terminalOnly: true }),
		c("fork", "Fork the current conversation", { terminalOnly: true }),
		c("goal", "Set a goal", { terminalOnly: true }),
		c("grill-me", "Clarify requirements", { terminalOnly: true }),
		c("hooks", "Browse hooks", { terminalOnly: true }),
		c("keybindings", "Edit keyboard shortcuts", { terminalOnly: true }),
		c("learn", "Propose a rule or skill", { terminalOnly: true }),
		c("logout", "Sign out of Antigravity", { terminalOnly: true }),
		c("mcp", "Manage MCP servers", { terminalOnly: true }),
		c("model", "Select a model", { terminalOnly: true }),
		c("open", "Open a file in the editor", { terminalOnly: true }),
		c("permissions", "Review permissions", { terminalOnly: true }),
		c("plan", "Start planning", { terminalOnly: true }),
		c("plugin", "Manage plugins", { terminalOnly: true }),
		c("rename", "Rename this conversation", { terminalOnly: true }),
		c("remote-control", "Configure remote control", { terminalOnly: true }),
		c("resume", "Select a conversation", { terminalOnly: true }),
		c("rewind", "Rewind the conversation", { terminalOnly: true }),
		c("schedule", "Schedule a task", { terminalOnly: true }),
		c("statusline", "Configure the status bar", { terminalOnly: true }),
		c("tasks", "Inspect background tasks", { terminalOnly: true }),
		c("teamwork", "Start a team task", { terminalOnly: true }),
		c("title", "Configure the window title", { terminalOnly: true }),
		c("usage", "Show quota usage", { terminalOnly: true }),
		c("voice", "Configure voice input", { terminalOnly: true }),
	],
};

const BUILTINS: Record<string, BuiltinList> = {
	antigravity: ANTIGRAVITY,
	claude: CLAUDE,
	codex: CODEX,
	opencode: OPENCODE,
	pi: PI,
	omp: OMP,
};

/** Dotted numeric versions, compared part by part (`2.1.330` < `2.1.331`); null when either is unreadable. */
export function compareVersions(a: string, b: string): number | null {
	const parse = (v: string) => {
		const m = /(\d+(?:\.\d+)*)/.exec(v);
		return m ? m[1]!.split(".").map(Number) : null;
	};
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return null;
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d) return Math.sign(d);
	}
	return 0;
}

export interface Builtins {
	commands: BuiltinCommand[];
	/** The version the list was read from. */
	listVersion: string;
	/** True when the installed CLI is newer than the list: it may miss commands. */
	stale: boolean;
}

/** The built-in commands for a harness; null for a harness with no list. */
export function builtinsFor(
	harness: string,
	installed: string | null,
): Builtins | null {
	const list = BUILTINS[harness];
	if (!list) return null;
	const cmp = installed ? compareVersions(installed, list.version) : null;
	return {
		commands: list.commands,
		listVersion: list.version,
		stale: cmp !== null && cmp > 0,
	};
}

/** Harnesses with a built-in list. */
export const BUILTIN_HARNESSES = Object.keys(BUILTINS);
