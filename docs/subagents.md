# Subagents

Many harnesses let an agent start helpers: Claude Code's Task/Agent tool and agent-team members, Codex's spawned threads, omp's `task` tool, OpenCode's child sessions. Pulsar shows them under the agent that started them, with their own live transcript. This page says where each harness keeps them, what Pulsar reads, and what can be messaged.

## The model

- A subagent's id is `<parent agent id>/sub:<key>`. On another machine it carries the parent's pool address: `<machineId>/<parent id>/sub:<key>`. A local agent id always has a `:` before its first `/` and a machine id never does, so the two never mix (`isLocalSubagentId` in `src/service/pool.ts`).
- Subagents are not agents. They live in their own map (`src/service/subagents.ts`), never in the registry, so `list_agents`, selectors, `*`, project and machine broadcasts, tree counts and facets never see them. Only their exact id reaches one, and only from the app. The MCP tools and selectors are unchanged.
- An agent row carries `subagents: {total, running, done}` once Pulsar found one (absent otherwise, and from older daemons and peers; `done` is absent from older ones). `GET /api/v1/agents/:id/subagents` lists them, `GET /api/v1/subagents/:id` returns one, and `GET /api/v1/agents/<subagent id>/transcript` reads its transcript. A `subagents: [agent ids]` subscription sends `subagents` events (list updates). The feature flag is `subagents` in `/hello`.
- States: `running`, `idle` (a teammate or child session waiting for work) and `done`. When the parent's session ends, all of its subagents are done.
- Across machines, counts ride on the home node's agent records (`FedAgent.subagents`), and the list, one subagent and its transcript are read through the home node (`act: subagents.list`, `transcript.page`). The home node's answer is checked: only subagents of the agent asked about, every field bounded. Older peers have no counts, so the app shows nothing for their agents.

## Discovery

Discovery is lazy and incremental. Every 15 seconds the daemon runs one cheap check per live agent: the `stat` of its subagent folder (Claude Code, omp). It lists again only when that folder's mtime moved or a child is still running, and it re-reads only files whose mtime or size changed. Codex and OpenCode have no folder to check: their subagents are listed when someone looks (the list, an expanded sidebar row, a subagent page) and kept current while watched or running, at most every 30 seconds. A parent's live transcript showing a Task call or a sidechain record also lists its subagents again. Everything is asynchronous (`test/sync-guard.test.ts`).

## Per harness

Tested on 2026-11-18 with Claude Code 2.1.327, Codex 0.169.0, OpenCode 2.2.5, omp 18.22.2 and pi 1.5.0. Counts come from one developer machine and only show which formats are in use.

### Claude Code

- **Where:** `~/.claude/projects/<folder>/<session>/subagents/agent-<id>.jsonl`, next to `agent-<id>.meta.json`. Every record in the log has `isSidechain: true` and `agentId: <id>`. The meta file has `agentType`, `description`, `toolUseId` (the parent's Task/Agent call), `finished: true` once it returned, `parentAgentId` when another subagent started it, and for agent-team members `taskKind: "in_process_teammate"` with `name`, `teamName` and `color`.
- **Inventory:** 997 subagent logs in 45 sessions, each with a meta file. 506 were Task/Agent calls (503 with `finished`, 139 nested via `parentAgentId`, spawn depth up to 2) and 491 were in-process teammates (no `toolUseId`, no `finished`). 3 sessions also had `subagents/workflows/` folders.
- **Read:** the meta file (re-read only when it changes) and the first line of the log once (start time). Done: `finished: true`. A task with no write for 10 minutes and no `finished` mark is taken as done. A teammate is running while its log was written in the last minute, else idle. Nested subagents are listed flat with their parent link and shown under it. Workflow runs are not listed.
- **Transcript:** the subagent's own log, through the session parser, with the sidechain mark dropped (in the parent's log it folds events under the Task call). The parent's transcript links each subagent card to its page by `toolUseId`.
- **Messages:** none. Claude Code has no outside way into a subagent: the session's inbox socket reaches the main session only. Agent-team members read inbox files under `~/.claude/teams/<team>/inboxes/`, but that format is internal and undocumented, and it was not verified against a scratch session (that needs a signed-in Claude Code), so Pulsar does not write to it. A message from a Claude subagent's page goes to the parent.

