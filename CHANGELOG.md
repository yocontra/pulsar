# Changelog

## 2.1.1 - 2026-11-25

- Running Antigravity sessions show their harness and transcripts. OMP sessions use the active log for activity and usage. Local model inference shows a zero cost.
- Select a session estimate on desktop to see the dates, models, response counts, and estimated cost for each model. Pi and OMP track model changes across turns.
- The file viewer supports keyboard navigation, text search, and line navigation. Changes remains accessible for edited sessions, and Git controls follow the actions available in the repository.
- Subagent lists honor the idle filter and show each name and color once. Short chats fill the viewport and toasts overlay the page.
- Search hosted tasks, filter by provider, and read task details from a selected machine. The app shows which sources are offline or stale.

## 2.1.0 - 2026-11-24

- Start managed coding sessions with `pulsar acp <provider>`. Run `pulsar acp --list` to see which executables are installed. Managed sessions can stream replies, relay permission requests, and expose modes, commands, and resume when the provider supports them. See the [provider guide](docs/acp.md) for live test results.
- View hosted Copilot, Codex, and Cursor tasks across connected machines. The machine with provider access handles the request and checks the operator’s passkey before submitting work. See [hosted agents](docs/hosted.md) for setup and verification.
- The app shows when a session’s activity is unknown. Usage distinguishes agent-reported costs, estimates, and local models. On phones, long names wrap above aligned tracks.
- The phone keyboard keeps the composer in view. The installed iOS app follows the selected theme, including the status bar.
- Push previews now show plain text. Codex transcripts omit empty waits and keep output and errors.

## 2.0.1 - 2026-11-23

### Phone app

