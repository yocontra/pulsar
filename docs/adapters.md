# Delivery adapters

How Pulsar gets a message into a running session in each harness, what was verified, and the known limits. Each harness's code is one driver in `src/harnesses/<id>.ts`. Tested end to end on 2026-11-16 (Claude Code 2.1.326, Codex 0.169.0, OpenCode 2.2.5, pi 1.5.0, omp 18.21.0).

## Identity: which session is this MCP server serving?

The MCP server walks up its process tree to the first harness process, then asks that harness which session it is serving:

| Harness | Session id |
| --- | --- |
| Claude Code | `~/.claude/sessions/<pid>.json` → `sessionId` |
| Codex | the `rollout-…-<thread uuid>.jsonl` the codex process holds open (`lsof`). Codex creates the thread after starting MCP servers, so the MCP server checks again on each tool call and moves the agent to its thread id once the file exists. |
| OpenCode | `OPENCODE_SESSION_ID` when set. Otherwise the agent gets a pid-based id; the scanner still lists each running session by its own id. |
| pi, omp | pid of the harness process. The extension and the MCP server both run under that pid, so they merge into one agent. |

`PULSAR_HARNESS`, `PULSAR_SESSION_ID`, `PULSAR_NAME` and `PULSAR_TAGS` override detection.

**Names:** an agent's name is the first of these that exists:

1. A name the agent chose: `set_identity name=…` or `PULSAR_NAME`. It sticks, across daemon restarts too.
2. The name the harness gives the session, a rename or a title the harness generated. Pulsar follows it live as it changes.
3. `<harness>@<project>`.

A harness name becomes a slug (`Recover TODO and audit game` → `recover-todo-and-audit-game`). A slug longer than 40 characters is cut at a word boundary. Generated titles also drop omp's category (`🐝 SWARM: Swarm-review first program` → `swarm-review-first-program`); a rename keeps everything the user typed. Claude's names are used as they are. Placeholders such as OpenCode's `New session - <date>` are not names. When a pi or omp session loses its name (`/new`), the agent goes back to `<harness>@<project>`. Where each name comes from:

| Harness | Name | Set by | How Pulsar reads it |
| --- | --- | --- | --- |
| Claude Code | `name` in `~/.claude/sessions/<pid>.json` (`nameSource`: `user` for `/rename`, `auto` for an AI title, `derived` from the folder) | user or Claude | the scan, every 4 s, and the MCP server at start |
| Codex | `thread_name` in `$CODEX_HOME/session_index.jsonl` (one line per name, the last one wins; the same value as `threads.name` in `state_*.sqlite`). Codex does not record whether the user typed it. `threads.title` is the first prompt, not a name. | `/rename` or the Codex app | the daemon reads the bytes appended since its last read, every 5 s |
| OpenCode | the session `title` (a generated title until the user renames it) | OpenCode or user | the scan (`GET /api/session/<id>`), every 20 s |
| omp | `getSessionName()`; the session header's `titleSource` says `user` (`/rename`) or `auto` (the title generator, which can retitle a session later) | omp or user | the extension, at hello and after each turn |
| pi | `getSessionName()`, from `session_info` entries written by `/name` | user | the extension, at hello, on `session_info_changed` and after each turn |
| Cursor, Gemini CLI | none read | | |

A rename keeps the agent id; only the name changes. For 15 minutes, `send`, `ask` and `wait idle:` with the old name still reach the agent, unless a live agent now has exactly that name. The old name wins over a longer name that it is a prefix of. Ids always resolve. The grace period covers this machine only: other machines see the new name at once through federation, and reach the agent by its new name or its pool address. Collisions get `-2`, `-3`, and an agent keeps its suffix while its harness name stays the same. `operator`, `user`, `human` and `system` are reserved.

