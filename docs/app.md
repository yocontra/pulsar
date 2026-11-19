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

**Stop** (in the header, or Cmd-.) interrupts the agent's current turn after you confirm. It shows only when Pulsar can reach the agent this way; see [Stop](../README.md#stop) for each harness.

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

Pulsar reads the worktree with git and never writes to it: it takes no index lock, runs no external diff tools, textconv filters or fsmonitor hooks, shows only files `git status` lists (never ignored ones), and reads a new file only inside the repo and never through a symbolic link (a link shows its target). Diffs show file contents as they are; Pulsar redacts nothing. The same people who can read an agent's transcript can read its changes: you, from the app on any of your machines (the agent's machine reads them), and the agent itself. Tagged devices you allowed get nothing. An agent on a machine with an older Pulsar shows "update it to see changes".

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
| Cmd-. | Stop the open agent |
| Cmd-\ | Show or hide the changes panel |
| `[` / `]` | Previous / next changed file (in the panel) |
| Esc | Close |
| `?` | Help |

On Linux and Windows, Ctrl replaces Cmd.

## When something is wrong

The app says which: Tailscale is off on this device, the machine's Pulsar isn't running, or you're signed in to Tailscale as someone else. When the machine you opened goes to sleep, open another machine's address. `pulsar doctor` on a machine checks everything the app needs.
