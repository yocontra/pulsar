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

| Session | Send now during a turn | Next turn |
| --- | --- | --- |
| Native Claude Code | The session inbox accepts urgent input between tool calls. | The inbox delivers after the current turn and can wake an idle session. |
| Native Codex | Pulsar sends `turn/steer` to the active turn on the exact thread. The app server returns the turn ID. Direct child input also requires the child to permit it. | The native queue can resume a parent thread. A loaded child uses its own queue. If a turn ends before a steer, Pulsar uses the native queue. |
| Native OpenCode | Pulsar sends a steering prompt to the confirmed session on the local OpenCode service. | A queued prompt can resume that session. |
| Native pi and omp | The connected Pulsar extension requests steering. The harness applies the input at its next opportunity. | The extension submits a follow-up. |
| Managed Claude Agent ACP and Codex ACP | An adapter that advertises steering can accept input into the running prompt. Pulsar requires Claude Agent ACP 0.110.0 or later, or Codex ACP 2.12.0 or later. | The bridge runs one prompt at a time. If the turn ends before steering, the bridge starts a new prompt. |
| Other managed ACP sessions, including Antigravity | The bridge waits for the current prompt to finish. | Starts a prompt on the same session. |
| Native Antigravity CLI | The session hook delivers urgent input before the next model call. A native host relay accepts input on the schedule set by Antigravity. | The hook delivers normal input at the start of the next turn. A verified host relay or an idle native CLI with its own tmux pane can wake the conversation. |
| MCP connection only | The agent reads its inbox or receives a message during an active Pulsar wait. | Waits in the inbox. |

**Don't wake** keeps the message in the inbox across all harnesses. A session can read it through Pulsar.

Pulsar setup installs the Antigravity session hooks. An open CLI session picks them up on its next model call. When Antigravity supplies a native host connection, Pulsar connects delivery to the matching conversation automatically. Check its current reach in `pulsar list`. Pulsar reads the native transcript from the conversation database. Managed Antigravity sessions stream their transcript over [ACP](acp.md).

