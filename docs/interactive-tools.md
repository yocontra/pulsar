# Interactive tools

Which harness tools need the operator, how each is answered on the agent's own screen, and how Pulsar relays it to the app (phone and desktop). Inventory taken on 2026-11-17 from the installed harnesses (Claude Code 2.1.327, Codex 0.169.0, OpenCode 2.2.5, pi 1.5.0, omp 18.22.2): tool definitions read from the binaries and packages, usage counted (counts only) from local session logs.

Every relayed prompt is an **interaction** with a kind: `permission`, `question`, `plan`, `confirm`, `select` or `input` (`InteractionKind` in `src/http/wire.ts`). The terminal stays usable and the first answer wins. Every answer from the app needs a passkey assertion over the exact prompt and answer.

## Summary

| Harness | Interactive tool or prompt | Kind | Answered today | Relayed by Pulsar | Status |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Permission prompt (any tool) | permission | TUI prompt | `PermissionRequest` hook → `allow` / `deny` (+ session rules) | Supported (live, 2.1.326) |
| Claude Code | `AskUserQuestion` | question | TUI multiple-choice card | `PermissionRequest` hook → `allow` with `updatedInput: {...input, answers}` | Supported (live, 2.1.327) |
| Claude Code | `ExitPlanMode` | plan | TUI plan dialog | `PermissionRequest` hook → `allow` with `updatedInput` (echoed input) / `deny` with feedback | Supported (live, 2.1.327) |
| Claude Code | `EnterPlanMode` (outside auto/plan mode) | confirm | TUI confirm, when Claude asks | same hook: yes → `allow` with `updatedInput` | Relayed as a confirm if asked (unit test); in 2.1.327 manual mode it entered plan mode with no prompt (live) |
| Claude Code | MCP elicitation | form | TUI form | `Elicitation` hook | Not relayed |
| Claude Code | `OfferChromeSetup`, `ShowOnboardingRolePicker`, `PublishPlugin`, `SendToProject`, `SetGoal` | – | host cards (desktop / Cowork) | – | Not relayed: host-specific, 0 uses in 200 local sessions |
| Codex | exec / patch approvals | permission | TUI | – (only the turn-starting client can answer) | Unsupported: shown read-only from the rollout (`exec_approval_request`, `apply_patch_approval_request`) |
| Codex | `request_user_input` (Plan mode) | question | TUI picker | – (no hook; app-server request to the turn-starting client only) | Unsupported: shown read-only ("Waiting for an answer in the terminal") from the unanswered call in the rollout |
| Codex | MCP elicitation, "Implement this plan?" | form / plan | TUI | app-server / TUI only | Not relayed |
| OpenCode | Permission prompt (any tool) | permission | TUI | daemon polls `GET /api/session/:id/permission`, answers `POST …/permission/:rid/reply {decision: once \| always \| reject}` | Supported (live, 2.2.5) |
| OpenCode | `question` | question | TUI form | daemon polls `GET /api/session/:id/form`, answers `POST …/form/:fid/reply {answer}` (dismiss: `DELETE …/form/:fid`) | Supported (live, 2.2.5) |
| omp | `ask` (HTML form) | question | TUI form dialog | extension wraps `ctx.ui.formDialog`; the form is parsed with omp's own parser into typed questions | Supported (live, 18.22.2) |
| omp | Tool approvals | permission | TUI | extension wraps `ctx.ui.approve` (`once` / `session` / `deny`) | Supported (live, 18.22.2) |
| omp | Plan review (`xd://propose`) | plan | TUI overlay | `plan_review_requested` → `ctx.resolvePlanReview` | Supported (live, 18.22.2) |
| pi, omp | Extension dialogs (`ctx.ui.select/confirm/input/editor`) | select / confirm / input | TUI dialog | extension wraps the method, races the local dialog | Supported (unit tests; same path as `ask`, which is live-verified) |
| pi | No built-in ask or approval tool | – | – | – | Nothing to relay |
| Cursor, Gemini CLI | – | – | – | – | Pull only; CLIs not installed here |

Local usage (counts only): Claude `AskUserQuestion` 102 and `ExitPlanMode` 29 in the last 200 sessions; OpenCode `question` 33; omp `ask` 17 in 300 sessions; Codex and pi samples too small to count.

## Claude Code

All of Claude's interactive tools ask through the same permission check, so one `PermissionRequest` hook (`pulsar hook claude-permission`) relays them. The Claude driver classifies the call by tool name (`interactions.classify`) and turns the app's answer into the hook's decision (`interactions.decide`).

Verified on 2026-11-17 in a scratch tmux session (Claude Code 2.1.327, auto, plan and bypass-permissions modes):

- **AskUserQuestion**: `{"behavior":"allow","updatedInput":{...tool_input,"answers":{"<question text>":"<label>"}}}` answers the question; the TUI card closes and the model gets `"<question>"="<label>"`. Multi-select answers join labels with `", "` and free text ("Type something") is the text itself (read back from real `toolUseResult` lines).
- **ExitPlanMode**: a bare `allow` (with or without `setMode`) leaves the plan dialog open. `allow` with `updatedInput` (the original `{plan, planFilePath}`) approves; Claude leaves plan mode to the mode from before. `deny` with a message rejects and the model reads the message ("Keep planning: …").
- **Terminal answers**: answering the card in the terminal does **not** kill the hook (as with "Yes" on a permission). The session record shows `status: "waiting"`, `waitingFor: "input needed"` while the card shows and `busy` after; the transcript's `tool_result` carries `permissionDecision.source: "user_temporary"`. Pulsar's existing probe uses both. Escape kills the hook within ~300 ms.
- **No allow-for-session or mode change** is offered for questions and plans.