- The phone app is rebuilt on Konsta UI over Ionic: native iOS styling on iPhone (Liquid Glass bars, inset grouped lists, sheets with detents) and Material 3 on Android, picked per device. A floating tab bar (Agents, Needs You, Usage, Settings) replaces the big page titles on tab roots.
- The composer row is + · message · mic. + holds Skills & Commands, Photo Library, Choose Files, the delivery choice (Interrupt now, Next turn, Don't wake) and Expect a Reply; a non-default choice marks the button. Choose Files opens the file picker again.
- The command sheet ("Skills & Commands") has its search field under the header, groups rows into Recent, Commands and Skills, and scrolls on its own; only the header or a pull at the list's top moves the sheet.
- The agent page's header gives the title the room: on iPhones 400 px wide or less, Find moves into More, so names and "Needs approval" show whole. A status too long for the header ends in an ellipsis.
- Usage has a phone layout: segmented period and metric, a chart card, pickers, totals and a model breakdown.
- Diagnostics shows a summary per machine, problems first, passed checks folded into one row, and a Copy button on fix commands.
- Hover titles on icon buttons and short times, with the full date.

### Live data

- Usage, git status, PRs, diagnostics and open files update live; the refresh buttons and pull-to-refresh are gone.
- The Ask view and `POST /api/v1/ask` are removed from the app. `pulsar ask`, the MCP tools and federation asks are unchanged.

### Usage

- Prices for GPT, DeepSeek, Gemini, Grok and OpenCode Zen models, from each provider's pricing page (source and date kept with each price). Model ids match with or without a provider prefix or a date suffix.
- Local models (a provider on this machine, the LAN or the tailnet, or Ollama, LM Studio, llama.cpp, MLX, vLLM) are priced at $0 and show "Local · $0".
- Plan limits for Claude Code, from Claude Code's own cached `/usage` answer (shown with its reading time), and for OpenCode Go: hard stops from OpenCode's database, and the rolling, weekly and monthly percentages from OpenCode's local service, asked at most every 5 minutes while it runs (OpenCode makes the upstream call with its own sign-in).

### Notifications

- Each push says who and what: the agent, the command or file an approval asks about, the question, a finished agent's result with how long it took and how many files changed, a failure's error, or which limit and when it resets. Text is redacted and cut to fit a lock screen. A prompt and its agent's finish replace each other; a tap opens that agent or prompt.
- The text travels inside the Web Push payload, which is encrypted for the device, so push services see only ciphertext. "Show previews on the lock screen" (on by default) sends generic text to a device instead. SECURITY.md says what the payload carries.

### Agents

- Mode switching from the app: Claude Code's modes (plan, auto-accept and the rest) and plan or regular for the other harnesses, never into a permissive mode mid-turn.
- Slash commands and skills: a `/` menu in the composer and the Skills & Commands sheet on the phone.
- Each subagent keeps one color, shown next to its name everywhere.

### Reliability

- The app keeps working across deploys: old builds' files stay available, the service worker caches every file of a build, and a failed chunk recovers by itself.
- When the app can't reach the machine (for example with Tailscale off on the phone), it says so and reconnects by itself, instead of showing "Importing a module script failed."
- App load failures are reported to the daemon log, `pulsar doctor` and Diagnostics, and the failure screen has Copy details.
- The service retries serving the app until Tailscale is up after a restart or reboot.
- A passkey decision names the device that proved it, not the passkey's label.

## 2.0.0 - 2026-11-19

Pulsar 2 adds the agent mesh: agents on every machine you own in one pool, and an app on your phone or another computer to watch and steer them, over Tailscale. Everything from 1.x works as before on one machine.

### The agent mesh

- The mesh is off by default, and `pulsar mesh` manages it. `pulsar mesh` shows whether it is on, the app URL and linked machines; `pulsar mesh on` turns it on; `pulsar mesh off` removes the background service and the approvals hook and turns the app off, keeping agent configs; `pulsar mesh list|allow|deny|forget|owner` changes who may join the pool. `pulsar setup` asks whether to turn the mesh on (the default answer is no; `--mesh` turns it on without asking, and takes the `mesh on` options). `pulsar qr` offers to turn it on when it is off.
- `pulsar mesh on` checks Tailscale (installed, running, signed in, MagicDNS, HTTPS certificates; prints the fix and re-checks on Enter), fetches this machine's certificate, turns the app on, installs the always-on service, lists your devices and which run Pulsar, warns about laptops that sleep with the lid closed and about tagged devices, adds the Claude Code approvals hook when Claude Code is here (`--no-approvals` skips it), and ends with the app URL and a QR code.
- Background service: a launchd agent (`io.github.yocontra.pulsar`) on macOS or a systemd user unit (`pulsar.service`) on Linux runs `daemon --service` from the installed `current` version, restarts it on failure and starts it at login. `pulsar mesh on` is idempotent; setup restarts the service on upgrade; `pulsar mesh off` removes it and `pulsar setup --uninstall` removes it with everything else. While the service is installed, an on-demand start starts the service instead of a second daemon, and the service takes over the socket from an on-demand daemon. In service mode the daemon retries serving the app until Tailscale is up.
- `pulsar doctor` checks the mesh: Tailscale, MagicDNS, HTTPS certificates, certificate expiry, the service (loaded, running, current install, node binary), that the app listens only on Tailscale addresses, and one line per device: its Pulsar version and link state, "offline", a tagged device to allow, or for a phone or tablet, "open the Pulsar app there in a browser". `pulsar doctor --mesh` runs only these, read-only.
- The pool: every Pulsar node of your Tailscale user links to every other one (`docs/federation.md`). Agents on all machines show in one list, tree and search. Sends, replies, broadcasts, `wait idle:`, needs-you, transcripts, Stop, Ask (`pulsar ask`, the app) and prompts from the app work across machines. The app on any node shows every pending prompt in the pool. The prompt's own machine issues the passkey challenge, checks the signature itself and decides; first answer wins. Each machine registers its own passkeys, and the phone signs with them from any machine's app (the relying party is the tailnet's domain). A known machine that reappears with a new machine id is announced; its app port stays bound to its Tailscale node. Stopping an agent on another machine takes Face ID for that Stop. A message for a machine that is away waits in an outbox and is delivered when it comes back. Tagged servers join with `pulsar mesh allow <node>` and name their owner with `pulsar mesh owner <login>`. Nodes may use different ports.
- Presence checks: `pulsar mesh allow|deny|forget|owner` and `pulsar passkeys remove` run from any shell, an agent's included, and need no terminal. The daemon asks you to confirm each change first: with the system prompt it shows itself (Touch ID, Apple Watch or your password on macOS, Windows Hello, polkit on a Linux desktop with Pulsar's action installed) or with a confirm card in the app's Needs You, answered with your passkey or, on that machine, with the app's passkey session (one Face ID per session). The first answer counts. Both name the change and the agent that asked. Repeated denials back off, and every check is audited. The word typed back in your own terminal is now only the last resort, for a person at a terminal on a machine with neither (a headless server over SSH). See `docs/presence.md`.
- Agents can read the pool settings (`pulsar mesh list`) and list passkeys (`pulsar passkeys`).
- Self-hosted control servers: the mesh runs on Headscale (`docs/headscale.md`). Setup and doctor detect the control server (`tailscale debug prefs`) and skip the tailscale.com-only checks and links. `pulsar mesh on --cert <file> --key <file> [--ca <root>]` uses your own certificate instead of `tailscale cert` (which Headscale can't issue); `mesh on` and `pulsar doctor --mesh` check its name, dates, key, chain, root and server usage, and the daemon reloads it when its files change and keeps the old one if the new files fail the checks. Federation requests and probes go to any tailnet's MagicDNS names, not only `*.ts.net`. The passkey RP id is the tailnet's MagicDNS suffix (unchanged on tailscale.com; the base domain on Headscale, the node's own name when that is a public suffix), and `--rp-id` overrides it. The owner is matched by login and user id, and a node with tags is always `tagged-devices`. `scripts/live/headscale.sh` runs the cross-machine checks on a Headscale tailnet in Docker.
- A machine with no agents can join the mesh: when setup finds no harness, or with `--client none`, it skips the agent configs and installs only the `pulsar` command; add `--mesh` (or run `pulsar mesh on`) to join. Without a service manager (a container, Linux without a systemd user session), `pulsar mesh on` says how to run `pulsar daemon --service` yourself and finishes the rest.
- Setup puts a `pulsar` command in `~/.local/bin` (a small wrapper around the installed copy and the Node setup ran with). When that folder isn't on PATH it prints the line to add for zsh, bash or fish; `pulsar doctor` checks the command, and `--uninstall` removes it. A `pulsar` it didn't write is left alone.
- `pulsar ui` opens the app; `pulsar qr`, `pulsar ui` and `pulsar mesh` share one app-URL rule.
- MCP tools: agents see `list_agents`, `send`, `respond`, `wait`, `inbox` and `set_identity`. `send await_reply=true` (with `timeout_seconds`, default 120) waits for the first reply and returns it; `pulsar send --await-reply [--timeout s]` does the same from the CLI. `respond` answers a message by id with a state: `working` when you start (call again to renew), `reply` to answer in the thread, `done` when finished (the text goes to the sender as the answer), `declined` if you can't (`retry=true` to get it again later). `list_agents question=` answers who works on a file, PR, issue, branch or project. The old names `reply`, `ask`, `whoami`, `history` and `who`, and `ack`, `done` and `nack`, still work as hidden aliases.
- The MCP server is lighter: it speaks the protocol itself and loads neither the MCP SDK nor zod at runtime. The daemon does all file, process and network work asynchronously, asks the app to retry when `tailscale whois` is slow and logs a diagnosis when its event loop stalls.
- Liveness: omp stays busy while its subagents run, extensions resend their status after a reconnect, and each agent records when its state last changed.
- Agent list accuracy: a Claude Code process that switched sessions (/resume, /clear) is one agent, not the new session plus an idle copy of the old one; its MCP server follows the session, and the daemon moves an older server's connection, waits and needs-you over. A Claude session blocked on a dialog no longer shows busy forever: it shows needs-you, as the relayed prompt or as "Waiting in the terminal" when Pulsar holds none (a prompt whose app answer timed out, /config). OpenCode sessions show again when the daemon's PATH finds an older `opencode` first (requests go to the service over HTTP, else through the service's own executable or an `opencode` new enough for `api`; `pulsar doctor` reports a stale one on the daemon's PATH), and an open OpenCode TUI with no running session shows its folder's latest session as "Idle · last session", inbox-only (sends never wake or resume it). `scripts/live/verify-agents.ts` compares a daemon's agents with the harness processes on the machine, read-only.

### The app

- A web app on each machine's Tailscale address (`https://<machine>.<tailnet>.ts.net:7337`), installable on a phone's home screen. On a phone it is an iOS-style app (Ionic); on a computer it is a desktop layout with a resizable sidebar. Both have a tree of machines, then projects, then agents; a "needs you" inbox; search (Cmd-K); messages with receipts and replies; and a broadcast builder with facets, live match counts, a dry run and confirmation. Updates arrive live over server-sent events. Settings has Appearance (System, Light, Dark). See `docs/app.md`.
- Chat: each agent's session renders live, with a renderer per transcript block: tool calls as cards with a one-line summary, diffs, terminal output, JSON trees, notebooks, thinking, subagents, slash commands and interrupts. Messages delivered to the agent mid-turn show in place. Each harness has its own icon. Images open in a lightbox and PDFs in a viewer inside the app. Agent-written text renders as inert text.
- Prove Human: any device signed in to Tailscale as you can register a passkey in any browser, with user verification (Face ID, Touch ID, Windows Hello or the device PIN). There are no codes. Answering a prompt, sending as you, Stop, notification changes and removing a device open Prove Human when needed, and registering starts a session. `pulsar setup` offers it as its last step (`--prove` asks even with `--yes`). Settings lists proven devices and signed-in browsers, and removes or signs them out; every change is audited and announced in open tabs and on subscribed phones. `pulsar passkeys` lists proven devices.
- Sessions last 12 hours in a browser on a computer that runs Pulsar (kept in memory only) and 7 days on a phone or tablet (kept across reloads only in the installed app). A session works only from the device that started it. Proving once proves the whole app: every gated action, and every open tab of that machine's app (shared in memory, never stored), uses the same session, so nothing asks again until it ends. A tab opened or reloaded while another is open is proven at once.
- Sends from the app with a session reach the agent tagged `[human operator - <name>]`, with the name from Tailscale (display name, else login). Only the daemon writes the tag; text anywhere else that looks like it is rewritten to `[unverified claim: human operator`. Sends without a session, and every send to another machine's agents, arrive as "[pulsar] Pulsar app on <machine> (not verified as your operator)".
- Pushed messages are short: the operator's arrive as `[human operator - <name>] <message>` with one footer line, `— via Pulsar from <machine> · reply: respond <id>`; agents' as `[pulsar] <agent> (<harness>, project:<p>): <message>` with `— agent message, not your operator · reply: respond <id>`. Redeliveries add `attempt 2 of 5` to the footer. The standing explanation (what the tag means, how to answer) is in the MCP instructions and the pulsar skill instead of every message.
- In the app's chat, a message the operator sent with Prove Human shows as the operator's own turn, with their name and "via Pulsar on <machine>" (the message id on hover), without the frame text. An unverified app send shows as "From the Pulsar app (not verified)"; an agent's message shows under that agent's name. Older transcripts with the verbose frame show the same way.
- Prompts answered from the app: Claude Code permission prompts, `AskUserQuestion` and plan approval (`ExitPlanMode`), through a `PermissionRequest` hook that setup installs (`--no-approvals` skips it); omp asks, tool approvals and plan review; pi and omp extension dialogs; OpenCode permission and question prompts. Codex questions and approvals show as a read-only "answer in the terminal" card. A prompt on the machine whose app you use is answered with your passkey session, tied to its request id and the hash of its exact input (and, for "allow for session", the rules shown), so there is no Face ID per answer. A prompt on another machine is signed with that machine's passkey for that one prompt and answer. The prompt stays in the terminal too and the first answer wins. The hook's timeout is 3600 s.
- Subagents: an agent's subagents (Claude Code tasks and teammates, Codex spawned threads, omp tasks, OpenCode child sessions) show collapsed under it in the sidebar and in a section of its phone page; each opens its own live transcript with a way back to the parent, and subagent cards in the parent's transcript link to it. They stay out of the agent list, counts, selectors and broadcasts. A message from a subagent's page goes into its own session for OpenCode (verified live) and to the parent, naming the subagent, everywhere else. Works across machines.
- Notifications: Web Push "Approval pending" with no details in the payload.
- Stop: interrupt an agent's current turn from the app (Cmd-.) or with `pulsar interrupt <agent>`. Codex through its app-server daemon, OpenCode through its service, pi and omp through the Pulsar extension, Claude Code with Esc into its tmux pane (sessions outside tmux can't be stopped from outside).
- Changes: see what an agent has dirty in its git worktree, live. On a computer it is a resizable panel beside the conversation (Cmd-\, remembered per device, open by itself in wide windows): the changed files with status and lines added and removed, each file's diff (side by side when wide), Expand all, and a Branch vs base mode that adds what the branch committed since the default branch. On a phone, "Changes (N)" on the agent's page opens the list and each file's diff. Works for agents on other machines through their home node. The daemon reads with git without locks or external tools, serves only files `git status` lists, and refreshes while a viewer is open (`GET /api/v1/agents/:id/changes`, `.../changes/file`, the `changes` SSE topic). See `docs/app.md`.
- Ask: `pulsar ask "who is editing src/auth/session.ts"`, the app's Ask mode and `list_agents question=` answer who works on a file, a PR or issue, a branch or a project, from the registry and a touched-files index built from the agents' session logs. Nobody is woken. `--direct` (and "Ask them directly" in the app) then sends the question to the matches.

