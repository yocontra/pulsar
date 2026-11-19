# The Pulsar app

The app is served by every machine in your [agent mesh](../README.md#agent-mesh) (off until you run `pulsar mesh on`) at `https://<machine>.<your-tailnet>.ts.net:7337` (on Headscale, `https://<machine>.<base domain>:7337`). Any machine's address shows the whole pool. `pulsar ui` opens it on a computer; `pulsar qr` prints a QR code for your phone, and offers to turn the mesh on when it is off.

## Install it on your phone

1. Turn Tailscale on on the phone, signed in as you.
2. Open the address (scan `pulsar qr`).
3. Add it to the home screen. Safari: Share → Add to Home Screen. Android Chrome: menu → Install app.
4. Open it from the home screen. Notifications work only in the installed app (iOS 16.4 or later).

## The pool

The sidebar (the home screen on a phone) lists every agent as a tree: machines, then projects, then agents. A group shows a count only when agents there need you. A machine that can't be reached says why: asleep, daemon down, or an older Pulsar.

- **Needs you** lists agents waiting on you: approvals first, then agents that asked you something, newest first.
- **Filter** takes plain words (`auth`) or selectors (`project=apparish status=busy`).
- **Pin** a machine, project or agent to keep it at the top.
- Select several agents (`x` or Cmd/Shift-click) and press `b` to message only them.

## A session

Open an agent to watch its session live: your prompts, its replies and thinking (collapsed), tool calls as one line each (Edit and Write expand to a diff), code with highlighting, math, Mermaid diagrams, tables and images. Older events load with "Load earlier". Agent text is shown as text: raw HTML, scripts and remote images never run or load.

The composer at the bottom sends to this agent. Choose how urgent it is:

- **Interrupt now** (`urgent`): lands mid-turn where the harness supports it.
- **Next turn** (`normal`): waits for the current turn, wakes an idle agent.
- **Don't wake** (`fyi`): waits in the agent's inbox.

Receipts follow each send: handed over, in its conversation, read, replied. Replies show under the message.

**Attach files** with the paperclip (on the phone: Photo Library or Choose Files), by dropping files on the composer, or by pasting an image. A paste of 32 KB of text or more becomes a `.txt` file. Up to 10 files per message: images up to 10 MB, other files up to 25 MB. Each file uploads when you add it, after one Face ID / Touch ID check for the batch. Its tile shows its progress, and Retry if the upload fails. Send waits until every file is uploaded. Pulsar saves the files on the agent's own machine, readable only by your user, and deletes them after 7 days. The message names each file by its path, and the agent opens the files from there. Your message shows the files as chips.

**Mention a file**: type `@` to search the files in the agent's folder (what git tracks, plus new files it doesn't ignore). Use the arrow keys and Enter or Tab to insert `@path`. Mentions show as chips above the field, and Backspace deletes a mention in one step.

