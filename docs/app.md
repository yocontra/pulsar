# The Pulsar app

The app is served by every machine in your [agent mesh](../README.md#agent-mesh) (off until you run `pulsar mesh on`) at `https://<machine>.<your-tailnet>.ts.net:7337` (on Headscale, `https://<machine>.<base domain>:7337`). Any machine's address shows the whole pool. `pulsar ui` opens it on a computer; `pulsar qr` prints a QR code for your phone, and offers to turn the mesh on when it is off.

## Install it on your phone

1. Turn Tailscale on on the phone, signed in as you.
2. Open the address (scan `pulsar qr`).
3. Add it to the home screen. Safari: Share → Add to Home Screen. Android Chrome: menu → Install app.
4. Open it from the home screen. Notifications work only in the installed app (iOS 16.4 or later).

The open app updates itself when the machine's Pulsar is upgraded: it reloads into the new version when you are not typing, in a dialog or sending, and keeps the page and your unsent message. Until then, a "Pulsar updated" toast offers **Reload**.

## The pool

The sidebar (the home screen on a phone) lists every agent as a tree: machines, then projects, then agents. A group shows a count only when agents there need you. A machine that can't be reached says why: asleep, daemon down, or an older Pulsar.

- **Needs you** lists agents waiting on you: approvals first, then agents that asked you something, newest first.
- **Filter** takes plain words (`auth`) or selectors (`project=apparish status=busy`).
- **Pin** a machine, project or agent to keep it at the top.
- Select several agents (`x` or Cmd/Shift-click) and press `b` to message only them.

## A session

Open an agent to watch its session live: your prompts, its replies and thinking (collapsed), tool calls as one line each (Edit and Write expand to a diff), code with highlighting, math, Mermaid diagrams, tables and images. Older events load with "Load earlier". Agent text is shown as text: raw HTML, scripts and remote images never run or load. Web links open in a new tab. A link to a file path (`/Users/…/report.html`, `./src/a.ts`, `file://…`) is not a web page: click it to open the file in Changes when the agent changed it, or to copy the path.

A turn that edited files ends with "Changed 3 files +42 −7". Open it to list the files with their lines added and removed; click a file for its diff, or **Show all diffs** for the whole turn. It is built from the turn's edit tool calls (subagents' edits included), not from git, and shows once the turn ends.

The composer at the bottom sends to this agent. Choose how urgent it is:

- **Interrupt now** (`urgent`): lands mid-turn where the harness supports it.
- **Next turn** (`normal`): waits for the current turn, wakes an idle agent.
- **Don't wake** (`fyi`): waits in the agent's inbox.

Receipts follow each send: handed over, in its conversation, read, replied. Replies show under the message.

**Queued** messages show in a strip above the composer: messages to this agent, from you and from other agents, that are not in its conversation yet. Each one says why it waits and how long ago it was sent:

| State | Meaning |
| --- | --- |
| Waiting for idle | The agent's session has it and shows it when the current turn ends |
| Next turn | It waits in the agent's inbox (a Don't wake message, or an agent Pulsar can't push to) |
| Held | The agent holds its messages |
| Retrying | A push failed, or Pulsar delivers it again soon |
| Machine offline | The agent's machine can't be reached; your machine sends it when it is back |
| Sending | On its way to the agent's machine |

- **Cancel** withdraws it before the agent sees it. Its receipt says "Withdrawn". An agent that waits for an answer to it stops waiting and gets a note.
- **Send now** delivers it at once as Urgent (also a held one). For a message to an offline machine, it tries the machine again.
- **Edit** changes the text of your own message before it arrives.

Your own messages need no extra check, as for sending. Another agent's message needs Face ID / Touch ID; on another machine, that machine checks it. When the session already has the message, Cancel, Send now and Edit are off: use Stop to end the turn so it arrives now. On the phone, the strip starts folded: tap it to see the messages.

**Attach files** with the paperclip (on the phone: Photo Library or Choose Files), by dropping files on the composer, or by pasting an image. A paste of 32 KB of text or more becomes a `.txt` file. Up to 10 files per message: images up to 10 MB, other files up to 25 MB. Each file uploads when you add it, after one Face ID / Touch ID check for the batch. Its tile shows its progress, and Retry if the upload fails. Send waits until every file is uploaded. Pulsar saves the files on the agent's own machine, readable only by your user, and deletes them after 7 days. The message names each file by its path, and the agent opens the files from there. Your message shows the files as chips.

