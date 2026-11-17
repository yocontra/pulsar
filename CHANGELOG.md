# Changelog

## 1.2.0 - 2026-11-16

Cleanup release: fixes from a full audit, no new features.

- JSON output: an agent's `summary` field is now `activity`, matching the tools. `set_identity summary=` still works.
- `wait` and `ask` calls from a disconnected session no longer swallow later messages.
- Replies to the operator get the same size, empty-body and rate checks as other sends; failed sends no longer count against the rate limit.
- A session that re-registers under a new id can no longer take another agent's name.
- The daemon exits after an unexpected error (the next call starts a fresh one) and refuses to start if it cannot lock down its socket.
- `pulsar stop` / `status` and setup report real errors instead of "not running".
- Internals: `identity.ts` split into `processes.ts`, `git.ts` and `sessions.ts`; shared helpers; unit tests for envelopes, frame parsing, TOML edits, the store, GitHub lookups and harness detection (87 tests).
- README lists the environment variables and says that PR lookups call GitHub through `gh`.

## 1.1.0 - 2026-11-16

- Model awareness: each agent shows the model it runs (Claude transcripts, Codex rollouts, OpenCode messages, pi/omp extension). `model=fable` selects every Fable agent.
- PR awareness: agents are tagged `pr:<n>` with the open GitHub PR for their branch (via `gh`, cached).
- Activity: `set_identity activity="reviewing PR #1402"` with tags like `role:reviewer` / `issue:1378`; the skill teaches the lookups ("message your reviewer", "message the PR author").
- Text search: `~1378` or `#1378` matches name, branch, tags, model or activity.
- Worktrees: `branch` is the branch a worktree pushes to (randomly named worktrees report their real branch); new `worktree:` tag; git info is re-read every 30 seconds; `set_identity cwd=…` for agents that move.
- Codex agents under the app-server take their folder from the thread's rollout.
- CLI: `pulsar reply <message-id> <text>` answers in the message's thread (run from an agent's shell, it replies as that agent).

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
