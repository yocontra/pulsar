/**
 * Native slash commands for the composer. Managed ACP sessions use the catalog
 * supplied by the provider. Native fallbacks cover the public terminal commands
 * for the recorded version. Runtime flags, plugins and skills can add commands.
 *
 * Sources include Claude Code's terminal menu, Codex's release-tagged
 * slash_command.rs and bottom_pane/slash_commands.rs, OpenCode's slash
 * registrations, pi's docs/slash-commands.md and OMP's builtin registry.
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
	version: "2.1.331",
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
		c("auto-mode-setup", "Teach auto mode about your environment"),
		c("bug", "Report a bug or share your session", { dialog: true }),
		c("claude-api", "Build or debug an app that uses the Claude API"),
		c("dataviz", "Get chart and dashboard design guidance"),
		c("deep-research", "Research a question and verify sources", {
			args: "<question>",
		}),
		c("list-agents", "List subagents, teammates and other Claude sessions"),
		c("login", "Switch Anthropic accounts", { dialog: true }),
		c("logout", "Sign out of your Anthropic account", { terminalOnly: true }),
		c("mobile", "Show the mobile app download code", { dialog: true }),
		c("plugin-authoring", "Write a Claude Code modification"),
		c("powerup", "Learn Claude Code features in short lessons"),
		c("radio", "Listen to Claude FM", { terminalOnly: true }),
		c("run", "Launch the current project"),
		c("run-skill-generator", "Create a skill for running the current project"),
		c("sandbox", "Configure sandbox settings", { dialog: true }),
		c("scroll-speed", "Adjust mouse wheel scroll speed", { dialog: true }),
		c("statusline", "Set up the status line"),
		c("stickers", "Check Claude Code sticker availability"),
		c("team-onboarding", "Create a Claude Code guide for teammates"),
		c("terminal-setup", "Set up Shift+Enter for newlines", {
			terminalOnly: true,
		}),
		c("tui", "Select the terminal renderer", {
			args: "<classic|fullscreen>",
			dialog: true,
		}),
		c("update-config", "Change hooks, permissions or environment settings"),
		c("verify", "Try a change and report whether it works"),
		c("workflow-authoring", "Load the reference for writing workflow scripts"),
	],
};

const CODEX: BuiltinList = {
	version: "0.172.0",
	commands: [
		c("model", "Choose a model and reasoning effort", {
			args: "[model]",
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
		c("stop", "Stop all background terminals"),
		c("clear", "Clear the terminal and start a new chat"),
		c("feedback", "Send logs to maintainers", { dialog: true }),
		c("logout", "Log out of Codex"),
		c("exit", "Exit Codex"),
		c("presets", "Manage saved prompts and commands", { dialog: true }),
		c("ide", "Manage context from the connected IDE", {
			args: "[setting]",
			dialog: true,
		}),
		c("keymap", "Configure terminal keybindings", {
			args: "[shortcut]",
			dialog: true,
		}),
		c("vim", "Toggle Vim editing for the prompt"),
		c("experimental", "Choose experimental features", { dialog: true }),
		c("approve", "Review a request to retry a denied action", { dialog: true }),
		c("import", "Import Claude Code setup, project settings or chats", {
			dialog: true,
		}),
		c("archive", "Archive the current session"),
		c("delete", "Delete the current session permanently", { dialog: true }),
		c("config", "Open Codex settings", { dialog: true }),
		c("agents", "Open the agent command center", { dialog: true }),
		c("subagents", "Switch between the current thread\u2019s subagents", {
			dialog: true,
		}),
		c("raw", "Toggle copy-friendly terminal scrollback", { args: "[on|off]" }),
		c("tui", "Select the terminal interface for the next launch", {
			dialog: true,
		}),
		c("daemon", "Manage the local background service", { dialog: true }),
		c("rc", "Configure remote control", { args: "[on|off]", dialog: true }),
		c("warnings", "Inspect retained warnings and diagnostic details"),
		c("title", "Choose the fields in the terminal title", {
			args: "[items]",
			dialog: true,
		}),
		c("statusline", "Choose the fields in the status line", {
			args: "[items]",
			dialog: true,
		}),
		c("theme", "Choose a syntax highlighting theme", { dialog: true }),
		c("pets", "Choose or hide the terminal pet", {
			args: "[name]",
			dialog: true,
		}),
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
	version: "19.1.1",
	commands: [
		c("plan", "Enter plan mode", { args: "[prompt]" }),
		c("vibe", "Toggle vibe mode"),
		c("goal", "Set, pause, resume or drop a goal", {
			args: "<set|pause|resume|drop>",
		}),
		c("loop", "Run a prompt in a loop", { args: "<prompt>" }),
		c("model", "Open the model picker", { dialog: true }),
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
		c("skills", "Search, install or update registry skills", {
			args: "<search|install|installed|update>",
		}),
		c("mcp", "Manage MCP servers", { dialog: true }),
		c("session", "Show session info"),
		c("exit", "Exit omp"),
		c("security", "Manage OMP security scans", {
			args: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
		}),
		c("settings", "Open OMP settings", { dialog: true }),
		c("setup", "Configure model providers", { dialog: true }),
		c("plan-review", "Review the latest plan", { dialog: true }),
		c("guided-goal", "Define a goal through an interview", {
			args: "[rough objective]",
		}),
		c("queue", "Queue a message for after this turn", { args: "<message>" }),
		c("switch", "Select the model for this session", { args: "[model]" }),
		c("slow", "Configure slow mode", { args: "[on|off|status]" }),
		c("skillful", "Toggle installed skills in the system prompt", {
			args: "[on|off|status]",
		}),
		c("extended-context", "Toggle extended context windows", {
			args: "[on|off|status]",
		}),
		c("computer", "Configure native computer use", { args: "[on|off|status]" }),
		c("ratchet", "Evaluate and improve a model workflow", {
			args: "[flow and goal]",
		}),
		c("prewalk", "Configure a one-time model handoff", {
			args: "[into] | restart [from] [into] | off",
		}),
		c("modelpreset", "Manage saved model and effort presets", {
			args: "[save|switch|delete|list] [name]",
		}),
		c("advisor", "Manage the second model that reviews turns", {
			args: "[on|off|status|dump [raw]|configure]",
		}),
		c("export", "Export the session as HTML", { args: "[--themes] [path]" }),
		c("trace", "Open the session trace in the stats dashboard"),
		c("dump", "Copy the transcript and export request details", {
			args: "[all|anon]",
		}),
		c("share", "Create an encrypted link to this session"),
		c("collab", "Share a live session through a relay", {
			args: "[start|view|list|stop|status] [relayUrl]",
		}),
		c("join", "Join a shared session", { args: "<link>" }),
		c("leave", "Leave the shared session"),
		c("browser", "Choose a visible or headless browser", {
			args: "[headless|visible]",
		}),
		c("copy", "Copy selected conversation text or code", { dialog: true }),
		c("open", "Open a conversation link in the browser"),
		c("jobs", "Show background job status", {
			args: "[full|kill <id>|kill all]",
		}),
		c("usage", "Show provider usage and limits", {
			args: "[show|reset [provider/credential-id|provider/active]]",
		}),
		c("stats", "Open the local statistics dashboard", {
			args: "[--port <port>] [--host <host>]",
		}),
		c("changelog", "Show release notes", { args: "[full|last [N]]" }),
		c("hotkeys", "Show keyboard shortcuts", { dialog: true }),
		c("tools", "List tools available to the agent"),
		c("context", "Inspect the current context", { dialog: true }),
		c("extensions", "Open extension controls", { dialog: true }),
		c("agents", "Configure agents and their models", { dialog: true }),
		c("git", "Open the Git diff and staging interface", {
			args: "[revision]",
			dialog: true,
		}),
		c("local", "Open a session file in the editor", {
			args: "[name]",
			dialog: true,
		}),
		c("hub", "Inspect running and finished subagents", { dialog: true }),
		c("branch", "Return to an earlier message and keep the old branch", {
			dialog: true,
		}),
		c("fork", "Fork this session"),
		c("tree", "Switch between session branches", { dialog: true }),
		c("login", "Sign in to a provider", {
			args: "[provider|redirect URL]",
			dialog: true,
		}),
		c("logout", "Sign out of a provider", { args: "[provider]", dialog: true }),
		c("ssh", "Manage SSH hosts", { args: "<subcommand>" }),
		c("fresh", "Reset the provider stream and keep the transcript"),
		c("clear", "Clear the current conversation context"),
		c("delete", "Delete this session and open a new one"),
		c("shake", "Remove large tool results from context", {
			args: "[elide|images|thinking]",
		}),
		c("pin", "Pin a session in the resume list", { args: "[session id]" }),
		c("unpin", "Remove a session pin", { args: "[session id]" }),
		c("tan", "Start a background agent on a related task", { args: "<work>" }),
		c("omfg", "Create a rule to prevent a recurring problem", {
			args: "<complaint>",
		}),
		c("cleanse", "Check and repair project diagnostics", {
			args: "[request] [--all]",
		}),
		c("debug", "Open the debugging tools", { dialog: true }),
		c("memory", "Inspect and maintain memory", { args: "<subcommand>" }),
		c("rename", "Rename the current session", { args: "[title]" }),
		c("move", "Move this session to a directory", { args: "[<path>]" }),
		c("wt", "Move the session and its changes to a new worktree", {
			args: "[<branch>]",
		}),
		c("add-dir", "Add a directory to this workspace", { args: "<path>" }),
		c("remove-dir", "Remove a directory from this workspace", {
			args: "<path>",
		}),
		c("dirs", "List workspace directories"),
		c("restart", "Restart and resume the current session"),
		c("marketplace", "Manage plugin sources and installations", {
			args: "<subcommand>",
		}),
		c("plugins", "Manage installed plugins", { args: "[list|enable|disable]" }),
		c("reload-plugins", "Reload plugin commands, hooks and tools"),
		c("force", "Select a tool for the next turn", {
			args: "<tool-name> [prompt]",
		}),
		c("live", "Start real-time voice mode"),
		c("record", "Start or stop recording this terminal session"),
		c("pause", "Pause the session and its subagents"),
		c("forget-approvals", "Clear remembered file and folder permissions"),
	],
};

// The installed CLI links to this reference. Its bundled skills (including
// swarm and antigravity-guide) come from the on-disk skill catalog:
// https://antigravity.google/docs/cli/reference.md. Only the three read-only
// lookups below have an equivalent outside the native terminal.
const ANTIGRAVITY: BuiltinList = {
	version: "1.5.18",
	commands: [
		c("help", "List commands or look up one command", { args: "[command]" }),
		c("skills", "List installed skills matching a name", { args: "[name]" }),
		c("changelog", "Read the latest installed release notes"),
		c("add-dir", "Add a workspace folder", {
			args: "<path>",
			terminalOnly: true,
		}),
		c("agents", "Browse agents", { terminalOnly: true }),
		c("artifact", "Review artifacts", { terminalOnly: true }),
		c("boost", "Start a deep reasoning task", {
			args: "<task>",
			terminalOnly: true,
		}),
		c("browser", "Start a browser task", {
			args: "<task>",
			terminalOnly: true,
		}),
		c("btw", "Ask a side question", { args: "<query>", terminalOnly: true }),
		c("clear", "Start a fresh conversation", { terminalOnly: true }),
		c("codesearch", "Search the workspace", {
			args: "<query>",
			terminalOnly: true,
		}),
		c("compact", "Compact the current conversation", {
			args: "[message]",
			terminalOnly: true,
		}),
		c("config", "Edit settings", { terminalOnly: true }),
		c("context", "Inspect context use", { terminalOnly: true }),
		c("copy", "Copy a response", { args: "[n|btw]", terminalOnly: true }),
		c("credits", "Check credits", { terminalOnly: true }),
		c("diff", "Review changes", { terminalOnly: true }),
		c("effort", "Set reasoning effort", {
			args: "[level]",
			terminalOnly: true,
		}),
		c("exit", "Close the terminal session", { terminalOnly: true }),
		c("feedback", "Send feedback", { terminalOnly: true }),
		c("fork", "Fork the current conversation", { terminalOnly: true }),
		c("goal", "Set a goal", { args: "<objective>", terminalOnly: true }),
		c("grill-me", "Clarify requirements", {
			args: "[task]",
			terminalOnly: true,
		}),
		c("hooks", "Browse hooks", { terminalOnly: true }),
		c("keybindings", "Edit keyboard shortcuts", { terminalOnly: true }),
		c("learn", "Propose a rule or skill", {
			args: "[instruction]",
			terminalOnly: true,
		}),
		c("logout", "Sign out of Antigravity", { terminalOnly: true }),
		c("mcp", "Manage MCP servers", { terminalOnly: true }),
		c("model", "Select a model", {
			args: "[model] [prompt]",
			terminalOnly: true,
		}),
		c("open", "Open a file in the editor", {
			args: "<path>",
			terminalOnly: true,
		}),
		c("permissions", "Review permissions", { terminalOnly: true }),
		c("plan", "Start planning", { args: "[task]", terminalOnly: true }),
		c("plugin", "Manage plugins", { terminalOnly: true }),
		c("rename", "Rename this conversation", {
			args: "<name>",
			terminalOnly: true,
		}),
		c("remote-control", "Configure remote control", {
			args: "[on|off]",
			terminalOnly: true,
		}),
		c("resume", "Select a conversation", { terminalOnly: true }),
		c("rewind", "Rewind the conversation", { terminalOnly: true }),
		c("schedule", "Schedule a task", {
			args: "<when> <task>",
			terminalOnly: true,
		}),
		c("statusline", "Configure the status bar", { terminalOnly: true }),
		c("tasks", "Inspect background tasks", { terminalOnly: true }),
		c("teamwork", "Start a team task", { args: "<task>", terminalOnly: true }),
		c("title", "Configure the window title", {
			args: "[on|off]",
			terminalOnly: true,
		}),
		c("usage", "Show quota usage", { terminalOnly: true }),
		c("voice", "Configure voice input", {
			args: "[live|dictate]",
			terminalOnly: true,
		}),
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
