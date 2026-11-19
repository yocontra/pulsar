# Federation (the pool)

Every Pulsar node of one Tailscale user links to every other one. Each node shares only its own agents, holds the others' agents in memory, carries messages and receipts between machines, and forwards user actions on a remote agent to that agent's home node. There is no relay and no pairing. Tailscale is the network, and `tailscale whois` is the identity.

A node takes part only while its agent mesh is on (`pulsar mesh on`; off by default). Code: `src/federation/`. The service sees the pool through `PoolView` (`src/service/pool.ts`).

## Membership

- **Discovery.** Every `discoverMs` (30 s), the daemon reads `tailscale status --json`. Candidates are:
  - online, untagged peers whose user login is the pool owner's;
  - tagged nodes that `pulsar mesh allow` let in.

  A `deny` entry overrides both. The daemon probes each candidate with `GET https://<DNSName>:<port>/fed/v1/hello`. A node that does not answer (a phone, a laptop without Pulsar) is probed again after a growing wait, up to 30 minutes.
- **Membership** lives in the daemon's store and is cached in memory. Entries match a node by its Tailscale stable id, not its name, so a renamed node stays denied and a node that takes a freed name gets nothing. An allow entry also remembers the login the node had (`tagged-devices` for a tagged node), and that login must still match.
  - Change it with `pulsar mesh allow|deny|forget <node>` and `pulsar mesh owner <login>`. Anyone on the machine may run a change, agents included; the daemon asks the person to confirm it first (Touch ID or the app's passkey, [presence.md](presence.md)) and applies it only then. Every change is audited and announced in open app tabs (`security` notice `pool-changed`).
  - `pool.json` in the state folder is only a display copy for doctor and setup. The daemon writes it and never reads it back.
- **Ports.** A node serves `/fed/v1` on its app port (`PULSAR_HTTP_PORT`, default 7337). A probe tries these ports in order and keeps the one that answers (never the `port` a hello names):
  1. the port it answered on before;
  2. this node's own port;
  3. 7337;
  4. the port the node gave in its `X-Pulsar-Fed-Port` header when it called.

  Two nodes on different non-default ports therefore link as soon as either can reach the other. The port is bound to the Tailscale node at first link: an answer on another port is refused and announced, even under a new machine id, until `pulsar mesh forget`. A known node that answers with a new machine id on its bound port (a reinstall) links, and the user gets a security notice. Requests go only to this tailnet's MagicDNS names (one label under its MagicDNS suffix, such as `tail1234.ts.net` or a Headscale `dns.base_domain`) under `/fed/v1/`.
- **Tagged nodes.** A tagged server has no Tailscale user, so it gets its pool owner from `pulsar mesh owner <login>` (kept in the store). It then serves its agents and the app like any other node. The owner's nodes must also `pulsar mesh allow <tagged node>`.
- **Setup and doctor** probe peers with the same `/fed/v1/hello` and the same parser. Each device line shows the Pulsar version, a non-default port, version skew, and, when the daemon runs, its link state (`linked`, or the reason it is not).

## Identity

`/fed/v1` is served on the same HTTPS server as the app and is mounted before the app's owner check. That server speaks HTTP/2 (the app's browsers) and HTTP/1.1 (chosen by ALPN), and identifies the connection either way. The handler identifies each connection with `whois` on its remote address. These callers pass:

- a node whose login is the pool owner's;
- a tagged node in `allow`.

All other callers get `403 not_in_pool`. The caller's machine id always comes from this node's own probe of that node, keyed by the `whois` node id. A request body cannot claim a machine id. If a node calls before it was probed, the daemon probes it inline, at most once per node every 10 s.

- **Machine-id binding.** A machine id is bound to the Tailscale node that first linked with it, in memory and in the `peers` table. A hello from another node that claims a bound id is refused, audited (`fed.conflict`) and announced (`pool-conflict`). Only `pulsar mesh forget` frees the id. A node that runs a new Pulsar (a new id) replaces its own old binding.
- **The user role is for the owner's own nodes.** Only a caller whose `whois` login is the pool owner may forward actions (`act`), follow transcripts (`/fed/v1/transcript`) or worktree changes (`/fed/v1/changes`), or deliver messages as the user (`from.kind = user`). An allowed tagged node is a peer only: its agents are listed, and they can message and receive receipts, but it can never act as the user.
- **Originators.** An `act` names who started it (`as.kind`): the user (the home node re-checks the owner login, and never treats them as verified), the operator at the forwarding node's terminal, or an agent there. The home node authorizes the action as that kind. An agent may ask, but it may not read another agent's transcript, stop others, or approve.
- **Senders.** A delivery may name as its sender only an agent the peer shares (in its registry stream) or its terminal operator. The stored name is the vouched one, never the frame's text.
- **Peer strings** (names, activity, branches, hello fields, receipts) lose control characters (C0, C1, zero-width, bidi) before they are stored or printed. An agent's machine is always the peer's own name, and a peer agent named `operator` or `user` shows as `operator-agent`. An approval's tool input is kept exact, because the app shows hidden characters visibly.
- **Limits per peer:**
  - 8 MB request bodies, read as they stream;
  - 4 registry streams and 16 transcript streams (changes streams count as transcript streams);
  - 5,000 agent records;
  - 600 forwarded actions a minute and 600 messages a minute;
  - rate windows pruned once they grow;
  - exponential backoff before the next snapshot when gaps repeat.

