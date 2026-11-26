# Harness support

How Pulsar names agents, how messages reach each harness, what the app can do in each harness, and what each harness can't do.

## Names

An agent's name is the first of these that exists:

1. A name the agent chose: `set_identity name=…` or `PULSAR_NAME`. It stays across daemon restarts.
2. The name the harness gives the session: a rename (`/rename`, `/name`) or a title the harness generated. Pulsar follows it as it changes.
3. `<harness>@<project>`.

A harness name becomes a slug (`Recover TODO and audit game` → `recover-todo-and-audit-game`), cut to 40 characters at a word boundary. Placeholders such as OpenCode's `New session - <date>` are not names. Two agents with the same name get `-2`, `-3`. `operator`, `user`, `human` and `system` are reserved.

A rename keeps the agent id. For 15 minutes, `send`, `ask` and `wait idle:` with the old name still reach the agent on this machine. Other machines see the new name at once.

`PULSAR_HARNESS`, `PULSAR_SESSION_ID`, `PULSAR_NAME` and `PULSAR_TAGS` override detection.

## PR tags

Every minute Pulsar tags each agent with the PR it works on, with no network and no `gh`:

1. A local PR ref that points at the agent's commit (`refs/pull/<n>/head`, or `refs/remotes/<remote>/pr/<n>` after `git config --add remote.origin.fetch '+refs/pull/*/head:refs/remotes/origin/pr/*'` and a fetch).
2. Otherwise, the last PR of the agent's repo named in its session log, such as `gh pr create` output.

Pulsar replaces only the `pr:` tag it added. A `pr:` tag the agent set itself stays.

## Per harness

| Harness | How a message arrives | Busy / idle |
| --- | --- | --- |
| Claude Code | Claude's per-session inbox. `urgent` lands between tool calls; `normal` after the turn, and it wakes an idle session | Yes |
| Codex | `codex queue --resume`: queued on the thread, then run as a turn | Yes, from turn events in the session log |
| OpenCode | OpenCode's local server, into the session | Yes |
| pi, omp | The Pulsar extension, inside the session | Yes |
| Cursor, Gemini CLI, others | Pull only: messages wait in the inbox, and every Pulsar tool result says how many are unread | No |

A native Antigravity CLI session can expose its user messages and assistant replies from its local conversation database. Pulsar matches the database to the running `agy` process. Managed Antigravity sessions stream their transcript over [ACP](acp.md).

When an omp agent has no activity summary, Pulsar uses the latest action from its session log, such as “Ran a command.” The list omits command arguments and message content.

Limits:

- **Claude Code** holds a peer message for approval when the session skips permission prompts. `pulsar setup` asks to set `crossSessionInbound: "accept"` in `~/.claude/settings.json` to deliver these. When the session shows a dialog in the terminal, the app shows the agent as needing you.
- **Codex** approvals and questions can be answered from the app for sessions that run in Codex's app-server (the default). A session started with `codex --no-daemon` shows them read-only. "Allow for session" is not offered. Pulsar reads turn start, completion and interruption from the Codex session log. An idle wait needs an identifiable thread and a readable log. A Codex TUI that is not attached to Codex's app-server may not show a message until you resume it. Setup sets `default_tools_approval_mode = "approve"` for Pulsar's tools and `tool_timeout_sec = 1900`, so `ask` and `wait` can block.
- **OpenCode**: an idle TUI with no running session shows its folder's most recent session as "Idle · last session". Pulsar does not push into it until that session loads Pulsar's tools. If the daemon finds an `opencode` older than 2.0 first on its PATH, `pulsar doctor` says so.
- **pi, omp**: the only harnesses where a receipt reaches "in its conversation".

See [delivery.md](delivery.md) for receipts and redelivery.

### Native harness smoke checks

These checks used separate workspaces and Pulsar state directories on macOS. The child messaging checks used a local model fixture to exercise the installed harness and Pulsar together.

| Installed harness | Verified result |
| --- | --- |
| Claude Code 2.1.331 | A child received a message through a tool hook, replied as itself, and updated its identity. Its parent kept its original identity. |
| Codex CLI 0.172.0 | Codex stopped at thread creation because it could not synchronize managed preferences. The native reply and idle wait could not run in this environment. |
| OpenCode 2.2.5 | A native child listed agents, received a direct message through the OpenCode service, and replied from its own child address. Pulsar also found a nested child through the native session API. |
| pi 1.5.0 | The native RPC process answered its state request. The configured model request was rate-limited before a Pulsar reply. |
| omp 19.1.1 | Two native children discovered one another. Pulsar delivered a message to the first child, which sent to its sibling and received the reply. |

## Prompts in the app

| Harness | Relayed |
| --- | --- |
| Claude Code | Permission prompts, AskUserQuestion, plan approval (ExitPlanMode) |
| OpenCode | Permission prompts, the `question` tool |
| omp | `ask` forms, tool approvals, plan review, extension dialogs |
| pi | Extension dialogs (select, confirm, input) |
| Codex | Shown read-only; answer in the terminal |

MCP elicitation forms, Codex's "Implement this plan?" and pi `custom()` dialogs are not relayed. An unanswered card ends after 9 minutes for a permission prompt and 59 minutes for a question or plan; the terminal prompt stays. `pulsar setup --no-approvals` keeps Claude Code prompts out of the app.

## Stop

Stop interrupts an agent's current turn; the session keeps running. Use the app (Cmd-.) or `pulsar interrupt <agent>`. The app hides Stop when it can't reach the agent.

| Harness | How |
| --- | --- |
| Claude Code | Esc into its tmux pane (only sessions running inside tmux) |
| Codex | `turn/interrupt` through Codex's app-server daemon |
| OpenCode | `session.interrupt` on the OpenCode service (not a `--standalone` TUI) |
| pi, omp | The Pulsar extension aborts the run |
| Cursor, Gemini CLI | Not supported |

## Modes and slash commands

The app can switch an agent's mode and run slash commands and skills in its session (type `/` in the composer). Both need Prove Human. A command never travels as a message: Pulsar types it into the agent's terminal or calls the harness's API, once. When Pulsar types into a terminal, it first reads the screen. It stops if it sees a dialog, a menu, or text that someone has not sent yet.

| Harness | Modes | How the mode changes | How commands run |
| --- | --- | --- | --- |
| Claude Code | Manual, Accept edits, Plan, Auto, Bypass permissions | Shift+Tab in its tmux pane, one press at a time, footer read back | Typed into its tmux pane |
| Codex | Default, Plan | Shift+Tab in its tmux pane (the TUI applies its own effort per mode); else `thread/settings/update` on Codex's app-server daemon with the same per-mode effort (the TUI follows) | Typed into its tmux pane (skills as `$name`) |
| OpenCode | Build, Plan | Shift+Tab in its pane (only an agent Pulsar started in tmux: OpenCode reports no pid); else the service's `/agent` API (the terminal may not follow) | Server commands and skills through the service; the TUI's own commands typed into its pane |
| pi | None | — | The Pulsar extension (extension commands, prompt templates, `/skill:name`), when idle |
| omp | Default, Plan | The Pulsar extension (`sessionModes`) | Not supported (omp runs commands only when typed) |
| Cursor, Gemini CLI | Not supported | — | — |

Pulsar types only into the agent's own pane: the pane's process must be up the agent's process tree with no other agent between them, so a session started inside another agent's tool call is never typed into. The phone's one-tap Run is offered only for commands that take nothing and keep the session (not `/exit`, `/clear`, `/restart` and the like).

Built-in commands in the `/` menu come from a list kept per CLI version (src/harnesses/builtins.ts). `pulsar doctor` says when the installed CLI is newer than the list. Custom commands and skills are read from where each harness keeps them.

## Setup options

`pulsar setup` copies Pulsar to `~/.local/share/pulsar/<version>-<build hash>` and puts a `pulsar` command in `~/.local/bin`. It also sets Claude Code's `crossSessionInbound` and Codex's tool approval, which plugin installs can't.

| Flag | Does |
| --- | --- |
| `--yes --all-detected` | No questions (scripts, dotfiles) |
| `--client claude,codex` | Only these harnesses (`--client none`: only the `pulsar` command, e.g. on a server) |
| `--dry-run` | Show the plan, change nothing |
| `--no-approvals` | Don't relay Claude Code prompts to the app |
| `--mesh` | Turn the agent mesh on without asking; takes the `pulsar mesh on` options (`--cert`, `--key`, `--ca`, `--rp-id`, `--prove`) |
| `--uninstall` | Undo everything setup did |

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `PULSAR_HOME` | `~/.local/state/pulsar` | State folder: socket, message log, certificate |
| `PULSAR_HTTP_PORT` | `7337` | Port of the app and the mesh |
| `PULSAR_NAME` | detected | Name this agent registers under |
| `PULSAR_TAGS` | none | Extra tags for this agent |
| `PULSAR_NO_MESH` | unset | `pulsar mesh on` refuses to run (tests, sandboxes) |
| `PULSAR_NO_SEARCH` | unset | No message search: the daemon keeps no copy of transcript text and deletes the copy it has |
| `PULSAR_DEBUG` | unset | Log the MCP server to `mcp-debug.log` |
