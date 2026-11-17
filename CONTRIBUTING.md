# Contributing

Thanks for helping. pulsar is small on purpose: one daemon, one MCP server, one extension, one setup command.

## Setup

```bash
bun install
bun run check    # typecheck, lint, tests
bun run build    # dist/cli.js + dist/extension.js (bundled, no runtime deps)
```

The source runs directly with Node 22.13+ or Bun (`node src/cli.ts ls`). It uses only erasable TypeScript syntax, so no build step is needed during development.

## Layout

| Path | What |
| --- | --- |
| `src/daemon.ts` | Registry, routing, delivery, RPC handlers |
| `src/mcp.ts` | The MCP server each agent runs |
| `src/extension.ts` | pi / omp extension (push delivery) |
| `src/adapters/` | How to push into Claude Code, Codex, OpenCode |
| `src/scanners.ts` | Finding live sessions that do not run pulsar |
| `src/identity.ts` | Which harness and session an MCP server serves |
| `src/setup/` | `pulsar setup` / `doctor`, one entry per harness in `clients.ts` |

## Adding a harness

1. Detection: add a case to `harnessOfArgs` and a session-id lookup to `detectRegistration` in `src/identity.ts`.
2. Push: add an adapter in `src/adapters/index.ts` if the harness has an outside way into a running session. Otherwise it is pull-only and still works.
3. Setup: add an entry to `CLIENTS` in `src/setup/clients.ts` with detect / configured / plan.
4. Document the path, and what you verified, in `docs/adapters.md`.

## Rules

- Tests for every behavior change (`test/`). Delivery and setup changes need an end-to-end check against the real harness. Say in the PR which version you tested.
- Never touch a user's real agent configs in tests. `test/setup.test.ts` shows how to use a fake `HOME`.
- Do not make pulsar claim things on a harness's behalf, such as a permission mode, that it cannot verify.