The caller becomes `Principal {kind: "peer", machineId, node}`. `authorize()` lets a peer do exactly the `fed.*` operations (`fed.hello`, `fed.digest`, `fed.subscribe`, `fed.deliver`, `fed.receipts`, `fed.act`), and nobody else may do them. A forwarded user action carries the original user (`login`, calling `node`). The home node checks that the login is its pool owner, then authorizes the action itself as that user (`send`, `transcript.read`, `stop`; through `authorizeForwarded`).

## Versions

`hello` returns `{fedProtocol: [min, max], features, pulsarVersion, machineId, name}`. Each side speaks the highest version in both ranges and sends it in the `X-Pulsar-Fed` header on every other request. A request whose version is outside this node's range gets `426 upgrade` with "upgrade Pulsar on <machine>", which names the older side. If the ranges do not overlap, the machine shows `link: "upgrade"` with the same reason. Messages for it wait in the outbox. A frame type that a node does not know gets `{ok: false, code: "unsupported"}`, and the rest of the batch still runs.

## Frames

**Down: `GET /fed/v1/stream?since=<bootId>:<seq>`** (Server-Sent Events) sends:

- `snapshot {bootId, seq, agents: FedAgent[]}`: all of this node's live agents;
- `delta {bootId, seq, upserts: FedAgent[], removes: string[]}`: one per change, `seq` increasing by exactly 1.

If `since` is still in the delta log (the last 500 deltas), the stream replays the deltas after it. Otherwise it sends a snapshot. Live deltas follow. `FedAgent` is the public agent record (no pid, session id or cwd) plus `needsYou`, `wake` (what a normal message would do) and `hasTranscript`. A change to `lastSeen` alone, within the same minute, sends nothing.

**Down: `GET /fed/v1/transcript?agent=&login=&node=`** sends `transcript {events}` for one local agent's live transcript, for the user named in the query.

**Down: `GET /fed/v1/changes?agent=&mode=&login=&node=`** sends `changes {summary}` for one local agent's worktree changes (the app's diff viewer) while it is open: the current summary first, then each one that differs. The same rule as transcripts (`transcript.read`) applies. An older node answers `unsupported`, and the app says to update it.

**Up: `POST /fed/v1/frames {frames: UpFrame[]}`** returns `{results}`, one result per frame, in order:

| Frame | Does | Answer |
| --- | --- | --- |
| `digest {digest}` | Heartbeat: the sender's `(machineId, bootId, seq, agentCount)` | The receiver's digest |
| `deliver {message, targets, from}` | One message for some of the receiver's agents (local ids). `from` is `{kind: "agent", id, name, harness, project}` or `{kind: "user", login, node}` | The receiver's receipts |
| `receipts {messageId, receipts}` | Receipt changes for a message the receiver sent | `ok` |
| `act {as, action}` | A forwarded user action: `transcript.page {agent, cursor}`, `transcript.image {agent, imageId}` (base64 bytes), `changes.summary {agent, mode}`, `changes.file {agent, mode, path}` (the diff viewer), `ask {question, selector}` (the receiver ranks its own agents with `service.ask.local`), or the relayed ceremonies `approval.options`, `approval.decide {…, assertion}`, `stop.options` and `stop {agent, assertion}` (see User authority) | The result |

## Registry sync and ordering

- Every `coalesceMs` (500 ms), each node diffs its live agents against what it last published. A non-empty diff becomes one delta with the next `seq`. `bootId` is random per daemon start, so a restart voids all earlier sequence numbers.
- Links are lazy. A heartbeat sends a node's digest up and gets the peer's digest back, every `heartbeatMs` (10 s, ±20% jitter) per peer. A node skips its heartbeat to a peer it heard from recently, so one exchange per period serves both sides. If the peer's `(bootId, seq)` differs from the copy held, the node opens the stream with `since`. A stream with no delta for `linkIdleMs` (2 min) closes. If the peer ends a stream itself (it restarted), the node checks digests again within about a second.
- **Gaps.** A delta whose `bootId` differs, or whose `seq` is not `held + 1`, closes the stream. The node then reopens it without `since` and gets a fresh snapshot. A delta at or below the held `seq` is a duplicate and is ignored.
- Remote agents are in memory only. Their id is the pool address `<machineId>/<localId>`. A local id never contains `/`. An agent gets `@machine` added to its name only when another agent in the pool has the same name. The local agent keeps its name. Selectors, `list`, `/tree`, `/agents`, `/facets`, `/search`, and the `agent` and `transcript` SSE topics span the pool. Each machine node has `link` (`local`, `tailnet`, `asleep`, `daemon-down`, `upgrade`) and a `reason`.

