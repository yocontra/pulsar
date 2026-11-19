# Optimistic rendering in the app

The app must feel instant on a loaded Mac and a phone on cellular or a VPN.
Each user action falls into one of three groups:

- **Instant**: the action changes only local state, or the cache is patched
  at once and put back if the daemon refuses.
- **Pending**: the outcome is uncertain or matters for security. The app shows
  a pending state at once ("Sending…", "Allowing…", "Stopping…") and shows the
  outcome only when the daemon confirms it.
- **Not optimistic**: a ceremony the person must complete (Prove Human, a
  passkey, OS permission).

The code is in `web/src/data/mutations.ts`, `web/src/data/pending.ts` and
`web/src/data/prefetch.ts`. The tests are in `web/test/data.test.ts` and
`web/e2e/optimistic.e2e.ts` (the mock with injected latency and failures).

## Actions

| Action | Before | Now | Why |
| --- | --- | --- | --- |
| Send to one agent (open session) | "Sending…" under the composer. The send button was locked until the daemon answered. The message showed only when the harness echoed it | Instant: the bubble shows at once with "Sending…", on the side its echo will land (the operator's turn when proven, the app's line when not), and the box is free for the next message. One line under the bubble follows it: Sending… → Sent → Delivered → Read → Replied (receipts, session/DeliveryNote.tsx). A failure before the daemon has it keeps the bubble as "Not sent: reason · Retry · Delete"; a delivery failure says "Not delivered · Retry" | The echo replaces the bubble by Pulsar message id, with no duplicate bubble or note, whether it arrives before or after the response |
| Retry a failed send | Not available. The text went back in the box to send again, so a lost response could send twice | Same client id: the daemon sends it once | `SendRequest.clientId` |
| Send to a project, a machine, several ids | "Checking recipients…", then "Sending…" | The same, plus Retry on the inline error (same client id) | The daemon decides the recipients, so their number is not known first |
| Send to a subagent (direct or through its parent) | "Sending…" | Pending, as for several recipients | The subagent's echo goes to its own transcript. Through the parent, the echo is a rewritten body |
| Send to a harness with no shared transcript | "Sending…" | Pending | No echo would arrive to confirm a bubble |
| Broadcast builder Send | "Checking…", "Sending…"; a failure showed an error | Pending, the same, plus Retry on the error with the same client id | Who gets it is the daemon's answer |
| Ask "ask directly", "Resend" in receipts | Pending | Unchanged: pending, with no client id | These sends have no Retry, so a client id adds nothing yet |
| Allow / deny / answer a prompt (approval, AskUserQuestion, plan, confirm) | "Sending…" until the daemon answered | Pending: "Allowing…", "Denying…" or "Answering…". Then the outcome the daemon reports ("Allowed once", "Already answered: …"). Needs-you updates from the stream | The first answer wins: the terminal or another device can answer first. Never show "Allowed" before the daemon confirms it. The card shows its outcome from the stream, so removing the item early would unmount it |
| Stop (desktop) | "Stopping…" on the dialog button | Pending: "Stopping…" on the button and in the header status until the daemon answers. On `interrupted` the row goes idle everywhere at once | The turn can end by itself, and Face ID can be cancelled. An idle row before the answer would be wrong |
| Stop (phone) | Nothing until the result toast | A "Stopping…" toast at once that stays up, replaced by the result | The same |
| Revoke a passkey session, remove a passkey | Instant (already optimistic) | Unchanged | Low risk. Put back if the daemon refuses, and the list refetches after |
| Sign out (Prove Human sheet) | Waits for the revoke, then drops the token | Unchanged: pending | The revoke needs the token, so the token can only be dropped after the request |
| Prove Human, passkey registration | Ceremony | Unchanged: not optimistic | A ceremony |
| Notifications on/off | Switch disabled while it works | Unchanged: not optimistic | OS permission and Prove Human come first |
| Pin / unpin, sort, sidebar width, Appearance, show finished subagents | Instant | Unchanged: instant | Local state only (signals, localStorage, component state). No daemon call |
| Mark read, needs-you dismissals | No such action | n/a | Needs-you clears from the daemon's own state |
| Ask (who works on what) | Previous answer kept on screen | Unchanged | A read |
| Changes viewer refresh | Previous diff kept on screen | Unchanged | A read |
| Open an agent | Skeleton on every open, including a revisit | A cached transcript shows at once and the newest page refreshes it. Rows prefetch on hover, touch or focus | See "Navigation" |

## Navigation

- **Prefetch**: one delegated listener (`installPrefetch`) loads an agent's
  row and newest transcript page into the cache. On desktop it fires after a
  90 ms hover, on the phone on `touchstart`, and also on keyboard focus. It
  applies to every element with `data-agent` or `data-prefetch-agent`. At most
  two prefetches run at a time, and the same agent is not prefetched again for
  15 s. A prefetch adds no observer, so the stream subscription stays the same.
- **Revisit**: the session's transcript is in the query cache
  (`useTranscript`). An agent opened in the last 5 minutes shows its last-known
  transcript at once while it refetches. The skeleton shows only when nothing
  is cached. The newest page replaces blocks that changed while the session
  was closed, except blocks that live events updated during the fetch.

## Send in detail

1. The composer makes a client id (`newClientId`). `sendWithRollback` adds a
   `local:<clientId>` line to the transcript cache. The line state
   (`pending.ts`) is `sending`.
2. Sends to one agent go out in order.
3. The daemon accepts the send: the line's state changes to `sent` and its
   `pulsar.messageId` is set. A send waits at most 15 s for the one before
   it, because requests have no timeout.
4. The echo arrives (a transcript event with the same `pulsar.messageId`).
   `reconcileLocal` drops the local line. The echo can arrive first: the
   reconcile runs again when the message id is set. An echo that has no
   message id matches by text, unless another local line claims its id.
5. A failed line is never matched and never expires. A line in flight never
   expires. A sent line with no echo is removed after 10 minutes, because a
   busy agent or an offline machine echoes late. A text match never takes a
   real line that was already shown when the local line was added, so the
   same text sent twice does not match the first echo.
6. A send cancelled at Prove Human, or a 409 reconfirm, removes the line.

On the daemon, `SendRequest.clientId` makes a send idempotent:
`POST /send` with the same `clientId` from the same user within 10 minutes
returns the first result and sends nothing. A concurrent duplicate gets the
same in-flight result. A refused send is not remembered, so a retry tries
again. The daemon checks the client id before the resolve token, because a
retry reuses a token that the first attempt already used.

## Mock faults

`POST /api/v1/__mock/faults` with `{ rules, echoMs }` slows or fails
requests in the mock. Each rule has `method`, a `path` prefix, an optional
`count` (the first rule with requests left wins), and one or more of
these fields:

- `beforeMs`: wait before the request is handled.
- `afterMs`: handle the request, then wait. With this, the echo can arrive
  before the response.
- `fail`: return this status. The request is not handled.
- `failAfter`: handle the request, then return this status. This is a lost
  response.

The mock echoes a send to one live agent into its transcript as the
daemon frames it: the operator's turn when proven, the app's line when not.
`echoMs` delays that echo (default 0). `{}` clears all faults.