**Stop** (in the header, or Cmd-.) interrupts the agent's current turn after you confirm. While the agent works and your draft is empty, the composer's Send button turns into a red Stop button. Stop shows only when Pulsar can reach the agent this way; see [Stop](../README.md#stop) for each harness.

## Subagents

An agent that runs subagents (Claude Code tasks and agent-team members, Codex spawned threads, omp tasks, OpenCode child sessions) shows "3 subagents · 1 running" under its row in the sidebar, collapsed. Click it to list them, running ones first; a subagent started by another subagent sits under it. Click one to open its own transcript in the main pane, with the parent's name above it to go back. On a phone, the agent's page has a Subagents line under the title bar; tap it, then tap a subagent to open its page. In a parent's transcript, an expanded subagent card has **Open** to go to that subagent's page.

Subagents are not agents: they are never in the agent list, counts, selectors or broadcasts, and only their own page sends to them. The line above the composer says where a message goes:

- **OpenCode**: into the subagent's own session.
- **Claude Code, Codex, omp**: these harnesses give no way into a subagent, so the message goes to the parent agent, starting `For your subagent "<name>"`. Pulsar never says it reached the subagent.

The sidebar lists running and idle subagents. To also list finished ones, dimmed, turn on **Show finished subagents** in Settings (saved per device).

Limits: Codex subagents are listed only while Codex's app-server runs, and a Codex subagent with no rollout file has no transcript. OpenCode subagents have no transcript, and only direct children are listed. Claude Code workflow runs are not listed. pi has no subagents.

## Changes

**Changes** shows what the agent has dirty in its git worktree, live, like a diff beside your editor. On a computer it is a panel beside the conversation: the **Changes** button in the session header (with the number of changed files) or Cmd-\ opens and closes it. Drag its left edge to resize it. The app remembers both on this device; with no choice yet, the panel opens by itself in windows 1600 px wide or more. On a phone, the diff button in the agent's top bar ("Changes (N)") opens the file list, and a file opens its diff.

- **Working tree** compares the worktree with its last commit: staged, unstaged and new (untracked) files. **Branch vs base** compares it with where the branch left the default branch (`origin/HEAD`, else `main` or `master`): what the branch committed, plus uncommitted work.
- The header shows the repo, the branch and how far it is ahead of or behind its upstream.
- Each file shows its status (M modified, A added, D deleted, R renamed, C copied, T type changed, U conflict, ? untracked) and lines added and removed. Select a file to see its diff, side by side when the panel is wide. **Expand all** shows every file's diff in one scroll; each loads as you reach it. `[` and `]` (or the arrows) step through the files.
- Binary files and diffs over 512 KB show a note instead. The list shows at most 500 files.
- It updates as the agent works (after each edit or command, and every few seconds while open) and keeps your place.

The Changes view reads the worktree with git and never writes to it (only the git actions below do, when you ask): it takes no index lock, runs no external diff tools, textconv filters or fsmonitor hooks, shows only files `git status` lists (never ignored ones), and reads a new file only inside the repo and never through a symbolic link (a link shows its target). Diffs show file contents as they are; Pulsar redacts nothing. The same people who can read an agent's transcript can read its changes: you, from the app on any of your machines (the agent's machine reads them), and the agent itself. Tagged devices you allowed get nothing. An agent on a machine with an older Pulsar shows "update it to see changes".

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

## Usage