## Messaging

- **Send.** The sender's node resolves the selector once over the whole pool (`*` is every agent in the pool). It groups the remote targets by home machine and puts one outbox entry per peer: `{message, targetLocalIds}`. Each remote target gets a `queued` receipt at once, with detail "sending to studio", "waiting, studio is offline", "waiting, studio is asleep" or "waiting: upgrade Pulsar on …". Rate and broadcast caps apply once, on the sender's node, for the whole pool.
- **Receive.** The home node stores the message under the same id (`INSERT OR IGNORE`). It stores `fromId` as the sender's pool address and `origin_machine` as the sender's machine. A stored `fromId` therefore never resolves to a local agent, `cli:operator` or a local `user:` sender. The home node checks rate limits again: per machine-qualified sender, for broadcasts, and per peer (`peerSendsPerMinute`, 600). A `user` sender is accepted only if its login is the pool owner's. It is never tagged `[human operator - <name>]`: no frame confers operator authority, so it arrives framed "not verified as your operator" (see Sends below). The home node delivers through the normal router (inbound policy, inbox cap, waiting `ask`, push) and answers with its receipts. Later receipt changes (sent, delivered, read, replied) go back as `receipts` frames for 30 minutes. That tracking is in SQLite (`fed_tracking`, migration 3, an idempotent "ensure" step that also runs on every open, so it holds whatever order branches merged in), so it survives a restart. Each outbox entry also stores its sender frame, so a message queued before a restart still goes out as the user's, from the node the user sent it on.
- **Redelivery.** If a message id is already stored, the home node only reports the current receipts. It never pushes the message again. Redelivery of a tracked message after the recipient's session restarted is the home node's job ([delivery.md](delivery.md)): it holds the receipts and sees the sessions. Tracking for such a message lasts until it can no longer change, not 30 minutes. Peers with the `receipts2` hello feature get the new states (`acked`, `done`, `nacked`, `expired`, `dead`) with `attempt` and `result`; older peers get them mapped down (`acked` → `read`, `done` → `replied`, the rest → `failed`). A dead letter goes back as a `dead` receipt, and the origin node ends the sender's `ask` and writes the notice.
- **Ask** (`POST /api/v1/ask`, socket `lookup`) spans the pool. Each machine ranks its own agents from its own logs, the asking node merges the results by score, and remote matches carry pool addresses. Each peer has 1.5 s (`askTimeoutMs`). A slower or unreachable machine is left out: the answer then says `partial: true` and lists it in `missing`.
- **Pool-wide state.** `/attention`, the needs-you rollups and `wait idle:<agent>` cover remote agents. Their needs-you state and busy/idle changes arrive in deltas. `wait idle:` resolves when a delta moves the agent from busy to idle.
- **Replies.** `reply` to a copy from a peer sends the answer back to the sender's machine (`origin_machine`), whoever sent it: an agent, the user, or an agent that is offline now. On the origin node, the reply is a delivery with `replyTo`. It marks the parent receipt `replied`, settles `wait reply:` and goes to the blocked `ask` of the asker. A reply to the user is stored for the app's receipts view.

## User authority: only the home node grants it

`whois` identifies a machine, not the daemon on it. Any process on one of your machines can post `/fed/v1` frames as that machine. So **no frame confers user authority**:
- A forwarded user is never "verified".
- There is no signer field and no key sync.

Approving, a remote Stop, and the `[human operator]` tag need a WebAuthn assertion that the agent's home node verifies itself.