### Delivery

- Messages that expect an answer are delivered at least once (`docs/delivery.md`). If the recipient's session ends or restarts before it answers, Pulsar delivers the message again to the resumed session (same session id; pi and omp follow the session's own id), with the same message id and "attempt 2 of 5". A single-recipient message is also delivered again when an agent that can respond does not respond within 10 minutes while idle, or responds `working` and then goes quiet for 30 minutes. After 5 attempts or 24 hours Pulsar gives up: the sender's wait ends at once and the sender gets a notice. Group messages get the restart redelivery only.
- New receipt states: working on it (`acked`), done, declined (`nacked`), expired, gave up (`dead`). The app and `inbox` show attempts. A late extension ack no longer moves a replied receipt back.
- Waits for a reply keep waiting across a daemon restart. The same reply sent twice is stored once.
- Across machines, the recipient's home node redelivers; peers on 1.x or without `receipts2` get the new states mapped to old ones.

### Breaking changes

- With the mesh on, `*` and every selector reach agents on all your machines, not only this one. Add `machine=<name>` to narrow a send.
- The MCP server's instructions are shorter. The visible tools are `list_agents`, `send`, `respond`, `wait`, `inbox` and `set_identity`; `reply`, `ask`, `whoami` and `history` are hidden aliases and no longer appear in tool lists.
- `tail` and `history` show an agent only the threads it sent or received (the operator still sees everything). Over the socket, an agent can read only its own transcript.
- A client can no longer register as a session that is live in another process, or add a second extension to an agent from another process. The same process reconnecting replaces its old extension connection.
- Agents can't call the socket `shutdown`. The daemon holds at most 1024 connections, and clients back off and start the daemon at most once every few seconds.
- Send rate limits also count per process and for all agents together, so new session ids don't reset an agent's budget.
- `pulsar stop` still stops this machine's daemon; when the background service is installed it does not stop the service. Stopping an agent's turn is `pulsar interrupt`.

