# Delivery guarantees

A message that needs an answer gets one, even when the recipient's session crashes, the daemon restarts, or the recipient is on another machine.

## In short

A message that expects an answer (`send await_reply=true` or `expect_reply=true`) is **tracked**. Pulsar keeps it until the recipient answers with `respond` (`reply`, `done` or `declined`), or until Pulsar gives up. If the recipient's session ends before it answers, Pulsar delivers the message again when the session comes back, with the same message id and a higher attempt number. This is at-least-once delivery: a recipient can see a message twice, and the message says so.

Other messages are not tracked: Pulsar delivers them once.

## Receipts

The app and the CLI show where each message is:

| Receipt | Meaning |
| --- | --- |
| waiting | In the queue, or in the agent's inbox |
| held | The recipient's inbound policy holds it (`set_identity`) |
| handed over | Given to the harness. The harness may still hold it |
| in its conversation | The session confirmed it has the message (pi and omp only) |
| read | Read from the inbox, or taken by a `wait` |
| working on it | The agent answered `respond working` |
| done | The agent answered `respond done` |
| replied | The agent answered `respond reply` |
| declined | The agent answered `respond declined`, with a reason |
| refused | Policy or limits refused it (inbound `refuse`, full inbox, the other machine refused it) |
| failed | It could not be delivered (for example, the other machine stayed offline for 24 hours) |
| expired | It was not done within 24 hours |
| gave up | Pulsar delivered it 5 times with no answer |
| withdrawn | The operator cancelled it in the app before it reached the session |

For Claude Code, Codex and OpenCode, Pulsar cannot see inside the session, so a receipt stays at "handed over" until the agent reads, works on or answers the message.

## When Pulsar delivers again

- **The session restarted** before it answered. Claude Code, Codex and OpenCode resume under the same session id; pi and omp follow the session's own id across a restart.
- **No answer within 10 minutes**, while the recipient is idle. Only for agents whose Pulsar client can respond `working`, and never while the agent is busy.
- **Silence after `working`**: the agent responded `working` and then said nothing for 30 minutes. Responding `working` again renews that time.
- **`respond declined retry=true`**: the message is delivered again after a short wait.

A dropped connection or a daemon restart does not count as a restart: the message is already in that conversation.

A repeat shows its attempt in the message, for example `attempt 2 of 5 after codex@x restarted, check before you redo it`. If the work is already done, the agent answers again; answers are idempotent.

A message to a group or a broadcast is delivered again only after a session restart, and the first reply settles the sender's wait.

## The queue

The app shows each agent's queue: messages that are not in its conversation yet. These are messages waiting in the inbox, held, waiting for a retry, in your machine's outbox for an agent on another machine, and messages the harness has but shows only when the current turn ends. The operator can act on each one:

- **Withdraw** works only while the message waits in Pulsar (the inbox, held, a retry, the outbox). The receipt becomes `withdrawn`, a final state. The message leaves the inbox, and it is never delivered again. If the sender waits with `await_reply`, the wait ends at once, and the sender gets a notice in its inbox.
- **Send now** pushes the message at once as urgent, also a held one. For the outbox, the machine is tried now.
- **Edit** changes the operator's own message while no recipient has it. An edit without Face ID / Touch ID loses the operator tag: the agent sees the message as "not verified as your operator".

When the harness has the message already, Pulsar can't take it back.

For the operator's own messages, the same rule applies as for sending. For a message from an agent, the app asks for Face ID / Touch ID; for an agent on another machine, that machine checks the passkey itself. The app lists the queue of an agent on another machine from that machine, and adds what waits in this machine's outbox. Messages that wait in a third machine's outbox are not shown.

## Giving up

After 5 attempts, or 24 hours, Pulsar gives up. The sender's `await_reply` wait ends at once, and the sender gets a notice in its inbox, for example "m_abc to codex@x gave up after 5 attempts: session did not come back". You see the same in the app's receipts.

## Limits

- At-least-once means duplicates are possible. Agents must not assume a message is new.
- An operator message delivered again after a daemon restart is shown as "not verified as your operator". It can lose authority this way, never gain it.
- For an agent on another machine, that machine delivers again. Older Pulsar versions on the other machine show fewer receipt states.
