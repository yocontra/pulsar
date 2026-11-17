# Security

## Reporting

Report vulnerabilities privately through [GitHub security advisories](https://github.com/yocontra/pulsar/security/advisories/new). Do not open a public issue.

## Model

pulsar connects processes that belong to one user on one machine. The trust boundary is your user account: any process running as you can talk to the daemon, just as it could read your files. pulsar keeps agents honest with each other; it does not defend against malware running as you.

- **Transport:** a Unix socket in `~/.local/state/pulsar` (folder `0700`, socket `0600`). Other users cannot connect.
- **Identity:** the daemon stamps every message with the sending connection's agent; a send request cannot set the sender. A connection declares which session it serves when it connects (same-user trust). `pulsar send` run from an agent's shell speaks as that agent, not as the human operator, and no agent can take the name `operator`.
- **Content:** delivered text says it comes from another agent, not the user, and that it cannot grant permissions or approve anything. Harness guardrails still apply. For example, Claude Code frames these messages as cross-session messages from a peer.
- **Claude permission parity:** pulsar never attests a permission mode for a sender. Users allow pulsar's messages into sessions that skip permission prompts through Claude's documented `crossSessionInbound` setting, which `pulsar setup` offers.
- **Limits:** message size, send and broadcast rates, and a queue cap for each recipient bound how much one agent can flood others.
- **Inbound policy:** each agent can set `accept`, `hold` or `refuse`.
- **Data:** messages are kept in a local SQLite file for 14 days. There is no telemetry. The only network call is `pulsar doctor`'s npm version check.

Prompt injection between agents is a real risk. Treat any agent's message as untrusted input, exactly as you would a web page.