### Codex

- **Where:** a spawned agent is its own thread whose `source.subAgent.thread_spawn.parent_thread_id` names the parent (with `agent_nickname`, `agent_role`, `depth`). Codex keeps threads in `~/.codex/state_5.sqlite` (`threads`, `thread_spawn_edges`).
- **Inventory:** 1,420 spawn edges (1,006 `open`, 414 `closed`). Only 3 of the 1,420 child threads had a rollout file; the rest keep their history in Codex's database (`history_mode: paginated`). `open` does not mean running.
- **Read:** the app-server's `thread/list` over its control socket, filtered to `sourceKinds: ["subAgentThreadSpawn"]` and the parent's folder, then to the parent's thread and its descendants. `status.type` `active` is running, `idle` is idle, anything else done. Without a running app-server none are listed. Pulsar does not open Codex's database (no synchronous reads in the daemon).
- **Transcript:** the thread's rollout, like any Codex thread. Threads with no rollout say the transcript isn't shared.
- **Messages:** none verified. `codex queue --thread <id>` accepts a child thread id, but whether the spawned agent then runs it could not be checked without a signed-in Codex, so a message goes to the parent.

### omp

- **Where:** a `task` subagent writes `<session>/<Name>.jsonl` in the folder named after the parent's session file (`~/.omp/agent/sessions/<folder>/<time>_<id>/`). Line 2 is `{"type":"session","parentSession":…}`. It ends with a `session_exit` record and leaves its result in `<Name>.md`. The same folder holds tool logs (`*.log`) and blobs, which are skipped.
- **Inventory:** 479 subagent logs in 48 session folders; 444 had a result file; of 400 checked, 340 ended with `session_exit`.
- **Read:** the session record once (start time) and the last 4 KB when the file changed. Done: a `session_exit` record or a result file.
- **Transcript:** the subagent's log, through the pi parser (line 1 is skipped as for any omp session).
- **Messages:** none. omp runs task subagents on an in-process bus that its extensions can't reach, so a message goes to the parent.

### OpenCode

- **Where:** a subagent is a child session (`parentID`) on the shared service. `GET /api/session?parentID=<id>` lists them; `session.active` says which run.
- **Inventory:** 8 sessions, 6 of them children.
- **Read:** those two calls, only while the service already runs (`opencode api` would start one otherwise). Running ones are `running` in `session.active`; the rest are idle. Only direct children are listed.
- **Transcript:** none (Pulsar reads no OpenCode transcripts yet).
- **Messages:** direct. `session.prompt` on the child's own id (`opencode api POST /api/session/<child>/prompt`), the same call Pulsar uses for any OpenCode session. Verified live against a private server (`opencode api --standalone` with a temporary `HOME` and `XDG_*` folders, never the user's service): a prompt with `delivery: "queue"` and `resume: false` waited in the child's inbox (`GET /api/session/<child>/inbox`); with `resume: true` it became a user message in the child's transcript and started the child's turn.

### pi

pi has no subagents of its own. No pi session on the test machine named a parent session, so Pulsar lists none for pi.

## Finished subagents in the app

By default the sidebar and the phone's agent page list only running and idle subagents, and the disclosure counts those ("2 running subagents", "1 idle subagent", "3 subagents · 1 running"). An agent with none shows no disclosure. The per-device setting "Show finished subagents" (Settings, saved like Appearance in `localStorage`) lists the finished ones too, dimmed, with "Finished 3m ago". The filter runs in the app (`visibleSubagents` in `web/src/lib/subagents.ts`): the list and its live updates stay whole, so the parent transcript's subagent card still opens a finished one. With counts from an older daemon (no `done`), only running ones are counted.

## Messaging from the app

The subagent's page says where a message goes before you send it (`messaging.note`, written by the daemon):

- `direct`: `POST /send` with `ids: [<subagent id>]` delivers into the subagent's own session, with a receipt for the subagent. A finished one is refused (`410 gone`).
- `parent`: the same send is refused (`409 subagent_unreachable`, with the note and the parent's id). With `viaParent: true` it goes to the parent agent, starting `For your subagent "<name>" (<key>): `, with the receipt on the parent. Pulsar never reports a delivery to the subagent itself.