### Upgrading

- Run `npx pulsar@latest setup` on each machine. Setup upgrades the agent configs (and the Claude Code hook's timeout to 3600 s) as before, then asks whether to turn the mesh on; the default answer (no) keeps 1.x behavior on that machine.
- The database migrates in place on first start (schema 7); the changes are additive, so a 1.x daemon can still open it.
- To use the mesh, turn on MagicDNS and HTTPS certificates for your tailnet first (the admin console's DNS page). `pulsar mesh on` checks both and prints the fix.
- Claude Code sessions need to run inside tmux for Stop to reach them.

## 1.4.0 - 2026-11-17

- omp sessions in folders under the home directory are found again. omp names those session folders relative to home (`-Projects` for `~/Projects`), which Pulsar missed, so PR detection and model lookup failed for them.
- Model ids from pi (`model_change.modelId`) are read, and omp's `provider/model` ids are shortened to the model id, so `model=` selectors match the same way across harnesses.

## 1.3.0 - 2026-11-16

- PR detection is fully offline and no longer uses `gh`. Pulsar reads PR refs already in the local repo (`refs/pull/<n>/head`, `refs/remotes/<remote>/pr/<n>`) that point at the agent's commit, and otherwise the last PR of the agent's repo named in its own session log (Claude Code `pr-link` records first, then PR URLs). Pulsar makes no network calls apart from `pulsar doctor`'s version check.
- `pr:` tags an agent sets on itself are kept; only the tag Pulsar detected is replaced.
- A Codex app-server thread that Pulsar cannot yet tie to a thread claims no folder (it used to report the app-server's own folder).
- Harness drivers: each harness (Claude Code, Codex, OpenCode, pi, omp, Cursor, Gemini CLI, VS Code) is one module in `src/harnesses/` behind one `HarnessDriver` interface: process matching, identity, scanning, push delivery, model and session-log lookup, and setup. Adding a harness is one new file plus one line in the registry; a contract test checks every driver. No behavior change.

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

First release of Pulsar as an agent-communication MCP server. Versions below 1.0.0 were an unrelated 2012 WebSocket pub/sub library, now published as `pulsar-archive`.

- One machine-wide list of live agents across Claude Code, Codex, OpenCode, pi, omp, Cursor and Gemini CLI, including Claude Code and OpenCode sessions that do not run pulsar.
- Auto tags (`project`, `harness`, `branch`) and self tags; selectors such as `project=x workstream=y`.
- `send` to a name, a selector or `*`, with `urgent` / `normal` / `fyi` priority and a receipt for each recipient.
- Push delivery that wakes idle sessions: Claude Code inbox socket, `codex queue`, OpenCode server API, and the pi/omp extension.
- `reply`, `ask`, `wait` (message, reply, idle), `inbox`, `history`, `set_identity`, `whoami`.
- `pulsar setup` (detect, plan, back up, apply, `--uninstall`), `pulsar doctor`, `pulsar tail`.
