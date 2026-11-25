# Hosted agents

Open **Hosted agents** from the Agents header. Pulsar reads up to 20 recent tasks per provider from each connected machine. It combines rows with the same provider and task ID. When a machine disconnects or a provider read fails, Pulsar can show its last observation with the corresponding status.

Search tasks by title, ID, or repository, or filter the list by provider. Open a task to read details from a selected machine. **Refresh** requests a new list from reachable machines. Each source shows when it was last checked.

Set up provider access on the Pulsar machine that will make the requests:

| Provider | Access | Hosted actions |
| --- | --- | --- |
| GitHub Copilot | Sign in with `gh auth login` and use a `gh` version with `agent-task`. The account and repository need Copilot coding agent access. | List, view, start on a GitHub repository. Starting may create a draft pull request. |
| Codex Cloud | Sign in with `codex login` using an account with Codex Cloud access. | List, view, start in a configured cloud environment on an explicit branch. |
| Cursor Cloud | Set `CURSOR_API_KEY` in the Pulsar daemon environment for the machine that will call Cursor. Use an API key with Cloud Agents access. | List, view, start on a GitHub repository and branch, send a follow-up to an idle agent. |

For a Cursor follow-up, load details from the machine you want to use. The follow-up form appears when that source reports the agent is idle.

Each machine uses its own provider credentials. The pool exchanges task summaries, requested task details, and request receipts. The selected machine verifies your passkey before it submits a task or follow-up. The prompt goes to the selected provider.

For local reads, run:

```sh
pulsar hosted copilot list
pulsar hosted codex view TASK_ID
pulsar hosted cursor list
```

If a submission returns an uncertain result, inspect the provider before submitting another request. Use **Check receipt** to read the stored result for the same request on the selected machine. Pulsar keeps uncertain requests in its local database and blocks another identical submission there. Check the original machine and provider before moving the request to a different machine. An explicit Cursor rejection such as an already active run allows a new request.

Provider references: [GitHub CLI agent tasks](https://cli.github.com/manual/gh_agent-task), [Codex Cloud CLI](https://github.com/openai/codex/tree/main/codex-rs/cloud-tasks), [Cursor Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints).

## Verification

On November 24, 2026, live reads passed for Copilot list and view and for Codex list. Integration tests exercised provider writes, passkey authorization, mesh routing and receipt recovery with simulated providers. Live hosted writes and live Cursor Cloud access still need qualification.