- **Relying party.** The RP id is the tailnet's MagicDNS suffix, which every node of the tailnet shares: `tail1234.ts.net` for `node.tail1234.ts.net`, and the `dns.base_domain` on Headscale (`mesh.corp.example`, never the broader `corp.example`). When the suffix is itself a public suffix under the Public Suffix List (`*.c.ts.net`) or a single label, browsers refuse it, so the RP id is the node's own name and passkeys work per node only. The `rpId` setting (`pulsar setup --rp-id`) overrides it; it must be the node's name or a domain above it, and not a public suffix. In dev mode it stays `localhost`. See [headscale.md](headscale.md).
- **Credentials are per node.** Each node registers its own passkeys (Prove Human in that node's app, from any device signed in to the tailnet as the owner). Passkeys and sessions are never synced over `/fed`. Each node uses its own random WebAuthn user id, so enrolling on a second node does not replace the first node's passkey on the phone.
- **Relayed ceremony.** The phone uses whichever node served the app (B). For a prompt or an agent on C:
  1. B asks C for options (`act: approval.options {id, decision}` or `stop.options {agent}`).
  2. C issues the challenge. It is bound to the purpose: for a prompt, the id, input hash, agent, answer and expiry; for a Stop, the agent. The allowed credentials are C's own.
  3. The browser signs with the shared RP id.
  4. B passes the raw assertion to C as opaque JSON (`approval.decide {id, decision, note, assertion}` or `stop {agent, assertion}`).
  5. C verifies everything itself: its own challenge, single use; its own credential; user verification; and the expected origin.
- **Expected origin.** The expected origin is exactly `https://<B's MagicDNS name>:<B's port>`. The name comes from Tailscale, and the port is bound at first link like the machine id. A frame never names it. A known node that answers on another port is refused, audited (`fed.port`) and announced, because a process on that machine could serve its own app on another port. An assertion made on `https://b…:9999` is refused.
- **Cost.** One Face ID per approval, as on one machine, and one per remote Stop. If C has no passkey for this device yet, B's app says to prove you're human in C's app.
- **Sends.** Sends to agents on other machines arrive framed "from the Pulsar app on <node> (not verified as your operator)". The home node has no proof of its own for a send, and a pool-wide broadcast arrives that way on every other node. A send to your own machine's agents with a passkey session there is framed as yours.
- **Sharing.** Each agent record carries its permission prompts: the pending ones, and those decided in the last two minutes (with the outcome). Each prompt includes the exact tool input, input hash, expiry and session rules. Other nodes show these prompts with pool-address ids in `/attention`, `GET /approvals/:id`, the SSE `approval` events and the needs-you counts, and send Web Push for them.
- **No one to answer.** If this node does not serve the app, or has no passkey of its own, a hook gets no decision at once and the agent's own prompt decides.
- **First answer wins** on the home node.

## Failure behavior

| Event | What happens |
| --- | --- |
| Peer misses `missed` (3) heartbeats, or requests to it fail | Link changes to `daemon-down`, or `asleep` if Tailscale lists the node offline. Its agents stay listed with state `offline` and wake `queued`. Queued receipts say why they wait |
| Peer comes back | The next heartbeat or probe succeeds. Link changes to `tailnet`, the outbox is due at once, and a stale digest pulls the stream |
| Delivery request fails | The entry retries with exponential backoff (1 s up to 60 s, jittered). After 24 h it fails with "<machine> stayed offline; not delivered" |
| Answer lost after the home node stored the message | The retry gets the same receipts. No second push |
| Peer refuses a delivery (`rate_limited`, `forbidden`, `bad_request`, `unsupported`) | The receipts change to `refused` with the reason. No retry |
| Home node unreachable during a forwarded action | `503 unreachable` with the machine's reason |
| Node denied, or not in the pool any more | The node is dropped from the pool with its agents. Its `/fed` requests get `403` |

## Scale

`test/federation-load.test.ts` (opt in with `PULSAR_LOAD_TEST=1`) links one real node to 299 simulated peers with 30 agents each, through the fake tailnet. The peers are not full daemons. On an M-series laptop, the run on 2026-11-17 gave:

| Step | Time |
| --- | --- |
| Discover, link and take 299 snapshots | ~0.3 s |
| `/tree` (machines) | ~14 ms |
| `/facets` (all facets) | ~14 ms |
| Selector page | ~7 ms |
| Dry run of `*` (9,000 agents) | ~11 ms |
| Real send of `*` | ~110 ms (9,000 receipts written) |
| Delivery to all 299 peers | ~150 ms, one batch per peer |
| 5 churn rounds (44,850 agent updates) | ~80 ms |
| 100 peer restarts resynced through gaps and snapshots | ~1.4 s |

## Open issues

- A remote transcript watched through the SSE `session` topic is followed as the pool owner on this node. The hub's shared topic has no single viewer.
- Passkeys are registered per node, so every machine with agents needs one before its prompts can be approved. With the shared RP id, the phone can then approve from any node's app. Passkeys enrolled before this change (RP id = the node's name) must be enrolled again.
- The shared RP id and the relayed ceremony are verified with a software authenticator, not yet in a real browser or phone. `scripts/live` is the check.
- Port binding is trust on first use, like the machine-id binding.
- Sends to another machine's agents are always "not verified as your operator" there (no per-home-node passkey session yet).
- Push subscriptions are per node.
- A phone subscribed to push on several nodes gets one notification per node for each pool-wide prompt.
- Tested only on an in-process fake tailnet, not on two real Tailscale nodes. The node-id join between `tailscale status` (`ID`) and `whois` (`StableID`) was checked against the real CLI output.
- The load test is one real node and 299 simulated peers, not 300 daemons.
