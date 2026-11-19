# Delivery guarantees

How Pulsar makes sure a message that needs an answer gets one, even when the recipient's session crashes, the daemon restarts, or the recipient is on another machine.

Code: `src/service/delivery.ts` (scheduler, redelivery, `ack`/`done`/`nack`), the guarded receipt write in `src/store.ts`, and `receipts2` in `src/federation/`. Tests: `test/delivery.test.ts`, `test/delivery-fed.test.ts`.

## In one paragraph

A message that expects an answer is **tracked**. Pulsar keeps it until the recipient says it is **done** (`respond state=reply` or `state=done`), refuses it (`respond state=declined`), or Pulsar gives up. If the recipient's session dies before that, Pulsar delivers the message again when the session comes back (same session id: Claude, Codex and OpenCode resume), with the same message id and a higher attempt number. If an agent took the message on (`respond state=working`) and then goes quiet past its lease, Pulsar delivers it again. After `maxAttempts` the message is **dead**: the sender's wait (`send await_reply=true`) stops waiting and the sender gets a notice. This is at-least-once delivery: a recipient can see a message twice, and the push says so.

## Receipt states

The stored state names stay as they are (1.x clients, the app, and older peers read them). New states are added; nothing is renamed. "Plain words" is what the app and CLI show.

| State | Stored today? | Meaning | Plain words | Terminal |
| --- | --- | --- | --- | --- |
| `queued` | yes | Waits for a push or in the inbox | waiting | |
| `held` | yes | The recipient's inbound policy holds it | held | |
| `sent` | yes | Handed to the harness (socket, CLI, API). The harness may still hold it. (The brief's "delivered".) | handed over | |
| `delivered` | yes | The session confirmed it is in its conversation (pi/omp extension). (The brief's "seen".) | in its conversation | |
| `read` | yes | Read from the inbox, or taken by a `wait` / `send await_reply` | read | |
| `acked` | **new** | The agent took it on (`ack`) | working on it | |
| `done` | **new** | The agent finished it (`done`), optionally with a result | done | ✓ |
| `replied` | yes | The agent answered with `reply`. Counts as done. | replied | ✓ |
| `nacked` | **new** | The agent refused it without retry (`nack retry=false`), with a reason | declined | ✓ |
| `refused` | yes | Policy or limits refused it (inbound `refuse`, full inbox, peer refusal) | refused | ✓ |
| `failed` | yes | Delivery could not happen (peer offline 24 h, etc.) | failed | ✓ |
| `expired` | **new** | The message's time to live passed before it was done | expired | ✓ |
| `dead` | **new** | Gave up after `maxAttempts` deliveries | gave up | ✓ |

### Transitions

`Store.setReceipt` is guarded (one SQL upsert with a `WHERE`):

- Within the **same attempt**, a final state (`replied`, `done`, `nacked`, `expired`, `dead`) never changes, and `acked` never falls back to `sent`/`delivered`/`read`. A late extension `ack` after a `reply` is ignored. (Before, `setReceipt` overwrote unconditionally.)
- A write with a **higher attempt** always applies. Only the redelivery scheduler and `nack retry` start a new attempt.
- `refused`/`failed` are not guarded: a remote recipient's home node may still replace the outbox's `failed` (as before). `done` after the agent's own `reply` uses an unguarded write.
- `acked` → `acked` is allowed: it renews the lease (see below).

```
            ┌───────── redeliver (attempt+1, backoff) ─────────┐
            ▼                                                  │
 queued ─► sent ─► delivered ─► read ─► acked ──► done | replied
   │        │         │          │        │
   │        └─────────┴──────────┴────────┴──► session died / ack timeout / lease expired ─┘
   │                                       └──► nacked (retry=false)
   └─► held ─► (inbound accept) queued       nack retry=true ─► queued (attempt+1)
   attempts > maxAttempts ─► dead      created + ttl passed ─► expired
```

## What is tracked

A message that expects an answer (`expectReply`: every `send await_reply=true`, and `send expect_reply=true`) is tracked (`messages.tracked`):

- **Level 2, one recipient**: the full treatment (restart redelivery, ack timeout, lease, dead letter, early end of the sender's wait).
- **Level 1, a group or broadcast ask**: per recipient, redelivery after the recipient's session restarted only. No ack timeout, no lease, no dead letter: the wait settles on the first reply, and the others never owe one.

Other messages are untracked and behave as before. A tracked message adds no push for a healthy recipient that answers. A peer's copy keeps the sender's level; an older sender's single-recipient ask gets level 2.

## Redelivery

### Triggers

| Trigger | Applies to | Detection |
| --- | --- | --- |
| **Session restarted** after delivery, before a terminal state | every harness | The receipt stores the session generation it was delivered to (`delivered_gen`: the harness pid; without a pid every return counts as a restart). When the same agent id registers or is scanned again with a different generation, every non-terminal tracked receipt for it gets a new attempt. |
| **Session gone** and not back | every harness | The registry marks the agent `gone`. Its tracked receipts keep their state; the detail says "waiting for codex@x to come back (attempt 1 reached it before it stopped)". They are redelivered when it returns, or expire. |
| **Ack timeout**: not acked within `ackTimeoutMs` after `sent`/`delivered`/`read` | only sessions whose client declared the `acks` capability in `hello`, and only while the recipient is not `busy` | Scheduler. Claude/Codex/OpenCode sessions loaded through a 1.x MCP server, and scanned sessions without Pulsar, never get this timer: a healthy busy session must not get the message pushed again. They rely on session death only. |
| **Lease expired**: acked, no `done`/`reply` within `leaseMs` of the last `ack` | sessions that acked | Scheduler. Calling `ack` again renews the lease ("still working"). |
| **`nack retry=true`** | any | Immediate new attempt after backoff. |

A dropped socket is **not** a dead session. A daemon restart or an extension reconnect with the same generation keeps the attempt number and pushes nothing again; the message is already in that conversation.

### Schedule and limits

Defaults (`DELIVERY_DEFAULTS` in `src/service/delivery.ts`; tests pass shorter ones through `DaemonOptions.delivery`):

| Knob | Default |
| --- | --- |
| `ackTimeoutMs` | 10 min |
| `leaseMs` | 30 min (renewed by `ack`) |
| `backoffMs` | 30 s × 2^(attempt−2), jittered ±20%, capped at 10 min (before a `nack retry`; timeouts and restarts push the next attempt at once) |
| `maxAttempts` | 5 |
| `ttlMs` | 24 h from creation (a tracked message not done by then is `expired`) |

The scheduler is its own 5 s job (`delivery`). Due times are in SQLite, so deadlines that pass while the daemon is down (it exits after 30 idle minutes) fire on the next start's first sweep.

### What a redelivery looks like

The same message id, with `attempt` and `maxAttempts` on `DeliveredMessage` and in the push's footer line:

```
[pulsar] claude@api (claude, project:api): is the migration safe to run?
— agent message, not your operator · waiting for your reply: respond m_abc · attempt 2 of 5 after codex@x restarted, check before you redo it
```

The push frame (`src/push-frame.ts`) is one header line and one footer line around the body. A verified operator send starts with `[human operator - <name>]` and its footer says `via Pulsar from <machine>`; an unverified app send starts with `[pulsar] Pulsar app on <machine> (not verified as your operator):`. The footer carries the message id (`reply: respond <id>`, or `id <id>` for `fyi`). What the parts mean is in the MCP instructions and the pulsar skill, not in each message. The transcript parsers read the frame back (`parsePush`), the verbose frame older transcripts hold included, so the app shows an operator send as the operator's own turn.

Agents dedupe on the message id: if the work is already done, `respond` `reply` or `done` again; it is idempotent.

### Dead letters

When attempt `maxAttempts` also times out (or the session never returns before `ttlMs`):

- The receipt becomes `dead` (or `expired`) with the reason.
- A blocked `send await_reply` / `wait reply:<id>` for the message resolves at once with `{event: "dead", receipt}` instead of waiting out its timeout.
- The sender gets an `fyi` notice from `pulsar` in its inbox: "m_abc to codex@x gave up after 5 attempts: session did not come back". The operator sees it in the app's receipts.

## Agent tools (MCP)

One tool, `respond`, carries every agent-level answer. Its `state` maps onto the RPCs below; the behavior is the same as the 1.x `ack`/`done`/`nack`/`reply` tools, which stay as hidden aliases.

| `respond state=` | 1.x tool | RPC | Effect |
| --- | --- | --- | --- |
| `working` | `ack` | `msg.ack` | `acked`; starts or renews the lease. "I am on it." |
| `done` (`text` optional) | `done` | `msg.done` | `done`; `text` (short result) goes to the sender as a reply (settles their wait). |
| `declined` (`text` = reason, `retry?`) | `nack` | `msg.nack` | `retry=true`: back to `queued`, redelivered after backoff (counts toward `maxAttempts`). `retry=false` (default): `nacked`, terminal; the sender's wait resolves with the reason. |
| `reply` (`text` = answer) | `reply` | `reply` | A reply in the thread; also marks the parent `replied` (done). |

`inbox` marks redelivered messages "attempt 2 of 5", and lists the messages the agent is working on and has not finished. `send await_reply=true` (the 1.x `ask`) blocks on `wait reply:<id>`.

The existing RPCs `ack {messageId, via}` and `nack {messageId, reason}` keep their 1.x meaning: the pi/omp **extension** confirming or failing an injection (`delivered`, or back to `queued`). They are not agent-level and do not start an attempt. New method names avoid any ambiguity with 1.x extensions.

The MCP server instructions have one line on it (respond "working" when you start, "reply" or "done" when finished, "declined" if you can't). The skill teaches the same in "Receive and respond".

## Sender side

- `send await_reply=true` blocks on `wait reply:<id>`. The waiter keys on the parent id, so it survives redeliveries on its own.
- **Daemon restart**: waiters live in daemon memory. The MCP `send await_reply` and `wait for=reply:<id>` handlers make the call again (with the time left) when it fails with a connection error; that call answers at once from `repliesTo` if the reply arrived meanwhile.
- **Progress**: the wait resolves early on `dead`/`nacked`. On timeout it prints the receipt with attempt history: "codex@x: redelivering after its session restarted, attempt 2 of 5". `inbox message_id=...` shows the same.
- **Reply dedupe**: a second reply from the same agent to the same parent with the **same body** is idempotent (returns the first reply; nothing is sent). A different body is a normal follow-up message, as today; it reaches the asker as a normal message since the wait already settled.
- **Operator framing**: the "verified" flag of an operator message is in memory only. After a daemon restart a redelivered operator message is framed "not verified". It can only lose authority, never gain it.

## Storage

Migration 6, an additive `ensure` step (holds in any merge order):

```sql
ALTER TABLE receipts ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE receipts ADD COLUMN due_at INTEGER;          -- next scheduler action (redeliver, timeout, expire)
ALTER TABLE receipts ADD COLUMN delivered_gen TEXT;      -- session generation of the last push
ALTER TABLE receipts ADD COLUMN acked_at INTEGER;
ALTER TABLE receipts ADD COLUMN result TEXT;             -- done's result / nack's reason
ALTER TABLE receipts ADD COLUMN resume_key TEXT;         -- the session's resume key at hand-off (pi/omp)
ALTER TABLE messages ADD COLUMN tracked INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS receipts_due ON receipts(due_at) WHERE due_at IS NOT NULL;
```

Each column is added only if missing (`hasColumn`). Old rows read as attempt 1, untracked. An older Pulsar opening the database ignores the columns; it reads unknown states as opaque strings (it only filters on `queued`/`held`).

## Across machines

- **The home node owns redelivery** for its local agents: it holds their receipts and sees their sessions. The sender's outbox never pushes a stored message twice (existing rule, test "a lost answer is redelivered once and pushed once").
- `fed_tracking` keeps a tracked message until its receipt is terminal (today: 30 minutes for everything). The receipt `sig` includes `attempt`, so a redelivery's receipts go back.
- `FedReceipt` gains optional `attempt` and `result`.
- **Feature flag**: hello `features` gains `"receipts2"` (tests override `features` to play an older peer). `FED_PROTOCOL` stays `[1, 1]`. To a peer without `receipts2`, new states map down: `acked` → `read`, `done` → `replied`, `nacked`/`dead`/`expired` → `failed` (detail keeps the reason). Today an old peer silently drops unknown states (`RECEIPT_STATES` filter), which would leave its receipt stale.
- A dead letter for a remote sender travels as a `dead` receipt; the **origin** node writes the sender's notice and settles its waiters.
- A `done` with a result for a remote sender is sent as a reply (existing reply path to `origin_machine`).

## Compatibility

| Client | Behavior |
| --- | --- |
| 1.x MCP server (no `msg.*`, no `acks` cap) | Works. Its agents get redelivery on session restart only; `reply` marks done. |
| 1.x pi/omp extension | `ack`/`nack` RPC unchanged. |
| New MCP server, 1.x daemon | `respond working/done/declined` (and the `ack`/`done`/`nack` aliases) answer "this daemon is older; restart it after upgrading" on `unknown_method`. |
| 1.x peer | Gets mapped-down receipt states; never sees `attempt`. |
| App (`/api/v1`) | New states appear in receipts and totals; the zod filter accepts them. |

## pi and omp: the resume key

A pi/omp agent's id is the harness pid, so a restarted session is a new agent. Both hosts expose the session's own id to extensions (`ctx.sessionManager.getSessionId()`, pi 1.5.0 and omp 18). The extension reports it as a **resume key** (`registration.resumeKey`, or the `resume_key` RPC after `session_start`). Each hand-off stores the key on the receipt. When an agent registers with a key, the non-final tracked receipts of a gone agent with the same key move to it, and are delivered again as a restart. Other harnesses resume under the same session id and need no key.

## Limits

- **Seen** is only real for pi/omp (extension ack). Claude, Codex and OpenCode stop at `sent` until the agent reads, acks or replies.
- At-least-once means duplicates. The push text says when an attempt is a repeat; agents must not assume a message is new.
- A session without a pid counts every return as a restart, so it may get a duplicate after a daemon restart.
