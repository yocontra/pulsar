# Live test: two nodes and a phone

Scripts for a live run of pulsar 2 on real Tailscale: this Mac, a Linux container joined to the same tailnet, and an iPhone. Not shipped in the npm package.

| Device | Name |
| --- | --- |
| Mac | `contra-m2-mbp.taile9c930.ts.net` |
| Container | `pulsar-meshnode.taile9c930.ts.net` (Docker, Debian, Node 22, tailscaled, user `dev`, no systemd) |
| Phone | `iphone-13-mini` |

The app's port is 7337 on both nodes.

## Before you start

- Tailscale is up on all three, signed in as the same account, with MagicDNS and HTTPS certificates on.
- The Mac runs your real agents. Installing pulsar 2 on the Mac (step 2) upgrades your real pulsar: every agent switches to 2.0 on its next start, and `pulsar mesh on` installs the background service and the Claude Code approvals hook. `pulsar setup --uninstall` undoes it; reinstalling 1.4 is `npx pulsar@1.4.0 setup`.
- The checks message only the container's fake agents (tag `live-test`). Your real agents are listed, never messaged or stopped.
- Fake agents never run on the Mac: `fake-agents.ts` refuses to start without an explicit test `PULSAR_HOME` (not `~/.local/state/pulsar`), and on a Mac with your real HOME. Any throwaway daemon you start by hand needs a temp `HOME` and `PULSAR_HOME` and `PULSAR_NO_SCAN=1`; otherwise it finds your real Claude sessions and can push messages into them. Don't run `pulsar` CLI commands from inside an agent against a test daemon: they speak as that agent.

## Run order

1. **Container: install, set up, start.** From the repo:

   ```bash
   scripts/live/pack-and-push.sh        # 6 fake agents; pass a number for more
   ```

   It builds and packs this checkout, installs it in the container, gives user `dev` Tailscale operator rights (for `tailscale cert` and `whois`), runs `pulsar setup --yes --client none --mesh` as `dev` (no agents to configure there: only the command and the mesh), starts `pulsar daemon --service` in tmux session `pulsar` (no systemd: `mesh on` says so and goes on), and starts the fake agents in tmux session `fake`. Everything there uses its own state folder (`PULSAR_HOME=~/.pulsar-live`) with harness scanners off (`PULSAR_NO_SCAN=1`). Watch with `docker exec -it -u dev pulsar-meshnode tmux attach -t pulsar`.

2. **Mac: install pulsar 2** (this changes your real setup; see above):

   ```bash
   npm pack && npx ./pulsar-2.0.0.tgz setup
   ```

   Say yes when it asks about the agent mesh (or run `pulsar mesh on` afterwards). It checks Tailscale, gets the certificate, turns the app on, installs the launchd service and the approvals hook, lists the container as a device that runs pulsar, and ends with the URL and a QR code. `pulsar doctor --mesh` re-checks.

3. **Checks from the Mac:**

   ```bash
   bun scripts/live/checks.ts           # --no-pause skips the link-drop test
   ```

   - Both nodes answer `/hello` and list both machines in their pool tree.
   - The Mac lists the container's fake agents.
   - A Mac → container send gets its receipt and the `reviewer` agent's reply.
   - Ask on the Mac ("who is editing src/auth/session.ts") finds the container's `fixer` with "Edited src/auth/session.ts …".
   - The container agent's transcript, read through the Mac, has its history and the live lines it keeps appending.
   - Stop of a container agent without a passkey session is refused with 401 `session_required`.
   - A broadcast dry run to the fake agents counts them on `pulsar-meshnode`.
   - Link drop: `docker pause` the container, send, `docker unpause`; the Mac's outbox delivers and the reply comes back (up to 2 minutes).

## Phone steps