Native Antigravity child conversations appear under their parent when Antigravity records that relationship. Open a child to read its transcript or message it directly. With the native hooks installed, urgent messages reach the child before its next model call. Normal messages wait for its next turn. A connected native wake relay can deliver to an idle child. Children can use Pulsar tools to contact their parent or siblings under their own conversation IDs. [Antigravity hooks](https://antigravity.google/docs/hooks#antigravity-cli)

On your phone, open **+ → Skills & Commands**, or type `/` in the message box. In a native Antigravity session, `/skills <name>` searches installed skills and `/help <name>` searches commands. Select a skill, add your request, and send it. A session with hooks receives queued requests when its next turn starts. A session with a native relay or a verified tmux pane can wake immediately. Commands that require an unavailable terminal are marked in the picker. [Antigravity CLI commands](https://antigravity.google/docs/cli/reference)

When an omp or Antigravity agent has no activity summary, Pulsar uses the latest action from its session log, such as “Ran a command.” The list omits command arguments and message content.

Limits:

- **Claude Code** holds a peer message for approval when the session skips permission prompts. `pulsar setup` asks to set `crossSessionInbound: "accept"` in `~/.claude/settings.json` to deliver these. When the session shows a dialog in the terminal, the app shows the agent as needing you.
- **Codex** approvals and questions can be answered from the app for sessions that run in Codex's app-server (the default). A session started with `codex --no-daemon` shows them read-only. "Allow for session" is not offered. Pulsar reads turn start, completion and interruption from the Codex session log. An idle wait needs an identifiable thread and a readable log. A Codex TUI that is not attached to Codex's app-server may not show a message until you resume it. Setup sets `default_tools_approval_mode = "approve"` for Pulsar's tools and `tool_timeout_sec = 1900`, so `ask` and `wait` can block.
- **OpenCode**: an idle TUI with no running session shows its folder's most recent session as "Idle · last session". Pulsar does not push into it until that session loads Pulsar's tools. If the daemon finds an `opencode` older than 2.0 first on its PATH, `pulsar doctor` says so.
- **pi, omp and managed ACP sessions** confirm when a message reaches the conversation. Native Claude Code, Codex and OpenCode confirm handoff to the harness. A handoff does not tell you when the agent acted on the message.

See [delivery.md](delivery.md) for receipts and redelivery.

### Harness smoke checks

These checks used disposable sessions on macOS. The Codex steering check used the installed app server and a local model fixture.

| Installed harness | Verified result |
| --- | --- |
| Claude Code 2.1.331 | A child received a message through a tool hook, replied as itself, and updated its identity. Its parent kept its original identity. |
| Codex CLI 0.172.0 | The installed app server accepted urgent input during a turn. The local model received it on the original thread, with one turn ID throughout. Starting an already queued submission during that turn was refused. Stop interrupted the turn and the session became idle. |
| OpenCode 2.2.5 | Pulsar reopened saved native parent and child sessions separately and displayed their messages, tool calls, and results. |
| OpenCode 2.2.5 | A native child listed agents, received a direct message through the OpenCode service, and replied from its own child address. Pulsar also found a nested child through the native session API. In two disposable service sessions, the model received urgent input after a tool result within the active turn, and normal input only after the assistant finished its turn. |
| pi 1.5.0 | The local model received urgent input during the active turn and normal input after idle. Pulsar confirmed both deliveries. |
| omp 19.1.1 | The local model received urgent input during the active turn and normal input after idle. A running child received urgent input, messaged its sibling, and received the reply. |

Extension host tests verified the steering and follow-up requests for pi and omp, including delivery acknowledgements for an omp child. The omp host tests also checked child Stop and discovery of commands and modes.

| Managed ACP adapter | Steering qualification |
| --- | --- |
| Claude Agent ACP 0.110.0 | The installed adapter accepted input during a held prompt. A local model fixture received the input in that turn. |
| Codex ACP 2.12.0 | The installed adapter advertised steering. The adapter failed to synchronize managed preferences on the test Mac before a prompt could start. The bridge tests cover active-turn acknowledgement and fallback when the turn ends. |
| OpenCode 2.2.5 and Antigravity CLI 1.5.16 | Neither advertised ACP steering. Urgent input waits for the next managed prompt. |

## Prompts in the app

| Harness | Relayed |
| --- | --- |
| Claude Code | Permission prompts, AskUserQuestion, plan approval (ExitPlanMode) |
| OpenCode | Permission prompts, the `question` tool |
| omp | `ask` forms, tool approvals, plan review, extension dialogs |
| pi | Extension dialogs (select, confirm, input) |
| Codex | Approvals and questions on the app server. Embedded sessions show read-only cards. |
| Native Antigravity 1.5.18 | Answer permission prompts and questions in the terminal. The native hooks run before the dialog opens and after it closes. |
| Managed ACP | Permission requests and supported question forms from the connected provider, including child requests with a session ID. |

MCP elicitation forms, Codex's "Implement this plan?" and pi `custom()` dialogs are not relayed. An unanswered card ends after 9 minutes for a permission prompt and 59 minutes for a question or plan; the terminal prompt stays. `pulsar setup --no-approvals` keeps Claude Code prompts out of the app.

## Stop

Stop interrupts an agent's current turn; the session keeps running. Use the app (Cmd-.) or `pulsar interrupt <agent>`. The app hides Stop when it can't reach the agent.

| Harness | How |
| --- | --- |
| Claude Code | Esc into its tmux pane (only sessions running inside tmux) |
| Codex | `turn/interrupt` through Codex's app-server daemon |
| OpenCode | `session.interrupt` on the OpenCode service (not a `--standalone` TUI) |
| pi, omp | The Pulsar extension aborts the run |
| Managed ACP sessions | The bridge sends `session/cancel` for the active prompt. |
| Native Antigravity | Esc when the confirmed session owns the tmux pane and its empty composer shows a running turn. |
| Other native sessions | No Stop control. |

For child agents, Pulsar enables Stop on a connected omp child that supports it, or on a verified Codex or OpenCode child session. A Claude tool hook can deliver a child message but cannot stop that child independently.

## Modes and slash commands

The app can switch an agent's mode and run slash commands and skills in its session (type `/` in the composer). Both need Prove Human. A command never travels as a message: Pulsar types it into the agent's terminal or calls the harness's API, once. When Pulsar types into a terminal, it first reads the screen. It stops if it sees a dialog, a menu, or text that someone has not sent yet.

| Harness | Modes | How the mode changes | How commands run |
| --- | --- | --- | --- |
| Claude Code | Manual, Accept edits, Plan, Auto, Bypass permissions | Shift+Tab in its tmux pane, one press at a time, footer read back | Typed into its tmux pane |
| Codex | Default, Plan | Shift+Tab in its tmux pane (the TUI applies its own effort per mode); else `thread/settings/update` on Codex's app-server daemon with the same per-mode effort (the TUI follows) | Typed into its tmux pane (skills as `$name`) |
| OpenCode | Build, Plan | Shift+Tab in its pane (only an agent Pulsar started in tmux: OpenCode reports no pid); else the service's `/agent` API (the terminal may not follow) | Server commands and skills through the service; the TUI's own commands typed into its pane |
| pi | None | — | The extension runs custom commands, templates, and skills. Built-ins use the idle terminal pane. |
| omp | Default, Plan | The Pulsar extension (`sessionModes`) | Commands and skills use the idle terminal pane. The extension can invoke installed skills for headless sessions. |
| Antigravity | Default, Accept edits, Plan | Shift+Tab in the exact native session’s idle tmux pane | Built-ins use the owned terminal. Help, changelog, and installed skills also work through Pulsar. |
| Other native sessions | Not supported | — | — |

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

## Session links and saved conversations

A local or pool session link can open the conversation’s transcript after the process exits or Pulsar restarts. Pulsar saves supported conversations when you open them, when the process closes or switches sessions, and when its daemon shuts down. Search by name, project, or harness on desktop or phone to reopen a saved conversation on this machine or a reachable pool machine that supports saved conversation search. The live agent list still shows current sessions. An older native session link can also work when Pulsar finds the matching ID in the provider’s local history.

A saved conversation shows **Session closed**. Another terminal in the same project can have a different conversation open. Pulsar links to open sessions in the same project. **Resume session** opens the saved ID in its original workspace. Managed ACP providers must report resume or load support. For a native session, Pulsar uses the harness that created it.

| Native harness | How Pulsar reopens a saved session |
| --- | --- |
| Antigravity | Opens the verified conversation ID with `agy --conversation`. |
| Claude Code | Checks the session ID and workspace in the Claude transcript, then runs `claude --resume <uuid>`. |
| Codex | Checks the rollout for the saved parent thread, then runs `codex resume <uuid>`. |
| OpenCode | Looks up the parent session in the OpenCode database, then runs `opencode --session <id>`. Pulsar can confirm an idle TUI when its requested ID matches the workspace’s sole open tab and a single TUI owns that workspace. |
| pi and OMP | Checks the full session ID in the journal header and passes that file’s absolute path to `--session` in the same harness. |

Disposable terminal tests confirmed the previous conversation and its next model turn in Claude Code 2.1.331, OpenCode 2.2.5, pi 1.5.0 and OMP 19.1.1. On Linux, a passkey-authorized launch confirmed the saved Codex 0.172.0 thread before input and continued it with its original history. Desktop and iPhone-sized Chromium checks also reopened the selected conversation in Claude Code, OpenCode, pi and OMP. Each check included a second saved conversation in the same workspace.

### Comparison with T3 Code

| Area | What T3 Code does | How Pulsar handles it |
| --- | --- | --- |
| Session identity | Stores a thread-to-provider-session binding in SQLite and checks the session ID on resume. [Bindings](https://github.com/pingdotgg/t3code/blob/37d3d199/apps/server/src/persistence/Migrations/OrchestrationV2/ProviderSessionBindings.ts) · [Antigravity adapter](https://github.com/pingdotgg/t3code/blob/37d3d199/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts) | A saved transcript reference survives loss of live presence. Pulsar reads the original provider transcript and checks native Antigravity databases by conversation ID. |
| Questions | Translates ACP elicitation forms and Antigravity’s older question requests into user input. [ACP forms](https://github.com/pingdotgg/t3code/blob/37d3d199/packages/provider-acp/src/server/elicitationForm.ts) · [Antigravity protocol](https://github.com/pingdotgg/t3code/blob/37d3d199/apps/server/src/provider/acp/AntigravityProtocol.ts) | Managed providers can ask supported structured questions in the app. The answer goes to the requesting ACP session. |
| Background replies | Antigravity can send updates after the prompt returns. [Antigravity adapter](https://github.com/pingdotgg/t3code/blob/37d3d199/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts) | Pulsar retains late replies, tool results and questions for the same session. Stop cancels an outstanding background reply. |
| OpenCode delivery | Tracks the individual inbox submission when steering a turn. [OpenCode adapter](https://github.com/pingdotgg/t3code/blob/37d3d199/packages/provider-opencode/src/server/v2/adapter.ts) | The native driver checks the returned message ID, session ID and role. If the connection drops after submission, Pulsar reports uncertainty and prevents a second submission. |
| Codex steering | Addresses the expected active turn. [Codex adapter](https://github.com/pingdotgg/t3code/blob/37d3d199/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts) | Native Codex already uses the expected turn ID. A confirmed turn change permits a queue fallback. |