**Mention a file**: type `@` to search the files in the agent's folder (what git tracks, plus new files it doesn't ignore). Use the arrow keys and Enter or Tab to insert `@path`. Mentions show as chips above the field, and Backspace deletes a mention in one step.

**Dictate** with the mic: your words appear in the draft as you speak, with a timer on the mic; tap it again to stop, or press Esc to cancel and put the draft back. Your browser's own speech recognition hears you (it may use its maker's service); nothing goes through Pulsar. The mic shows only in browsers that can dictate.

**File links** in agent text (`src/a.ts`, or a full path like `/Users/you/repo/out/report.html`) open in the app. A file the agent changed opens in **Changes**; any other file inside the agent's folder opens in **Files**. A path outside the folder is copied ("Path copied"). Web links open in a new tab. A file path never opens as a web address.

**Stop** (in the header, or Cmd-.) interrupts the agent's current turn after you confirm. While the agent works and your draft is empty, the composer's Send button turns into a red Stop button. Stop shows only when Pulsar can reach the agent this way; see [Stop](adapters.md#stop) for each harness.

## Subagents

An agent that runs subagents (Claude Code tasks and agent-team members, Codex spawned threads, omp tasks, OpenCode child sessions) shows "3 subagents · 1 running" under its row in the sidebar, collapsed. Click it to list them, running ones first; a subagent started by another subagent sits under it. Click one to open its own transcript in the main pane, with the parent's name above it to go back. On a phone, the agent's page has a Subagents line under the title bar; tap it, then tap a subagent to open its page. In a parent's transcript, an expanded subagent card has **Open** to go to that subagent's page.

Subagents are not agents: they are never in the agent list, counts, selectors or broadcasts, and only their own page sends to them. The line above the composer says where a message goes:

- **OpenCode**: into the subagent's own session, while it is running or idle.
- **Claude Code, Codex, omp**: these harnesses give no way into a subagent, so the message goes to the parent agent, starting `For your subagent "<name>"`. Pulsar never says it reached the subagent.

The sidebar lists running and idle subagents, and its count line counts only those: an agent whose subagents all finished shows no line. To also list finished ones, dimmed, turn on **Show finished subagents** in Settings (saved per device). A subagent that finished more than a day ago is not listed or counted even then; its parent's transcript card still opens it.

A subagent is running only while it works, and idle only while it is alive and waiting; everything else is finished:

- **Claude Code**: a task is running until it returns, or until its log has no new record for 10 minutes. A teammate is alive only while it is a member of an agent team that its parent leads (Claude Code's `teams/<team>/config.json`); a teammate that the lead shut down, or whose team is gone, is finished. Activity is the time of a log's last record, not the file's change time (Claude Code adds records to every subagent log when a session resumes).
- **Codex, OpenCode**: a thread or child session that is not running is idle for 30 minutes after its last update, then finished.
- **omp**: a task with no exit record and no write for 10 minutes is finished.
- When the parent agent is gone, all its subagents are finished.

Limits: Codex subagents are listed only while Codex's app-server runs, and a Codex subagent with no rollout file has no transcript. OpenCode subagents have no transcript, and only direct children are listed. Claude Code workflow runs are not listed. pi has no subagents.

## Changes

**Changes** shows what the agent has dirty in its git worktree, live, like a diff beside your editor. On a computer it is a panel beside the conversation: the **Changes** button in the session header (with the number of changed files) or Cmd-\ opens and closes it. Drag its left edge to resize it. The app remembers both on this device; with no choice yet, the panel opens by itself in windows 1600 px wide or more. On a phone, the diff button in the agent's top bar ("Changes (N)") opens the file list, and a file opens its diff.

- **Working tree** compares the worktree with its last commit: staged, unstaged and new (untracked) files. **Branch vs base** compares it with where the branch left the default branch (`origin/HEAD`, else `main` or `master`): what the branch committed, plus uncommitted work.
- The header shows the repo, the branch and how far it is ahead of or behind its upstream.
- Each file shows its status (M modified, A added, D deleted, R renamed, C copied, T type changed, U conflict, ? untracked) and lines added and removed. Select a file to see its diff, side by side when the panel is wide. **Expand all** shows every file's diff in one scroll; each loads as you reach it. `[` and `]` (or the arrows) step through the files.
- Binary files and diffs over 512 KB show a note instead. The list shows at most 500 files.
- It updates as the agent works (after each edit or command, and every few seconds while open) and keeps your place.

The Changes view reads the worktree with git and never writes to it (only the git actions below do, when you ask): it takes no index lock, runs no external diff tools, textconv filters or fsmonitor hooks, shows only files `git status` lists (never ignored ones), and reads a new file only inside the repo and never through a symbolic link (a link shows its target). Diffs show file contents as they are; Pulsar redacts nothing. The same people who can read an agent's transcript can read its changes: you, from the app on any of your machines (the agent's machine reads them), and the agent itself. Tagged devices you allowed get nothing. An agent on a machine with an older Pulsar shows "update it to see changes".

## Files

**Files** shows the files in the agent's folder, read-only. On a computer, the folder button in the session header opens it in the main pane: a folder tree on the left, the open file on the right, and the path above (click a folder in the path to list it). Esc goes back. On a phone, **Files** in the agent's ••• menu opens it, and so does a file link; each folder and file opens as a page.

- Text files show with highlighting and line numbers (the first 1 MB; no highlighting past 256 KB). PNG, JPEG, GIF and WebP images show as images. Other files say what they are and their size.
- **Copy path** copies the file's full path on the agent's machine.
- **Open in Changes** shows when the file has uncommitted changes, and opens its diff.
- A file whose name looks like it holds secrets (`.env` files other than `.example` copies, keys and certificates such as `.pem` or `id_rsa`, `.npmrc`, `.netrc`, `credentials…`) is hidden until you tap **Show**. Pulsar reads it only then, and only for that file.
- Folders list what git tracks plus new files it doesn't ignore. A folder git ignores, or a folder outside any repo, lists what is in it.

Files opens any file inside the agent's folder, also files git ignores (an agent often links to its own output), but never a file in `.git`, never through a symbolic link that leads out of the folder, and never a path outside it. The same people who can read an agent's transcript can read its files: you, from the app on any of your machines (the agent's machine reads them), and the agent itself. Tagged devices you allowed get nothing. An agent on a machine with an older Pulsar shows "Update it to browse files".

## Commit, push and PR

The session header has the git actions for the agent's worktree. On a computer: **+N −M** (hover for each file; click to open Changes), the PR (**#N**, when the branch has one) and a split button. On a phone: the branch button in the agent's top bar opens a sheet with the branch, changes, remote and PR, and the same actions.

- The main button does the next useful thing: **Commit, push & PR**, **Commit & push**, **Push & create PR**, **Create PR**, **Push**, or **View PR #N**. The menu (the arrow) has **Commit…**, **Push** and **Create PR** on their own.
- An action that can't run says why: on a computer when you hover it, on a phone under the buttons. For example "Worktree is clean. Make changes before committing.", "Branch is behind upstream. Pull or rebase before pushing.", "Detached HEAD: check out a branch first." or "gh isn't logged in on studio."
- **Commit** opens a form: the branch, the changed files and a message. **Edit** lets you leave files out; only the files you keep go in the commit, and what the agent staged for other files stays staged. **Draft from changes** writes a message from the file names (no AI). **Commit on new branch** creates the branch first. On the default branch, Commit asks before it commits there.
- If the agent is working (or waiting on you), the app asks before it commits or pushes.
- While an action runs, the button shows its step and a timer. When it is done, the result shows in its place for a few seconds ("Pushed to origin/fix-1378", "Created PR #12"). If git or gh refuses, a notice shows their message: a rejected push, a failed hook, missing credentials.
- **Push** sets the upstream on the first push and never force-pushes. **Create PR** uses `gh` on the agent's machine (title and body from the commits), so that machine needs `gh` installed and logged in, and a GitHub remote.
- The PR card shows the PR's state, review status, checks and review comments, with a link to GitHub. **Ask {agent} to fix** sends the failing checks and comments to the agent; you can read and change the text first.

Each commit, push or PR needs a proven human (Prove Human, once per session) and is recorded in the audit log of the agent's machine. For an agent on another machine, that machine checks your passkey for each step: "Commit, push & PR" asks three times, and on an iPhone you tap **Confirm** before each next step.

## Issues

When an agent works on a GitHub issue, its session header shows the issue (**#N**) and its rows in the sidebar and on Home show **#N** before the activity. Click the chip to open the issue card: title, state, labels, assignees, the start of the description, and a link to GitHub. You can also right-click the agent in the sidebar and pick **Show issue #N**. On a phone, tap ••• in the agent's top bar (or long-press the agent on Home) and pick **Issue #N**; the card opens in a sheet.

Pulsar finds the issue, in this order:

- an `issue:N` tag the agent set itself with `set_identity`;
- the branch name: `fix-1378`, `issue-1378`, `issues/1378`, `1378-login-crash`;
- the issue the agent's PR closes ("Fixes #1378" in the PR body, or a linked issue);
- the first `#1378` (or a link to an issue of the repo) in the first message you sent in the session.

The card is read with `gh` on the agent's machine, so that machine needs `gh` installed and logged in. It only reads; it never changes the issue. To message every agent on an issue, use the selector `issue=1378` in Broadcast; agents can use it too.

## Review a PR

**Review** on the PR card opens the agent's PR in the app, with three tabs:

- **Summary**: the PR's description and its reviews.
- **Files**: each changed file's diff as GitHub has it, with review threads at their lines. Outdated threads show above the diff, and resolved threads are folded. On a computer, pick a file on the left and switch between split and unified. On a phone, tap a file to open it.
- **Checks**: failing checks first, each with a link to its run.

To comment on a line, hover it and click the comment button (on a phone, tap the line number), then write and press **Comment**. Under a thread, **Reply** answers it and **Resolve** (or **Reopen**) changes its state. **Submit review** sends a summary as **Comment**, **Approve** or **Request changes**. GitHub does not let you approve or request changes on your own PR, so the app turns those off when the agent's `gh` account wrote the PR.

These actions use `gh` on the agent's machine, as that machine's GitHub account. Each one needs a proven human and goes in the agent machine's audit log. For an agent on another machine, that machine checks your passkey for each comment, reply, resolve and review. If the PR gets new commits after you open it, a line comment is refused: reload and comment on the latest code. Text from GitHub shows as plain text.

## Usage

**Usage** shows how many tokens your agents used and what that would cost at API prices. Open it with the chart button in the sidebar header (on a phone, on Home's top bar), from Cmd-K, or with Cmd-U.

- Pulsar reads the session files Claude Code, Codex, pi and omp write on each machine (including subagents, counted toward their session) and sums every machine in the pool. A machine that is offline or runs an older Pulsar is listed with the reason and left out.
- Pick a period (24h, 7d, 30d, 90d) and **Cost** or **Tokens**. Narrow the view to one machine or one harness from the line at the top.
- The big number is the total, with the number of sessions. Below it, each harness's share. The chart shows each harness per day (per hour for 24h); point at it for the numbers.
- **Totals** splits the tokens: processed, cached input, uncached input, output, and what cache reads saved. **Breakdown** lists models or days; click a model for its trend, cache hit rate and cost per million tokens.
- Cost is an **API estimate**: list prices per million tokens, not what a subscription charges. Set a model's price from its sheet (**Set price**), or all prices from **Model prices…** in the machine menu. Prices apply to every machine and to all past usage. A model with no price (for example a Codex or third-party model) is left out of the cost and named under the info button.
- Usage updates every minute while the page is open; the refresh button reads new lines first. It keeps 90 days.

In a session's header (on a computer), a short line shows the session's cost so far and, when the harness reports its context window (Codex), "Context: 42% used".

### Limits

**Limits** on the Usage page lists the plan usage limits your harnesses reported on each machine: how much of each window is used and when it resets. Codex reports how much of each limit (for example the weekly one) is used. Claude Code, pi and omp only say when a limit is reached, so they show here only then, with when it was reached. A window drops off the list once it resets, and a reached limit drops off once that harness answers again (for example on extra usage or another model).

When an agent's harness is past a warning threshold, its session header shows it (for example "Weekly limit: 88%"; on a phone, "88%"). Tap it to open Usage.

Pulsar warns you when a limit passes 80% and 95%, and when one is reached: a note in the corner while Pulsar is open (if **In-app notifications** is on), and a notification on devices with notifications on. The notification says only that a limit passed a percent; Usage says which. Each warning comes once per limit window, and again after the window resets. A limit on any machine in the pool warns you; the same account on two machines warns once. Change the thresholds or turn warnings off in Settings → **Usage limits**.

## New agent

Start an agent on any machine from the app: the pen button in the sidebar header (on a phone, + on Home), Cmd-Option-N, Cmd-K "New agent", "New agent in…" in Cmd-K or a project's right-click menu. A draft opens where a session would: pick the project and machine in the headline ("Add path…" takes any folder there), then the harness and the workspace under the message box. Harnesses that machine doesn't have are marked "Not found". **New worktree** makes a git worktree next to the repo on a new branch from the base branch you pick. Send says why it can't start yet ("Choose a base branch before creating a worktree.").

Starting needs a proven human (another machine asks for its own passkey check). Pulsar starts the harness in a new tmux session on that machine through your login shell, with its normal command and no extra flags, then shows each step: setting up the worktree, starting, waiting for the agent. Your first message goes out once the agent is connected and ready; nothing is typed earlier. If the new terminal asks something first (Claude Code's or Codex's "trust this folder"), the draft shows **Waiting in the terminal**: answer it on that machine (`tmux attach -t pulsar-…`), and the message goes out after that. Once the agent is up, its session replaces the draft, and Stop works on it. If it can't start, the draft says why and keeps your message.

## Approvals

An agent's permission prompt shows in Needs you and in its session as a card: the tool, every argument exactly as the agent sent it (spaces, tabs, newlines and hidden characters are marked, hidden characters as red tags), the folder and branch, and a countdown. Choose Allow once, Allow for session (the rules it adds are listed) or Deny with a note. The prompt also stays on the machine; whichever answer comes first wins, and the card says where it was answered.

A card stays answerable for a day, also when Pulsar restarts. Codex prompts can be answered unless the session was started with `codex --no-daemon`.

Answering needs [Prove Human](#prove-human). If you haven't proven yet, the check opens in place, and your answer goes on after it.

## Prove Human

Your agents run with your permissions. An agent must never be able to approve its own actions, or send a message that looks like it came from you. So before the app acts as you, it asks for your device's check: Face ID, Touch ID, Windows Hello or the device PIN. The first check makes a passkey. There are no codes.

It asks before you:

- answer a prompt or a question;
- send a message as you (agents then see it as from you, not "not verified as your operator");
- stop an agent;
- start an agent;
- commit, push or open a PR;
- comment on, resolve or review a PR;
- upload attachments;
- turn on notifications;
- remove a passkey or confirm a pool change.

You prove once, and the whole app knows it. It lasts 12 hours in a computer's browser and 7 days on a phone or tablet. All open tabs share it. On a computer, a reload with no other tab open asks again. Settings → Confirmed browsers lists proven browsers, with Sign out.

Each machine checks for itself. An action on an agent on another machine asks for that machine's check each time: "Commit, push & PR" there asks three times. Messages to agents on another machine always arrive as not verified.

## Broadcast

Cmd-Shift-B (or Broadcast… on a phone) opens the builder. Pick values in the facets (machine, project, harness, model, branch, status, PR, role, tags) or type a selector; the match count and a preview update live, and each preview row says whether the message will wake the agent. **Dry run** shows who would get it, per machine. Sends to many agents ask you to confirm, and sending to everyone (`*`) asks you to type the count. Results stream in with receipts and replies.

## Ask

Cmd-K, then type `?` (or pick Ask): "who is editing src/auth/session.ts", "who has PR 1402", "what is codex@apparish doing", "who is idle on apparish". Answers come from what Pulsar already knows, with the evidence ("Edited src/auth/session.ts 4m ago", "branch fix-1378"); nobody is woken. Tick the agents to ask and press **Ask them directly** to send them your question and watch the replies, with who hasn't answered yet.

## Search messages

Cmd-K searches what you and your agents wrote, on every machine: type a word of 3 letters or more and matching messages show under **In messages**, each with the agent, a snippet ("You:" for your own words, "Agent:" for the agent's) and when it was written. On a phone, tap the search button on the Agents screen. Choosing a message opens its session at that message, with the find bar open.

In a session, **Find** opens the find bar. It searches all of the session that search covers (below), not only what is on screen. Enter or the **Next match** button goes to the next match, Shift-Enter or **Previous match** to the previous one, and Esc closes it. Older messages load as needed.

Search covers prompts, replies, messages between agents and the titles of tool calls from the last 30 days. It doesn't cover tool output, thinking or subagents, and for a long session that was already running when search started, only its most recent part (about 5,000 events). To keep it from storing a copy of your transcripts, see `PULSAR_NO_SEARCH` in [docs/adapters.md](adapters.md).

## Diagnostics

**Diagnostics** runs `pulsar doctor` on every machine in the pool and shows the results in one place. Open it from Cmd-K ("Diagnostics", or type "doctor"), or from Settings → **Diagnostics**.

- Each machine runs the checks itself, the same ones `pulsar doctor` prints in its terminal: the daemon, each harness, approvals, remote access, Tailscale, certificates, the background service and the other devices. Each check is passed (✓), a note (·) or a problem (✗). A problem shows how to fix it.
- Under each machine's name: its Pulsar version, how long its daemon has run, event-loop delay, live agents, Tailscale state and version, when its certificate expires, and each harness's version.
- When machines run different Pulsar versions, a note at the top says which machines to upgrade. A machine too old to answer says so.
- A machine that is asleep or offline is listed with the reason.
- This machine shows first; each other machine fills in as it answers, with "Checking…" until then. A machine that doesn't answer within 35 seconds says so. Results are a few seconds old at most; **Check again** runs the checks again on every machine now.
- Diagnostics only reads. Before a machine sends its report, it replaces home folder paths with `~` and removes anything that looks like a token or password.

## Settings

The gear button opens Settings:

- **Show finished subagents**: list subagents that finished in the last day too, on this device.
- **Notifications**: turn on "Approval pending" notifications for this browser.
- **Agent activity**: what happens when an agent you started, messaged or opened in the last 6 hours finishes its turn or stops with an error (an API error or a refused model, not a failing command): **Off**, **Notifications only**, **Sound only** or **Notifications with sound**. Notifications need this browser's notifications on; Sound only works without them. **In-app notifications** shows a short note in the corner while Pulsar is open, with **Open agent**; it closes when you open that agent. While Pulsar is in the background, the app icon and the tab title count what you missed. Kept on this device, and with its notifications on the machine that served the app. A finish on another machine reaches this browser too.
- **Usage limits**: warn when a plan usage limit passes a threshold or is reached (on by default, at 80% and 95%). On a computer, type up to three percents; on a phone, pick a set. Kept on the machine that served the app, for every device on it.
- **Diagnostics**: opens Diagnostics, the checks of every machine.
- **Passkeys**: every passkey on this machine, with Remove.
- **Confirmed browsers**: browsers that confirmed with Face ID / Touch ID recently (12 hours on a computer that runs Pulsar, 7 days on a phone or tablet), with Sign out. Sending as you, Stop, answering prompts and removing a passkey need this. Signing out a browser signs out all its open tabs.

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| Cmd-K | Search the pool and messages; `?` switches to Ask |
| Enter / Shift-Enter | Next / previous match (in the find bar) |
| `/` | Filter the tree |
| `j` / `k` | Move down / up |
| `h` / `l` | Collapse / expand |
| Enter | Open |
| `n` | Next agent that needs you |
| `x` / Space | Select an agent |
| `b` | Message the selection |
| Cmd-Shift-B | Broadcast |
| Cmd-Option-N | New agent |
| Cmd-. | Stop the open agent |
| Cmd-\ | Show or hide the changes panel |
| Cmd-U | Usage |
| `C` / `T` | Cost / Tokens (on the usage page) |
| Cmd-Shift-1…4 | Usage period: 24h, 7d, 30d, 90d |
| `[` / `]` | Previous / next changed file (in the panel) |
| Esc | Close |
| `?` | Help |

On Linux and Windows, Ctrl replaces Cmd.

## When something is wrong

The app says which: Tailscale is off on this device, the machine's Pulsar isn't running, or you're signed in to Tailscale as someone else. When the machine you opened goes to sleep, open another machine's address. `pulsar doctor` on a machine checks everything the app needs; **Diagnostics** shows the same checks for every machine.