**Status:** Claude's session file and OpenCode's `session.active` give busy/idle (Claude's `waiting`, a dialog waiting on the user, shows as needs-you: the relayed prompt when the approvals hook has one, else reason `terminal`, "Waiting in the terminal: <waitingFor>", until the dialog closes. Underneath, a permission prompt or question stays busy, since the turn stopped in the middle; an open dialog such as /config is idle unless a subagent log was written in the last minute); the pi/omp extension reports it directly. Codex reports none, so `wait idle:` does not resolve for Codex agents.

## Claude Code

- **Path:** Claude's per-session inbox socket (`messagingSocketPath` in `~/.claude/sessions/<pid>.json`). Pulsar authenticates with the session's published peer key (`<pid>.<hash>.key`) and writes one `{"type":"user", …}` line. The body is wrapped in a `<cross-session-message from-name="…">` envelope, so Claude shows who sent it.
- **Priority:** `urgent` → `next` (between tool calls). `normal` → `later` (after the turn; wakes an idle session).
- **Permission parity:** Claude holds a peer message for approval when the receiving session skips permission prompts and the sender does not attest a permission mode (`peer_message_hold`, cause `no-mode-asserted`). Pulsar does not attest a mode for anyone. `pulsar setup` asks to set `crossSessionInbound: "accept"` in `~/.claude/settings.json`, which is Claude's documented switch for this.
- **Verified:** wake of an idle bypass-mode `claude -p` session. The full loop, receive and then answer with Pulsar's `reply`, landed in the operator's inbox.
- **Not separately verified:** an `urgent` message landing between tool calls of a busy turn. That is Claude's documented behavior for `next`; in our test the turn ended first, and the message ran as the next turn.
- **Receipt:** `sent`. Pulsar cannot see whether Claude delivered or held the message.
- **Approvals:** `pulsar mesh on` (and `pulsar setup` while the mesh is on) adds a `PermissionRequest` hook (`pulsar hook claude-permission`, timeout 3600 s, so a question or plan can wait an hour; `pulsar doctor` flags hooks installed with 600 s) to `~/.claude/settings.json`. The hook asks the daemon and blocks; the terminal prompt stays usable, and the first answer wins. Verified with Claude Code 2.1.326 in tmux:
  - The app's `allow` dismisses the terminal prompt; `deny` carries the note to the model; "Allow for session" sends Claude's own `addRules` / `addDirectories` suggestions rewritten to `destination: "session"` (never `setMode`), and a repeat of the command then runs without a prompt.
  - Escape or "No" in the terminal sends the hook SIGTERM within ~300 ms; the daemon sees its socket close.
  - "Yes" in the terminal leaves the hook running. The session record (`~/.claude/sessions/<pid>.json`) goes from `status: "waiting"` (`waitingFor: "permission prompt"`) to `busy` ~0.4 s later; the daemon polls it while a prompt is pending and releases the hook (measured: 0.9 s, while the command still ran).
  - The transcript's `tool_result` carries `permissionDecision` (`source: "user_temporary"`, or `"hook"`), but only once the tool finishes; Pulsar uses it to tell queued prompts in one session apart.
  - `prompt_id` names the user's turn and is shared by every prompt in it; approval ids are `prompt_id.<input hash>`.
  - When nobody could answer from the app (the app is off on this machine, or no reachable pool node has a passkey), the hook returns no decision at once and nothing waits.
  - `pulsar mesh on` adds the hook when Claude Code is here, and `pulsar setup` adds it as its `claude-approvals` step while the mesh is on (only when Claude Code is selected). With the mesh off, nothing adds it. `--no-approvals`, `pulsar mesh off` and `pulsar setup --uninstall` remove it.

## Codex

- **Path:** `codex queue --thread <id> --message <text> --resume`. It queues the message and resumes the thread on the local app-server daemon, which runs a turn.
- **Verified:** a thread created by `codex exec` was resumed by `queue --resume` and answered. A Codex session sent to Claude through Pulsar, with its thread id found from the rollout file.
- **Two threads in one app-server:** candidates are tried newest first, same folder first, and the daemon refuses a thread another connection already serves. Two brand-new threads in the same folder can still swap ids until each has written its rollout file.
- **Receipt:** `sent`.
- **Limit:** a TUI session that is not attached to the daemon may not see the message live; it shows on resume. The MCP server also delivers to `wait`/`ask` callers directly.
- **Setup also sets:** `default_tools_approval_mode = "approve"` (Pulsar's tools only message other agents) and `tool_timeout_sec = 1900` (so `ask`/`wait` can block).

## OpenCode

- **Path:** `POST /api/session/{id}/prompt` (over HTTP to the URL in OpenCode's `service.json`, else `opencode api` run from the service's own executable, else the `opencode` on PATH when its `--version` is 2 or later, else `~/.opencode/bin/opencode`: the daemon's PATH may find an older `opencode` without `api`, which `pulsar doctor` reports) with `{"text", "delivery": "steer" | "queue", "resume": true}` on the shared background server.
- **Verified:** the prompt is stored as a user message and starts an assistant turn in an idle session.
- **Identity:** OpenCode runs one MCP process for all its sessions and sends `_meta["ai.opencode/sessionID"]` with every tool call. Pulsar opens one daemon connection per OpenCode session, so each session is its own agent with its own folder and project.
- **Receipt:** `sent`.
- **Scanner:** `session.active` lists running sessions, which makes them reachable without Pulsar loaded. Each OpenCode TUI on the shared service with no running session in its folder shows that folder's most recently updated root session, idle (`meta.sessionFrom = "folder"`: the service does not say which session a TUI shows). Such a guess is inbox-only: no send, broadcast or redelivery pushes into it (it would resume a session the operator may not use), broadcast wake counts leave it out, and the app shows it as "Idle · last session". Once that session connects to pulsar itself (its pulsar tools), it is a normal target. Other idle sessions show up once they load Pulsar's MCP server.

## pi and omp

- **Path:** the Pulsar extension, in the same npm package (`pi.extensions` in `package.json`; omp reads the same field). It keeps a socket to the daemon and calls `sendMessage({ customType: "pulsar", … }, { triggerTurn: true, deliverAs })`. `urgent` uses `steer`; `normal` uses `followUp`.
- **Status:** the extension reports busy/idle from `agent_start` / `agent_settled` (pi) or `agent_end` (omp), which powers `wait idle:<agent>`.
- **MCP:** on pi the extension registers the MCP server itself (`registerMcpServer`). omp gets it from `~/.omp/agent/mcp.json`.
- **Verified:** pi received the message and started a turn, with the `mcp_pulsar_*` tools loaded. omp received the message, woke and answered.
- **Receipt:** `sent`, then `delivered` when the extension acks; a failed `sendMessage` nacks the message back to the inbox.
- **Resume key:** on `session_start` the extension reports `ctx.sessionManager.getSessionId()` (pi 1.5.0, omp 18) as the agent's resume key. The agent id stays the pid; a tracked message that reached an earlier session with the same key is delivered again to the restarted one ([delivery.md](delivery.md)).
- **Interactions:** the extension relays `ctx.ui` dialogs, omp's `ask` form and tool approvals, and omp's plan review to the app; the local dialog stays usable and the first answer wins. See [interactive-tools.md](interactive-tools.md).

## Anything else (Cursor, Gemini CLI, VS Code, …)

Pull only. Messages wait in the inbox. The `pulsar://inbox` resource sends `resources/updated`, the server logs a notice, and every Pulsar tool result ends with "N unread Pulsar messages" until the agent calls `inbox`.

## PR detection (offline)

Every minute the daemon tags each agent with the PR it works on, with no network and no `gh`:

1. **Local PR refs.** If the repo has `refs/pull/<n>/head` or `refs/remotes/<remote>/pr/<n>` (for example after `git config --add remote.origin.fetch '+refs/pull/*/head:refs/remotes/origin/pr/*'` and a fetch), the ref that points at the agent's checked-out commit names the PR. This works whatever the local branch is called.
2. **The agent's session log.** Otherwise, the last PR of the agent's own repo (from its push remote) named in its log: Claude Code's `pr-link` records first, then PR URLs such as `gh pr create` output or a link the agent opened. Logs read: Claude transcripts, Codex rollouts, OpenCode messages, pi/omp session files.

Only the `pr:` tag Pulsar added is replaced. `pr:` tags an agent set itself (`set_identity tags_add=["pr:1402","role:reviewer"]`) stay.


## Transcript images

Parsers emit only an image's id, type and URL; the daemon reads the bytes back from the source line on request (`GET /api/v1/agents/:id/transcript/images/:imageId`). Shapes read; on 2026-11-17 real local Claude, Codex and omp sessions paged and every image read back:

- Claude Code: `{type:"image", source:{type:"base64", media_type, data}}` in user messages (pasted) and inside `tool_result.content`.
- Codex: `{type:"input_image", image_url:"data:image/…;base64,…"}` in `custom_tool_call_output` / `function_call_output` `output` arrays, and in user `message` content.
- omp: `{type:"image", mimeType, data:"blob:sha256:<hex>"}` in `toolResult` content; the bytes are raw in `~/.omp/agent/blobs/<hex>`. Inline base64 `data` (pi) is supported but was not seen in local files.

Remote image URLs are dropped. Only PNG, JPEG, GIF and WebP are served, decided by the bytes, up to 10 MB.
