# Contributing

Thanks for helping. Pulsar is small on purpose: one daemon, one MCP server, one extension, one setup command.

## Setup

```bash
bun install
bun run check    # typecheck, lint, tests
bun run build    # dist/cli.js + dist/extension.js + shared chunks (bundled, no runtime deps)
```

`bun run test` runs each test file in its own `bun test` process, half the cores at a time (`PULSAR_TEST_JOBS=n` to change; every core on CI). `bun run test:e2e` runs the Playwright suites on half the cores (`PULSAR_E2E_WORKERS=n` or `50%`); every worker starts its own mock or real daemon on its own port (`web/e2e/infra.ts`), so tests that change server state never collide. Its logs are in `web/e2e-logs/`.

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

1. For an ACP executable, add its ID, installed binary, fixed arguments and protocol source to `src/harnesses/acp-catalog.ts`. Pulsar derives managed launch choices, identity and display names from that entry. Test the installed executable and record its supported operations in [ACP adapters](docs/acp.md).
2. For an attached MCP client, add a manifest in `src/harnesses/catalog.ts`. A standard JSON stdio config uses the shared setup, detection and uninstall code. A native driver can also supply live discovery, delivery, controls or transcript reading through `HarnessDriver`. Keep native process and session identification in a lightweight identity module. The client process must not load the daemon implementation.
3. Run `bun run check`. `test/harnesses.test.ts` checks every driver against the contract.
4. Add the harness to the user docs where its behavior differs: `docs/adapters.md` (delivery, limits, and the Stop and prompts tables) and the README's short harness table. Put what you verified in the PR, not the docs.

Nothing else should need to change.

## Building blocks for features

Use these instead of building your own, so features don't collide in the same files.

- **UI slots** (`web/src/lib/registry.tsx`): `registerSlot(name, { id, order?, component })` for `sidebar.header` (desktop sidebar header and phone Home header), `session.header` (desktop session header and phone agent header), `composer.left` (attach) and `composer.right` (before Send). An empty slot renders nothing. Add `only: "phone"` (or `"desktop"`) for an entry that renders on one layout, so the other layout's skeleton keeps no placeholder for it. Each `register*` returns its unregister.
- **Settings, Cmd-K, pages** (same file): `registerSettingsSection({ id, title, desktop?, phone?, when? })` renders after the built-in sections (phone bodies are IonItems in an inset list; the desktop body gets `close`, which closes the Settings layer, for example before it navigates). `registerCommand({ id, label, keys?, keywords?, run })` lists a command in Cmd-K; `registerPaletteProvider({ id, group, search(q, signal) })` adds a results group as the operator types. `registerPage({ name, desktop?, phone? })` routes `#/<name>/<arg>?<params>` in both layouts (`{ view: "page", name }` for `navigate`); no edit to `hash.ts` or the layouts' switches.
- **Where to register:** `web/src/features/<name>/register.tsx`, loaded at start by `web/src/features.ts` (no list to edit). Keep it to metadata and `lazy()` components: it counts toward the first-load budget (`web/scripts/check-dist.ts`).
- **Toasts** (`web/src/lib/toast.ts`): `toast(message, { tone, description, action, duration, id })` and `undoToast(message, onUndo)` on desktop and phone; Sonner loads with the first toast and is CSP-safe (`astro.config.mjs`). Not the store's older `toast` signal.
- **Acting ops** (`src/service/acting.ts`): an action that changes an agent's machine (`attachments.upload`, `agents.launch`, `git.commit`, `git.push`, `git.pr`) registers its handler with `service.acting.register(op, handler)` and its route calls `service.acting.run(principal, op, target, params, assertion?)`. Here that needs a passkey session; on another machine the home node verifies its own passkey challenge for exactly that op, target and params (`POST /acting/options`, then the assertion in the op's request; `api.acting(...)` in the web client does both). Every run is audited. No new federation frame is needed.
- **Git** (`src/git-write.ts`): `runGit(cwd, args, opts)` and `runGh(...)` run argv-only in the worktree holding `cwd`, with locks, hooks and a timeout, but no prompt, editor or pager (ssh in batch mode); a failure returns `{ code, message, exitCode, stderr }`. `mode: "read"` for reads next to a working agent.
- **tmux** (`src/tmux.ts`): `paneOf(agent)` (`agent.meta.tmux`, else the harness's `tmuxPane`), `sendKeys(pane, { text } | { keys })`, `capture(pane, { lines })`, `panePid(pane)`. `AgentRow.tmux` shows the pane to the app.
- **Status changes** (`src/service/events.ts`): `service.events.on("agent:status", ({ agentId, from, to, at }) => …)` fires once per shown change (busy, idle after the settle time, gone).

## Memory

One MCP server runs per agent session and the extension runs inside pi/omp, so their startup imports stay small: `test/import-graph.test.ts` fails when something heavy (an SDK, `node:crypto`, setup or transcript code, full drivers) reaches them. `bun run mem` prints each process's footprint and heap from `dist/`; `bun run test:mem` runs the slower soak tests (MCP session, daemon churn with transcripts, federation churn) after a build. If it does, the missing piece belongs in the driver interface.

## Rules

- Tests for every behavior change (`test/`). Delivery and setup changes need an end-to-end check against the real harness. Say in the PR which version you tested.
- Never touch a user's real agent configs in tests. `test/setup.test.ts` shows how to use a fake `HOME`.
- Do not make Pulsar claim things on a harness's behalf, such as a permission mode, that it cannot verify.

After changing the ACP provider catalog, run `bun scripts/acp-guide.ts` to update the public command table.