1. **Open the app.** Tailscale on. Scan the QR code from step 2 (or run `pulsar qr` on the Mac). It opens `https://contra-m2-mbp.taile9c930.ts.net:7337`. Both machines and their agents show.
2. **Add to Home Screen.** Safari: Share → Add to Home Screen. Open pulsar from the home screen from now on (notifications only work there).
3. **Get an enrollment code.** On the Mac, in your own terminal (not inside an agent): `pulsar passkeys add`, type back the word it shows, and note the code (valid 10 minutes). The app asks for it at the first approval (step 4).
4. **Approve a real Claude prompt.** In a Claude Code session on the Mac (default permission mode), ask for something that needs permission, e.g. "run `ls ~/Desktop`". The prompt shows in the app under Needs you with the exact command. Tap Allow once; the card asks for the code from step 3, then Face ID creates the passkey and signs the answer. Settings now lists the passkey. The terminal prompt closes and Claude runs the command. The terminal prompt stays answerable too: whichever answer comes first wins.
5. **Push.** In Settings, turn notifications on and allow them. Lock the phone, trigger another prompt on the Mac, and check that "Approval pending" arrives with no details in it. Tapping it opens the card.
6. **Confirm it's you.** Open a Mac agent's session and send it a message. The app asks for Face ID once (a passkey session: 7 days on the phone, kept across reloads only in the home-screen app; a Safari tab keeps it in memory), and the agent gets it as from you, not "not verified as your user". Settings → Confirmed browsers lists the phone. A session works only from the device that started it.
7. **Relayed ceremony check.** Open `https://pulsar-meshnode.taile9c930.ts.net:7337` in Safari on the phone and trigger a Claude prompt on the Mac. Its card shows here too (approvals span the pool). The relying party is the tailnet's domain, shared by every node, so the phone offers the Mac's passkey on this origin. Tap Allow once: the Mac issues the challenge for this page's exact origin, Face ID signs with the Mac's passkey, and the Mac verifies it and decides (first answer wins). Expected: no code is asked, the Mac's passkey signs, and the Mac's hook gets the answer.
8. **The container's own passkey.** Prompts and Stops for a container agent are verified by the container, with a passkey enrolled there. Get a code inside it (`docker exec -it -u dev pulsar-meshnode bash -lc 'PULSAR_HOME=~/.pulsar-live pulsar passkeys add'`; `-it` gives it the terminal the check needs) and enroll from this page. The phone now holds two passkeys, labeled by machine. Then open `reviewer` and tap Stop: Face ID for that Stop, the container verifies it, and the app reports "Stopped reviewer's turn". Before this step, that Stop fails: the container has no passkey yet.

## Cleanup

```bash
docker exec -u dev pulsar-meshnode bash -lc 'tmux kill-server; PULSAR_HOME=~/.pulsar-live pulsar setup --uninstall --yes'
pulsar mesh off           # on the Mac: leave the mesh, keep agent configs (or pulsar setup --uninstall)
```

## Headscale (self-hosted control server)

`scripts/live/headscale.sh` runs the same cross-machine checks on a Headscale tailnet, entirely in Docker on this Mac: a private internal network `pulsar-hs-net`, Headscale (pinned image) with TLS from a test CA and its embedded DERP relay, two Linux nodes (`pulsar-hs-a`, `pulsar-hs-b`) joined with pre-auth keys for user `ada`, and a tagged node (`pulsar-hs-tagged`). Pulsar from this checkout runs on both nodes with its own CA-issued certificates (`pulsar setup --cert --key --ca`), `PULSAR_HOME=~/.pulsar-live` and `PULSAR_NO_SCAN=1`. The checks start every request inside `pulsar-hs-a` (`VIA_CONTAINER`), since this Mac is not on that tailnet, and pause `pulsar-hs-b` for the outbox check.

```bash
scripts/live/headscale.sh            # up, install, checks, then remove everything (KEEP=1 keeps it)
scripts/live/headscale.sh up|install|checks|down
```

It never touches your tailnet or other containers, and removes only the objects it names. Generated files (the CA, configs, JSON samples, logs) go to `$HS_WORK`.
