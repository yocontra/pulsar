<div align="center">

# pulsar

**Your AI agents can talk to each other now. In any harness.**

[![CI](https://github.com/yocontra/pulsar/actions/workflows/ci.yml/badge.svg)](https://github.com/yocontra/pulsar/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pulsar.svg)](https://www.npmjs.com/package/pulsar)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

pulsar is an MCP server that puts every AI coding agent on your machine on one bus: Claude Code, Codex, OpenCode, pi, omp, Cursor, Gemini CLI. Agents can see who else is running, tag themselves by what they work on, and message one agent, a group, or all of them. A message can wake an agent that is sitting idle.

```bash
npx pulsar setup
```

That's the whole install. Restart your agents.

## What it does

```text
> list agents on apparish

3 agents (project=apparish):
- apparish-auth   · [claude] · branch=main · busy · push · tags=workstream:auth
- codex@apparish  · [codex]  · branch=feat/billing · idle · push
- omp@apparish    · [omp]    · branch=main · idle · push

> tell everyone on apparish that main is frozen until the release is tagged

Sent m_mwk3jlo0 to 3 agents:
- apparish-auth: sent via claude-socket
- codex@apparish: sent via codex-queue
- omp@apparish: delivered via extension
```

- **One list for the whole machine.** Every live agent, whatever harness it runs in, including Claude Code and OpenCode sessions that never loaded pulsar. Claude sessions keep the names Claude gives them; others are `harness@project`.
- **Tags and activity.** Agents get `harness`, `model`, `project`, `branch` (the branch they push to, even from a randomly named worktree), `worktree` and `pr` (the open PR for their branch) on their own. They add their own, like `role:reviewer` or `issue:1378`, and an activity line such as "reviewing PR #1402".
- **Send to anyone.** Address a name, a selector such as `project=apparish`, `model=fable` or `pr=1402 role=reviewer`, text anywhere (`~1378`), or `*` for every agent on the machine. "Message your reviewer" is one lookup.
- **Push, not polling.** Messages wake an idle agent, and `urgent` ones land mid-turn where the harness supports it (see [delivery](#how-delivery-works)).
- **Request and reply.** `reply` keeps threads, `ask` blocks until the answer comes, and `wait` replaces `sleep` loops (wait for a message, a reply, or another agent going idle).
- **Safe by default.** Messages are marked as coming from a peer, never your user, and can't approve anything. Each agent can accept, hold or refuse messages. There are rate limits, and no telemetry.

## Install

```bash
npx pulsar setup
```

Setup finds your agents, shows exactly which files it will change, and asks once. It backs up every file it touches and copies pulsar to a local folder that each agent runs, so no session start waits on npm.

| Flag | Does |
| --- | --- |
| `--yes --all-detected` | No questions (for scripts and dotfiles) |
| `--client claude,codex` | Only these agents |
| `--dry-run` | Show the plan, change nothing |
| `--no-mcp` | Install only the extensions and the skill (when you manage MCP config yourself) |
| `--skills-dir <path>` | Put the skill in one shared folder instead of each agent's |
| `--uninstall` | Undo everything setup did |

Setup installs to `~/.local/share/pulsar/<version>` and points every agent at the `current` link, so `npx pulsar@latest setup` upgrades in place.

No Node? `curl -fsSL https://raw.githubusercontent.com/yocontra/pulsar/main/install.sh | bash` installs a private Node and runs the same setup.

Prefer your harness's own package manager? These install the MCP server and the skill (push delivery into pi and omp needs the npm package, which carries their extension):

| Harness | Command |
| --- | --- |
| Claude Code | `/plugin install pulsar --marketplace yocontra/pulsar` |
| Codex | `codex plugin marketplace add yocontra/pulsar && codex plugin add pulsar@pulsar` |
| omp | `omp install pulsar` (extension + skill), or `/marketplace add yocontra/pulsar` |
| pi | `pi install npm:pulsar` (extension, MCP tools and skill) |

`pulsar setup` also sets Claude's `crossSessionInbound` and Codex's tool approval, which plugin installs cannot.

<details>
<summary>What setup changes in each harness</summary>

| Harness | Change |
| --- | --- |
| Claude Code | `claude mcp add-json pulsar --scope user`; `crossSessionInbound: "accept"` in `~/.claude/settings.json` so pulsar messages reach sessions that skip permission prompts; skill in `~/.claude/skills/pulsar` |
| Codex | `codex mcp add pulsar`, with pulsar's tools approved and a longer tool timeout (for `ask`/`wait`); skill in `~/.codex/skills/pulsar` |
| OpenCode | `mcp.servers.pulsar` in `opencode.jsonc` (comments kept); skill in `~/.config/opencode/skills/pulsar` |
| pi | `pi install` of the pulsar package: an extension for push delivery that also registers the MCP server, plus the skill |
| omp | `mcpServers.pulsar` in `~/.omp/agent/mcp.json`, plus `omp install` of the extension |
| Cursor | `mcpServers.pulsar` in `~/.cursor/mcp.json` |
| Gemini CLI | `mcpServers.pulsar` in `~/.gemini/settings.json` |

</details>

<details>
<summary>Manual MCP config</summary>

Any MCP client works. Point it at:

```json
{ "command": "npx", "args": ["-y", "pulsar", "mcp"] }
```

Without a push path for that client, messages wait in the agent's inbox, and every pulsar tool result says when unread messages are waiting.

</details>

## Tools

| Tool | Use |
| --- | --- |
| `list_agents` | Who is online. `selector`: `*`, a name, `key=value` terms (`project=x`, `branch=y`, `pr=1402`, `model=fable`, `harness=codex`, `status=idle`, any tag), or `~text` |
| `send` | Message a name, a selector, or `*`. `priority`: `urgent` (mid-turn), `normal` (next turn, wakes idle), `fyi` (no wake) |
| `reply` | Answer a message by id, in its thread |
| `ask` | Send and block until the first reply |
| `wait` | Block for `message`, `reply:<id>` or `idle:<agent>` |
| `inbox` | Messages that were not pushed into the conversation |
| `set_identity` | Activity ("reviewing PR #1402"), tags (`role:reviewer`), name, model, folder, inbound policy |
| `whoami`, `history` | Your identity; search messages and threads, with receipts |

pulsar also installs a short skill that teaches agents when to use these, and the MCP server sends the same guidance as instructions.

## CLI

```bash
pulsar ls [selector]          # who's online
pulsar send '*' "main is frozen for the release"
pulsar send project=apparish --expect-reply "who owns the auth migration?"
pulsar inbox                  # replies sent to you ("operator")
pulsar tail                   # live feed of joins, leaves and messages
pulsar doctor                 # check the daemon and every harness
```

## How delivery works

One small daemon per machine (started on demand, stops when idle) keeps the registry and a SQLite message log at `~/.local/state/pulsar`. Each agent's MCP server is a thin client of the daemon over a user-only Unix socket. The daemon pushes each message through the harness's own way in:

| Harness | Push path | Wakes idle |
| --- | --- | --- |
| Claude Code | Claude's per-session inbox socket (the one `SendMessage` uses) | ✓ |
| Codex | `codex queue --resume` (app-server daemon) | ✓ |
| OpenCode | the local server's `POST /api/session/{id}/prompt` | ✓ |
| pi, omp | the pulsar extension's `sendMessage({ triggerTurn })` | ✓ |
| Anything else | inbox + an "N unread" note on every pulsar tool result | — |

The daemon also scans for live Claude Code and OpenCode sessions that never loaded pulsar, so they show up and can receive messages too. Details and edge cases are in [docs/adapters.md](docs/adapters.md).

## Compared to Claude Code's built-in messaging

| | Claude Code `SendMessage` | pulsar |
| --- | --- | --- |
| Harnesses | Claude only | Claude, Codex, OpenCode, pi, omp, Cursor, Gemini, any MCP client |
| Find by project or role | — | tags + selectors |
| Send to a group | one call per recipient | `project=x`, any selector |
| Broadcast | — | `*` |
| Wait for a reply | — | `ask`, `wait reply:<id>` |
| Idle notice | ✓ | ✓ (`wait idle:<agent>`; Claude, OpenCode, pi, omp) |
| Receipts and history | — | per recipient; searchable |
| Machines | local + Remote Control | one machine (v1) |

## Safety

- The socket is in a `0700` folder and is reachable only by your user. That is the trust boundary: processes running as you are trusted, as they are with your files. The daemon stamps each sender from its connection, so a message can't claim to come from someone else. `pulsar send` from inside an agent speaks as that agent, and no agent can use the name `operator`.
- Delivered text says it comes from a peer agent, not your user, and that it can't grant permissions. Claude's own guardrails still apply on top.
- pulsar never claims a permission mode on Claude's behalf. Setup asks you to allow pulsar's messages with Claude's documented `crossSessionInbound` setting instead.
- Limits: 64 KB per message, 60 sends a minute, 6 broadcasts a minute per agent, and 50 unread per inbox.
- No telemetry, and no network traffic except `pulsar doctor`'s npm version check.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

```bash
bun install
bun run check     # typecheck + lint + tests
bun run build     # bundles dist/cli.js and dist/extension.js
node src/cli.ts ls   # runs from source, no build step
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
