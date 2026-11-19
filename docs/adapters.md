# Harness support

How Pulsar names agents, how messages reach each harness, and what each harness can't do.

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
| Codex | `codex queue --resume`: queued on the thread, then run as a turn | No |
| OpenCode | OpenCode's local server, into the session | Yes |
| pi, omp | The Pulsar extension, inside the session | Yes |
| Cursor, Gemini CLI, others | Pull only: messages wait in the inbox, and every Pulsar tool result says how many are unread | No |

Limits:

- **Claude Code** holds a peer message for approval when the session skips permission prompts. `pulsar setup` asks to set `crossSessionInbound: "accept"` in `~/.claude/settings.json` to deliver these. When the session shows a dialog in the terminal, the app shows the agent as needing you.
- **Codex** reports no busy or idle state, so `wait idle:` never resolves for a Codex agent. A Codex TUI that is not attached to Codex's app-server may not show a message until you resume it. Setup sets `default_tools_approval_mode = "approve"` for Pulsar's tools and `tool_timeout_sec = 1900`, so `ask` and `wait` can block.
- **OpenCode**: an idle TUI with no running session shows its folder's most recent session as "Idle · last session". Pulsar does not push into it until that session loads Pulsar's tools. If the daemon finds an `opencode` older than 2.0 first on its PATH, `pulsar doctor` says so.
- **pi, omp**: the only harnesses where a receipt reaches "in its conversation".

See [delivery.md](delivery.md) for receipts and redelivery.