**Usage** shows how many tokens your agents used and what that would cost at API prices. Open it with the chart button in the sidebar header (on a phone, on Home's top bar), from Cmd-K, or with Cmd-U.

- Pulsar reads the session files Claude Code, Codex, pi and omp write on each machine (including subagents, counted toward their session) and sums every machine in the pool. A machine that is offline or runs an older Pulsar is listed with the reason and left out.
- Pick a period (24h, 7d, 30d, 90d) and **Cost** or **Tokens**. Narrow the view to one machine or one harness from the line at the top.
- The big number is the total, with the number of sessions. Below it, each harness's share. The chart shows each harness per day (per hour for 24h); point at it for the numbers.
- **Totals** splits the tokens: processed, cached input, uncached input, output, and what cache reads saved. **Breakdown** lists models or days; click a model for its trend, cache hit rate and cost per million tokens.
- Cost is an **API estimate**: list prices per million tokens, not what a subscription charges. Set a model's price from its sheet (**Set price**), or all prices from **Model prices…** in the machine menu. Prices apply to every machine and to all past usage. A model with no price (for example a Codex or third-party model) is left out of the cost and named under the info button.
- Usage updates every minute while the page is open; the refresh button reads new lines first. It keeps 90 days.

In a session's header (on a computer), a short line shows the session's cost so far and, when the harness reports its context window (Codex), "Context: 42% used".

## New agent

Start an agent on any machine from the app: the pen button in the sidebar header (on a phone, + on Home), Cmd-Option-N, Cmd-K "New agent", "New agent in…" in Cmd-K or a project's right-click menu. A draft opens where a session would: pick the project and machine in the headline ("Add path…" takes any folder there), then the harness and the workspace under the message box. Harnesses that machine doesn't have are marked "Not found". **New worktree** makes a git worktree next to the repo on a new branch from the base branch you pick. Send says why it can't start yet ("Choose a base branch before creating a worktree.").

Starting needs a proven human (another machine asks for its own passkey check). Pulsar starts the harness in a new tmux session on that machine through your login shell, with its normal command and no extra flags, then shows each step: setting up the worktree, starting, waiting for the agent. Your first message goes out once the agent is connected and ready; nothing is typed earlier. If the new terminal asks something first (Claude Code's or Codex's "trust this folder"), the draft shows **Waiting in the terminal**: answer it on that machine (`tmux attach -t pulsar-…`), and the message goes out after that. Once the agent is up, its session replaces the draft, and Stop works on it. If it can't start, the draft says why and keeps your message.

## Approvals

An agent's permission prompt shows in Needs you and in its session as a card: the tool, every argument exactly as the agent sent it (spaces, tabs, newlines and hidden characters are marked), the folder and branch, and a countdown. Choose Allow once, Allow for session (the rules it adds are listed) or Deny with a note. The prompt also stays on the machine; whichever answer comes first wins, and the card says where it was answered.

Answering needs a proven human. Not proven yet, Prove Human opens inline: one passkey check (Face ID, Touch ID, Windows Hello or the device PIN; a first one makes the passkey, no codes), then your answer goes on. After that, prompts on this machine are answered without another check until the session ends: the answer goes with your session, tied to the exact prompt the card shows. A prompt on another machine still asks for the passkey check of that machine for each answer.

## Prove Human

You prove once, and the whole app knows it: the nav, Settings, sending as you, Stop, Ask directly and every prompt share one proven state, so nothing asks again while the session lasts (12 hours on a computer that runs Pulsar, 7 days on a phone or tablet). Every open tab of the same machine's app shares it, and a tab you open or reload while another is open is proven at once. On a computer, a reload with no other tab open asks again: the session is kept only in memory there (see [SECURITY.md](../SECURITY.md)). The installed phone app keeps it across reloads. Stopping an agent or answering a prompt on another machine asks for that machine's passkey check each time.

## Broadcast

Cmd-Shift-B (or Broadcast… on a phone) opens the builder. Pick values in the facets (machine, project, harness, model, branch, status, PR, role, tags) or type a selector; the match count and a preview update live, and each preview row says whether the message will wake the agent. **Dry run** shows who would get it, per machine. Sends to many agents ask you to confirm, and sending to everyone (`*`) asks you to type the count. Results stream in with receipts and replies.

## Ask

Cmd-K, then type `?` (or pick Ask): "who is editing src/auth/session.ts", "who has PR 1402", "what is codex@apparish doing", "who is idle on apparish". Answers come from what Pulsar already knows, with the evidence ("Edited src/auth/session.ts 4m ago", "branch fix-1378"); nobody is woken. Tick the agents to ask and press **Ask them directly** to send them your question and watch the replies, with who hasn't answered yet.

## Settings

The gear button opens Settings:

- **Show finished subagents**: list finished subagents too, on this device.
- **Notifications**: turn on "Approval pending" notifications for this browser.
- **Agent activity**: what happens when an agent you started, messaged or opened in the last 6 hours finishes its turn or stops with an error (an API error or a refused model, not a failing command): **Off**, **Notifications only**, **Sound only** or **Notifications with sound**. Notifications need this browser's notifications on; Sound only works without them. **In-app notifications** shows a short note in the corner while Pulsar is open, with **Open agent**; it closes when you open that agent. While Pulsar is in the background, the app icon and the tab title count what you missed. Kept on this device, and with its notifications on the machine that served the app. A finish on another machine reaches this browser too.
- **Passkeys**: every passkey on this machine, with Remove.
- **Confirmed browsers**: browsers that confirmed with Face ID / Touch ID recently (12 hours on a computer that runs Pulsar, 7 days on a phone or tablet), with Sign out. Sending as you, Stop, answering prompts and removing a passkey need this. Signing out a browser signs out all its open tabs.

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| Cmd-K | Search the pool; `?` switches to Ask |
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

The app says which: Tailscale is off on this device, the machine's Pulsar isn't running, or you're signed in to Tailscale as someone else. When the machine you opened goes to sleep, open another machine's address. `pulsar doctor` on a machine checks everything the app needs.