## Codex (unsupported: shown read-only)

Codex sends approvals and `request_user_input` as app-server JSON-RPC requests only to the client that started the turn (its TUI is itself an app-server client); `serverRequest/resolved` tells the others. Its hooks (`PreToolUse`, `PermissionRequest`, …) cover exec approvals, but no hook event covers `request_user_input` or MCP elicitation, and "Implement this plan?" is TUI-only. Pulsar's Codex driver only queues messages (`codex queue`), so it never holds those requests and can't answer them.

What Pulsar does instead: the rollout records the model's `request_user_input` call (and `exec_approval_request` / `apply_patch_approval_request` events) before the answer, so the daemon (`serverInteractions` in `src/harnesses/codex.ts`) shows an unanswered one as a read-only card, "Waiting for an answer in the terminal on <machine>", with the questions. `options`/`decide` refuse it; the card ends when the rollout records the answer. If Codex adds a hook or an outside answer API, `interactions` (daemon) and `web/src/harnesses/codex.ts` (app) are the slots.

## OpenCode

The daemon polls each active session's pending permissions and forms on OpenCode's own server (`serverInteractions` in `src/harnesses/opencode.ts`, every 1.5 s, only while someone could answer from the app). The global lists (`/api/permission/request`, `/api/form`) are scoped to one folder, so it reads `GET /api/session/:id/permission` and `GET /api/session/:id/form` per session from `session.active`. Answers go through `POST …/permission/:rid/reply` (`once`, `always` for Allow for session with OpenCode's `save` patterns as the rules, `reject` with the note) and `POST …/form/:fid/reply {answer: {q0: "<value>", q1: ["a","b"]}}` (labels mapped back to option values). A prompt that leaves the list was answered in the TUI. If `session.active` or a session's lists can't be read, open cards stay as they are. If a reply from the app fails, every open tab gets a `reply-failed` notice and the prompt opens a new card on the next poll (the first card keeps the decision the operator made). After a daemon restart, a prompt that still waits opens a new card too. The `question` tool is a form (`fields[].type` `string` or `multiselect`, `custom: true` for free text); v2.2.5 has no `question.*` events.

Verified on 2026-11-18 against a scratch OpenCode 2.2.5 server (temp `HOME`/XDG dirs, its own port, free model): a two-question form answered in the TUI first (card: answered locally); a multi-select question answered from the app (OpenCode got "Plum"); a shell permission denied from the app (the model read "Denied from the pulsar app"); two shell permissions allowed for session (both commands ran).

## pi and omp

The Pulsar extension already runs inside every pi and omp session. Both hosts give it `ctx.ui` with `select`, `confirm`, `input` and `editor` (and on omp `formDialog` and `approve`), each taking an `AbortSignal`.

- **omp plan review** has a real API: `plan_review_requested` → `ctx.resolvePlanReview(reviewId, choice, {feedback})`; `plan_review_resolved.by` says who answered.
- **omp approvals and `ask`**: no supported interceptor; `tool_approval_*` events are observe-only. In TUI mode the tools and extensions share one `ui` object, so replacing its methods relays them.
- **pi** has no ask or approval tool of its own. Dialogs from other extensions go through `ctx.ui`; `custom()` dialogs (for example the third-party `ask_user_question` overlay) cannot be relayed.

### Live verification (2026-11-18, scratch daemon with a temp `PULSAR_HOME`, answers signed with a soft passkey)

- omp 18.22.2 with only the worktree extension (`--no-extensions -e dist/extension.js`): `ask` radio and checkbox forms answered from the app (omp got "Blue", "Oolong"; its form closed); `ask` answered in the terminal first (the app card ended "Answered on <machine>"); tool approval (`--approval-mode=always-ask`) allowed from the app (the command ran); plan review: Escape in the terminal ended the card, "Refine" from the app sent its feedback as the next planning prompt, "Approve and execute" from the app ran the plan.
- Claude Code 2.1.327 with the worktree's `pulsar hook claude-permission`: AskUserQuestion (two questions, one multi-select) answered from the app; the same answered in the terminal first (answered-locally after ~1 s, through the session-record probe); ExitPlanMode approved from the app.

## How it fits together

- **Daemon** (`src/service/approvals.ts`, `src/service/interactions.ts`): the approvals table gained `kind`, `prompt`, `answer` and `source`. A hook (`approval.request`) or the extension (`interaction.ask`, `interaction.local`) opens one; it ends once (compare-and-set): a passkey-signed app answer, the local screen, or the timeout (540 s for permissions, 3540 s for questions and plans). The passkey challenge covers the answer's hash. Needs You, Web Push (opaque id only), audit and pool forwarding (`approval.options` / `approval.decide` with `answer`) are shared with permission prompts.
- **Harness adapters**: a driver's `interactions.classify` / `interactions.decide` (Claude, `src/harnesses/claude-interactions.ts`); the extension's `relayUi` and plan-review handler (`src/extension-interactions.ts`).
- **App**: `web/src/harnesses/<id>.ts` (title and per-kind renderer overrides, mirroring the daemon drivers) and `web/src/interactions/` (default renderers and the card shell that signs answers). Phone: the Ionic sheet; desktop: the dialog, with a notice in the conversation.
