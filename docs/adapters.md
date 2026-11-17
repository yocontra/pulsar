# Delivery adapters

How pulsar gets a message into a running session in each harness, what was verified, and the known limits. All of these were tested end to end on 2026-11-16 (Claude Code 2.1.326, Codex 0.169.0, OpenCode 2.2.5, pi 1.5.0, omp 18.21.0).

## Identity: which session is this MCP server serving?

The MCP server walks up its process tree to the first harness process, then asks that harness which session it is serving:

| Harness | Session id |
| --- | --- |
| Claude Code | `~/.claude/sessions/<pid>.json` → `sessionId` |
| Codex | the `rollout-…-<thread uuid>.jsonl` the codex process holds open (`lsof`). Codex creates the thread after starting MCP servers, so the MCP server checks again on each tool call and moves the agent to its thread id once the file exists. |
| OpenCode | `OPENCODE_SESSION_ID` when set. Otherwise the agent gets a pid-based id; the scanner still lists each running session by its own id. |
| pi, omp | pid of the harness process. The extension and the MCP server both run under that pid, so they merge into one agent. |

`PULSAR_HARNESS`, `PULSAR_SESSION_ID`, `PULSAR_NAME` and `PULSAR_TAGS` override detection.

## Claude Code

- **Path:** Claude's per-session inbox socket (`messagingSocketPath` in `~/.claude/sessions/<pid>.json`). pulsar authenticates with the session's published peer key (`<pid>.<hash>.key`) and writes one `{"type":"user", …}` line. The body is wrapped in a `<cross-session-message from-name="…">` envelope, so Claude shows who sent it.
- **Priority:** `urgent` → `next` (between tool calls). `normal` → `later` (after the turn; wakes an idle session).
- **Permission parity:** Claude holds a peer message for approval when the receiving session skips permission prompts and the sender does not attest a permission mode (`peer_message_hold`, cause `no-mode-asserted`). pulsar does not attest a mode for anyone. `pulsar setup` asks to set `crossSessionInbound: "accept"` in `~/.claude/settings.json`, which is Claude's documented switch for this.
- **Verified:** wake of an idle bypass-mode `claude -p` session. The full loop, receive and then answer with pulsar's `reply`, landed in the operator's inbox.

## Codex

- **Path:** `codex queue --thread <id> --message <text> --resume`. It queues the message and resumes the thread on the local app-server daemon, which runs a turn.
- **Verified:** a thread created by `codex exec` was resumed by `queue --resume` and answered.
- **Limit:** a TUI session that is not attached to the daemon may not see the message live; it shows on resume. The MCP server also delivers to `wait`/`ask` callers directly.
- **Setup also sets:** `default_tools_approval_mode = "approve"` (pulsar's tools only message other agents) and `tool_timeout_sec = 1900` (so `ask`/`wait` can block).

## OpenCode

- **Path:** `opencode api POST /api/session/{id}/prompt` with `{"text", "delivery": "steer" | "queue", "resume": true}` on the shared background server.
- **Verified:** the prompt is stored as a user message and starts an assistant turn in an idle session.
- **Scanner:** `opencode api session.active` lists running sessions, which makes them reachable without pulsar loaded. Idle sessions show up once they load pulsar's MCP server.

## pi and omp

- **Path:** the pulsar extension, in the same npm package (`pi.extensions` in `package.json`; omp reads the same field). It keeps a socket to the daemon and calls `sendMessage({ customType: "pulsar", … }, { triggerTurn: true, deliverAs })`. `urgent` uses `steer`; `normal` uses `followUp`.
- **Status:** the extension reports busy/idle from `agent_start` / `agent_settled` (pi) or `agent_end` (omp), which powers `wait idle:<agent>`.
- **MCP:** on pi the extension registers the MCP server itself (`registerMcpServer`). omp gets it from `~/.omp/agent/mcp.json`.
- **Verified:** pi received the message and started a turn, with the `mcp_pulsar_*` tools loaded. omp received the message, woke and answered.

## Anything else (Cursor, Gemini CLI, VS Code, …)

Pull only. Messages wait in the inbox. The `pulsar://inbox` resource sends `resources/updated`, the server logs a notice, and every pulsar tool result ends with "N unread pulsar messages" until the agent calls `inbox`.
