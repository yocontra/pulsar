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
| `src/harnesses/` | One driver per harness, behind `HarnessDriver` in `types.ts`; the list is `DRIVERS` in `index.ts` |
| `src/identity.ts` | Which harness and session an MCP server serves (asks the drivers) |
| `src/processes.ts` | Process table |
| `src/git.ts` | Project, branch and worktree of a folder |
| `src/setup/` | `pulsar setup` / `doctor`; shared action helpers in `actions.ts` |

## Adding a harness

1. Write `src/harnesses/<id>.ts` exporting a `HarnessDriver`. `id`, `label` and `matchProcess` are required. Add only the hooks the harness supports: `identify` (session id and folder at start), `lateSession` (the session id appears after start), `toolSessions` (one MCP process for many sessions, named in `_meta`), `scan` (live sessions), `push` (an outside way into a running session), `extension` (hosts pulsar's extension), `model`, `sessionLog`, `setup`. Without `push` or `extension` the harness is pull-only and still works.
2. Add it to `DRIVERS` in `src/harnesses/index.ts`. Lookups take the first match, so a new extension host goes before `pi`.
3. Run `bun run check`. `test/harnesses.test.ts` checks every driver against the contract.
4. Document the path, and what you verified, in `docs/adapters.md`.

Nothing else should need to change. If it does, the missing piece belongs in the driver interface.

## Rules

- Tests for every behavior change (`test/`). Delivery and setup changes need an end-to-end check against the real harness. Say in the PR which version you tested.
- Never touch a user's real agent configs in tests. `test/setup.test.ts` shows how to use a fake `HOME`.
- Do not make pulsar claim things on a harness's behalf, such as a permission mode, that it cannot verify.
