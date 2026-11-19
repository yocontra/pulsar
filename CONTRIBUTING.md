# Contributing

Thanks for helping. Pulsar is small on purpose: one daemon, one MCP server, one extension, one setup command.

## Setup

```bash
bun install
bun run check    # typecheck, lint, tests
bun run build    # dist/cli.js + dist/extension.js + shared chunks (bundled, no runtime deps)
```

The source runs directly with Node 22.13+ or Bun (`node src/cli.ts ls`). It uses only erasable TypeScript syntax, so no build step is needed during development.

## Layout

| Path | What |
| --- | --- |
| `src/daemon.ts` | Thin facade: a `PulsarService` behind the socket transport |
| `src/service/` | The daemon's state and rules: `registry.ts` (agents, presence, scans, pool-wide lookups), `mailbox.ts` (send, reply, inbox, history, receipts, rate limits, waits), `router.ts` (local delivery; remote targets go to the pool's outbox), `pool.ts` (`PoolView`: how the service sees other machines), `waiters.ts`, `events.ts` (typed event bus), `authorize.ts`, composed in `index.ts`. Every request runs for a `Caller` (`caller.ts`) whose `Principal` the transport decides |
| `src/federation/` | The pool (see `docs/federation.md`): `tailnet.ts` (`tailscale status`, requests to peers' ts.net names), `config.ts` (`pool.json`, `pulsar mesh`), `protocol.ts` (frames, versions), `local.ts` (this node's agents as snapshot + numbered deltas), `state.ts` (peers and their agents in memory), `transcripts.ts` (remote transcripts through the home node), `index.ts` (`Federation`: discovery, heartbeats and digest gossip, registry streams, outbox, receiving deliveries, `/fed/v1`). Tests run three daemons on an in-process fake tailnet (`test/fake-tailnet.ts`) |
| `src/transport/socket.ts` | The local newline-JSON RPC; one `Caller` per connection |
| `src/transport/http.ts` | The app's HTTP transport (Hono): identity, Host/Origin/`X-Pulsar` checks, REST under `/api/v1`, SSE, static `dist/web/`; mounts federation's `/fed/v1` |
| `src/service/views.ts`, `app.ts` | Pool views for the app (tree rollups, paged agents, facets, search, wakeability) and user sends (dry run, resolve tokens) |
| `src/http/` | `identity.ts` (`tailscale whois`/`status`/`cert`, `StaticIdentity`), `events.ts` (SSE topics, coalescing, resume), `config.ts` (remote on/off, app URL), `start.ts` |
| `src/store.ts` | SQLite: messages, receipts, identities, machine id; migrations by `PRAGMA user_version` (additive only) |
| `src/machine.ts` | Machine name: Tailscale MagicDNS short name, else the host name |
| `src/mcp.ts`, `src/mcp-server.ts` | The MCP server each agent runs, on a small stdio JSON-RPC server (no SDK: one runs per agent, so it stays small) |
| `src/gc.ts`, `src/lazy.ts` | Memory helpers: full GC on idle, builtins loaded on first use, the daemon's V8 flags |
| `src/extension.ts` | pi / omp extension (push delivery) |
| `src/harnesses/` | One driver per harness, behind `HarnessDriver` in `types.ts`; the list is `DRIVERS` in `index.ts`. Each driver's identity part (process matching, session discovery) lives in a light `*-ident.ts` module (`simple-ident.ts` for the small ones), listed in `IDENTS` in `ident.ts`: the MCP server, hook and extension load only those |
| `src/transcripts/` | Live transcripts: the normalized event (`types.ts`), tool summaries, and the shared tailer (offsets, partial lines, truncation, history paging, one ref-counted watcher per agent); `service/transcripts.ts` exposes it as `PulsarService.transcripts` |
| `src/identity.ts` | Which harness and session an MCP server serves (asks the drivers) |
| `src/processes.ts` | Process table |
| `src/git.ts` | Project, branch and worktree of a folder |
| `src/setup/` | `pulsar setup` / `pulsar mesh` / `doctor`; shared action helpers in `actions.ts`; the steps after the agent configs in `steps.ts` (`SETUP_STEPS`); `setup.json` in `state.ts`; the `pulsar mesh` commands in `mesh-cli.ts`, the `mesh on` flow in `mesh.ts`, its doctor checks in `mesh-doctor.ts`; the launchd/systemd service in `service.ts`. Every command these run goes through an injected runner, so tests never reach the real `launchctl`, `systemctl` or `tailscale` |

## Adding a harness

1. Write `src/harnesses/<id>.ts` exporting a `HarnessDriver`. `id`, `label` and `matchProcess` are required. Add only the hooks the harness supports: `identify` (session id and folder at start), `lateSession` (the session id appears after start), `toolSessions` (one MCP process for many sessions, named in `_meta`), `scan` (live sessions), `push` (an outside way into a running session), `extension` (hosts Pulsar's extension), `model`, `sessionLog`, `transcript` (where the live transcript is and how to parse it into `TranscriptEvent`s; parsing must not depend on where a chunk starts), `setup`. Without `push` or `extension` the harness is pull-only and still works.
2. Put its identity part (`id`, `label`, `matchProcess`, and `identify`, `lateSession`, `toolSessions`, `extension` if it has them) in a light module (`src/harnesses/<id>-ident.ts`, or `simple-ident.ts` when it is only a matcher) that imports no setup, transcript or push code, and spread it into the driver. Add the driver to `DRIVERS` in `src/harnesses/index.ts` and its ident to `IDENTS` in `src/harnesses/ident.ts`, at the same position. Lookups take the first match, so a new extension host goes before `pi`.
3. Run `bun run check`. `test/harnesses.test.ts` checks every driver against the contract.
4. Add the harness to the user docs where its behavior differs: `docs/adapters.md` (delivery and limits) and the README's Stop and prompts tables. Put what you verified in the PR, not the docs.

Nothing else should need to change.

## Memory

One MCP server runs per agent session and the extension runs inside pi/omp, so their startup imports stay small: `test/import-graph.test.ts` fails when something heavy (an SDK, `node:crypto`, setup or transcript code, full drivers) reaches them. `bun run mem` prints each process's footprint and heap from `dist/`; `bun run test:mem` runs the slower soak tests (MCP session, daemon churn with transcripts, federation churn) after a build. If it does, the missing piece belongs in the driver interface.

## Rules

- Tests for every behavior change (`test/`). Delivery and setup changes need an end-to-end check against the real harness. Say in the PR which version you tested.
- Never touch a user's real agent configs in tests. `test/setup.test.ts` shows how to use a fake `HOME`.
- Do not make Pulsar claim things on a harness's behalf, such as a permission mode, that it cannot verify.
