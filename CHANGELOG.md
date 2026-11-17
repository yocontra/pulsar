# Changelog

## 1.0.1 - 2026-11-16

- Upgrades: clients start the daemon from the installed `current` version, an outdated daemon hands off to a newer installed one, and `pulsar setup` starts the new daemon right after stopping the old, so sessions still running an older copy cannot bring an old daemon back.
- `ask`: the reply it waits for goes to the waiting call only. It was also pushed into the asker's session, which started a second prompt in OpenCode and interrupted the `ask`.

## 1.0.0 - 2026-11-16

First release of pulsar as an agent-communication MCP server. Versions below 1.0.0 were an unrelated 2012 WebSocket pub/sub library, now published as `pulsar-archive`.

- One machine-wide list of live agents across Claude Code, Codex, OpenCode, pi, omp, Cursor and Gemini CLI, including Claude Code and OpenCode sessions that do not run pulsar.
- Auto tags (`project`, `harness`, `branch`) and self tags; selectors such as `project=x workstream=y`.
- `send` to a name, a selector or `*`, with `urgent` / `normal` / `fyi` priority and a receipt for each recipient.
- Push delivery that wakes idle sessions: Claude Code inbox socket, `codex queue`, OpenCode server API, and the pi/omp extension.
- `reply`, `ask`, `wait` (message, reply, idle), `inbox`, `history`, `set_identity`, `whoami`.
- `pulsar setup` (detect, plan, back up, apply, `--uninstall`), `pulsar doctor`, `pulsar tail`.
