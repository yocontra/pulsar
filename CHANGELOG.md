# Changelog

## 1.0.0 - 2026-11-16

First release of pulsar as an agent-communication MCP server. Versions below 1.0.0 were an unrelated 2012 WebSocket pub/sub library, now published as `pulsar-archive`.

- One machine-wide list of live agents across Claude Code, Codex, OpenCode, pi, omp, Cursor and Gemini CLI, including Claude Code and OpenCode sessions that do not run pulsar.
- Auto tags (`project`, `harness`, `branch`) and self tags; selectors such as `project=x workstream=y`.
- `send` to a name, a selector or `*`, with `urgent` / `normal` / `fyi` priority and a receipt for each recipient.
- Push delivery that wakes idle sessions: Claude Code inbox socket, `codex queue`, OpenCode server API, and the pi/omp extension.
- `reply`, `ask`, `wait` (message, reply, idle), `inbox`, `history`, `set_identity`, `whoami`.
- `pulsar setup` (detect, plan, back up, apply, `--uninstall`), `pulsar doctor`, `pulsar tail`.
