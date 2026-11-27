# Agent Client Protocol sessions

Run `pulsar acp <provider>` in your project to start a managed session. Install the provider's CLI or adapter and put its executable on the launching machine's PATH. Sign in with the provider before starting the session. Pulsar uses the installed executable over stdio.

For Google Antigravity, install Antigravity CLI 1.5.0 or later and run these commands from a terminal on the machine that will run the agent. [Google Antigravity ACP documentation](https://antigravity.google/docs/cli/acp/)

```sh
agy acp --login
cd /path/to/project
pulsar acp antigravity
```

New sessions started from the Pulsar app use managed ACP when the provider's ACP executable and `pulsar` are on the launch machine's PATH. Claude Code, Codex, OpenCode, and pi also have direct integrations. If the app cannot find the ACP executable, it starts the original terminal harness. The picker shows the preferred mode that the machine's login shell found. OMP starts natively so you can steer active turns and message its subagents. Use `pulsar acp omp` for a managed OMP session.

**New agent** can set the model and reasoning effort before the first prompt on a managed launch. If the provider rejects the selection, Pulsar keeps the draft. Tests with Antigravity 1.5.18 and OpenCode 2.2.5 confirmed the selected settings on the first conversational request. Each provider also sent the prompt to its own title generator using a separate model.

Use `pulsar acp <provider> --resume <session-id>` when the provider supports reopening ACP sessions. Run it from the original project directory. Resume existing native sessions with their harness's own resume command. See [Harness support](adapters.md).

The slash menu in a managed Antigravity session includes commands from the provider and skills installed on the session machine. Select a skill and enter any arguments. When the provider has no corresponding slash command, Pulsar asks Antigravity to read and apply the installed skill. [Antigravity skill locations](https://antigravity.google/docs/skills)

Managed sessions can ask questions in the Pulsar app through ACP forms. Supported fields include text, choices, multiple selections, numbers, and yes/no. Pulsar also recognizes older Antigravity question requests. Stop closes any unanswered question for the current turn. [T3 Code Antigravity protocol reference](https://github.com/pingdotgg/t3code/blob/37d3d199/apps/server/src/provider/acp/AntigravityProtocol.ts)

Antigravity can send a reply or ask a question after the original prompt ends. Pulsar records that activity in the same transcript and shows the session as working until the reply ends. Late tool results keep their original tool names. [T3 Code Antigravity adapter reference](https://github.com/pingdotgg/t3code/blob/37d3d199/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts#L250-L261)

Mistral Vibe can start scheduled work after the chat becomes idle. Pulsar shows the scheduled prompt, reply, and any permission request in the same conversation. In a live test with Vibe 3.1.5, **Stop** cancelled a scheduled write before Vibe created the file.

When a managed provider announces ACP child sessions, Pulsar shows the child tree and a separate transcript for each child. Permission requests and questions appear in the child’s conversation and in Needs You. Stop is available on the session machine when the provider permits cancellation of that child. To send a message to a managed child, use its parent. [ACP subagents](https://agentclientprotocol.com/protocol/v1/subagents)

Normal messages wait for the current turn to finish. FYI messages stay in the inbox. An urgent message can join a running turn when the adapter advertises steering and supports returning unconsumed input to Pulsar. This is available with Codex ACP 2.12.0+ and Claude Agent ACP 0.110.0+. If the adapter returns the input, Pulsar sends it as a regular prompt once the current turn ends. [ACP steering contract](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/steering.md)

On November 26, 2026, 10 managed providers available on the test Mac initialized over ACP v1 in clean workspaces. Claude Agent ACP 0.110.0 and Codex ACP 2.12.0 advertised steering. Antigravity 1.5.16, OpenCode 2.2.5, Kiro 3.6.0, goose 1.61.0, Droid 1.20.0, Grok Build, Mistral Vibe 3.1.5, and pi-acp 0.0.35 did not advertise it. A live Claude Agent ACP test delivered an urgent message through Pulsar during an active turn against a local model fixture. A Linux test of Codex ACP 2.12.0 held a local model request open, sent an urgent message through Pulsar, and received an `acp-steer` delivery receipt before releasing the request. The model consumed the message and answered within the same native turn ID. The test Mac had failed to synchronize managed preferences during session creation. [Linux steering qualification](https://github.com/yocontra/pulsar/actions/runs/45973972669) OMP 19.1.1 also opened a managed session and answered a Pulsar message using a local model with the native Pulsar extension installed.

When an ACP agent or adapter reports its context window or a cumulative amount in US dollars, the session header shows those values. The cost label identifies the amount reported through ACP. An invoice comes from the provider. The Usage page groups token records from supported session logs by the time of each response. ACP context counters and cumulative session cost stay in the session header.

To check a local installation from this checkout, use `bun scripts/live/acp-smoke.ts <provider> --session-only`. Omit `--session-only` to send a normal Pulsar message to the idle session and verify its reply.

## Provider commands

<!-- acp-catalog:start -->
| Provider ID | Local command | Integration | Reference |
| --- | --- | --- | --- |
| `codewhale` | `codewhale serve --acp` | native | [CodeWhale](https://github.com/codewhale-hq/CodeWhale/blob/v0.10.4/docs/MCP.md) |
| `antigravity` | `agy acp` | native | [Google Antigravity](https://antigravity.google/docs/cli/acp/) |
| `cursor` | `cursor-agent acp` | native | [Cursor](https://cursor.com/docs/cli/acp) |
| `copilot` | `copilot --acp --stdio` | native | [GitHub Copilot](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) |
| `omp` | `omp acp` | native | [Oh My Pi](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/modes/acp) |
| `opencode` | `opencode acp` | native | [OpenCode](https://opencode.ai/docs/cli/acp/) |
| `autohand` | `autohand --acp` | native | [Autohand Code](https://docs.autohand.ai/integrations/acp-mode) |
| `fx` | `fx acp` | native | [fx](https://fx.sh/docs/using-fx/acp) |
| `hermes` | `hermes acp` | native | [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp) |
| `gjc` | `gjc acp` | native | [Gajae Code](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/acp-local-development.md) |
| `kiro` | `kiro-cli acp` | native | [Kiro CLI](https://kiro.dev/docs/cli/acp/) |
| `cline` | `cline --acp` | native | [Cline](https://github.com/agentclientprotocol/registry/tree/main/cline) |
| `goose` | `goose acp` | native | [goose](https://github.com/agentclientprotocol/registry/tree/main/goose) |
| `auggie` | `auggie --acp` | native | [Auggie CLI](https://github.com/agentclientprotocol/registry/tree/main/auggie) |
| `droid` | `droid exec --output-format acp-daemon` | native | [Factory Droid](https://github.com/agentclientprotocol/registry/tree/main/factory-droid) |
| `grok` | `grok agent stdio` | native | [Grok Build](https://docs.x.ai/build/cli/reference) |
| `kilo` | `kilo acp` | native | [Kilo](https://github.com/agentclientprotocol/registry/tree/main/kilo) |
| `kimi` | `kimi acp` | native | [Kimi Code](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp) |
| `mistral-vibe` | `vibe-acp` | native | [Mistral Vibe](https://github.com/mistralai/mistral-vibe) |
| `qwen` | `qwen --acp --experimental-skills` | native | [Qwen Code](https://github.com/agentclientprotocol/registry/tree/main/qwen-code) |
| `codebuddy` | `codebuddy --acp` | native | [Tencent CodeBuddy](https://github.com/agentclientprotocol/registry/tree/main/codebuddy-code) |
| `qoder` | `qodercli --acp` | native | [Qoder CLI](https://github.com/agentclientprotocol/registry/tree/main/qoder) |
| `claude` | `claude-agent-acp` | adapter | [Claude Code](https://github.com/agentclientprotocol/claude-agent-acp) |
| `codex` | `codex-acp` | adapter | [Codex](https://github.com/agentclientprotocol/codex-acp) |
| `pi` | `pi-acp` | adapter | [pi](https://github.com/svkozak/pi-acp) |
| `amp` | `amp-acp` | adapter | [Amp](https://github.com/tao12345666333/amp-acp) |
| `bob` | `bob acp` | native | [IBM Bob](https://github.com/agentclientprotocol/registry/tree/main/bob) |
| `corust-agent` | `corust-agent-acp` | native | [Corust Agent](https://github.com/agentclientprotocol/registry/tree/main/corust-agent) |
| `deepagents` | `deepagents-acp` | adapter | [DeepAgents](https://github.com/agentclientprotocol/registry/tree/main/deepagents) |
| `dimcode` | `dimcode acp` | native | [DimCode](https://github.com/agentclientprotocol/registry/tree/main/dimcode) |
| `dirac` | `dirac --acp` | native | [Dirac](https://github.com/agentclientprotocol/registry/tree/main/dirac) |
| `fast-agent` | `fast-agent-acp -x` | native | [fast-agent](https://github.com/agentclientprotocol/registry/tree/main/fast-agent) |
| `glm-acp-agent` | `glm-acp-agent` | native | [GLM Agent](https://github.com/agentclientprotocol/registry/tree/main/glm-acp-agent) |
| `kimchi` | `kimchi --mode acp` | native | [Kimchi](https://github.com/agentclientprotocol/registry/tree/main/kimchi) |
| `sigit` | `sigit` | native | [siGit Code](https://github.com/agentclientprotocol/registry/tree/main/sigit) |
| `stakpak` | `stakpak acp` | native | [Stakpak](https://github.com/agentclientprotocol/registry/tree/main/stakpak) |
| `poolside` | `pool acp` | native | [Poolside](https://github.com/poolsideai/pool) |
| `cortex-code` | `cortex acp serve` | native | [Snowflake Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-acp) |
| `minimax-code` | `code-acp acp` | adapter | [MiniMax Code](https://www.npmjs.com/package/@minimax-ai/code-acp) |
| `crow-cli` | `crow-cli acp` | native | [Crow CLI](https://github.com/crow-cli/crow-cli) |
| `muse-code` | `muse acp` | native | [Muse Code](https://github.com/agentclientprotocol/registry/tree/main/muse-code) |
<!-- acp-catalog:end -->

The Cursor CLI installer also provides the `cursor-agent` alias. Kiro uses the ACP engine selected in its settings. For Claude and Codex, install `@agentclientprotocol/claude-agent-acp` or `@agentclientprotocol/codex-acp`. The Codex adapter package includes a compatible Codex CLI. For pi or Amp, install the community adapter and put the provider CLI on PATH.

## Provider verification

Fast-agent ACP 0.10.66 completed two turns with a loopback model, stopped an active turn, and restored history after restart. An approved `list_agents` call returned the fast-agent session’s own Pulsar ID. DeepAgents ACP 0.1.7 and 0.1.45 completed two turns and stopped an active turn. Both adapters keep sessions in process memory and omit client-supplied MCP servers. Pulsar keeps their transcript available after exit and hides Resume.

Qwen Code 0.28.7 and goose 1.61.0 each completed two turns through Pulsar on macOS arm64 with a loopback OpenAI-compatible test server. The second reply required the first turn’s history. Both accepted `/status`, changed and restored the model and permission mode, and stopped an active turn. After a bridge restart, each resumed the same session ID and answered with its earlier history. Qwen also changed and restored reasoning effort. Goose offered only `off` for effort with `gpt-4o`.

Autohand Code 0.9.12 completed two managed turns with a local OpenAI-compatible endpoint. Its native ACP process retried the Pulsar MCP connection with newline framing, listed Pulsar tools, and called `list_agents`. The second model request contained the first answer.

fx 0.0.18, Hermes Agent 0.23.4 and Gajae Code 0.22.2 each accepted a message from Pulsar, returned a reply from local Qwen2.5-0.5B-Instruct through llama.cpp, and connected to Pulsar’s MCP server. For fx, configure your local model connection before starting the session. For Hermes, install the ACP and MCP extras and configure a model with a context window of at least 64K. With `hermes gateway run` active in the same profile, Hermes also completed two turns, stopped an active turn, and reopened the exact session after a bridge restart with the earlier model history. Gajae Code used its local provider configuration with permission prompts enabled. [Gajae Code provider setup](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/models.md) · [fx local model setup](https://fx.sh/docs/configure-fx/custom-model-connections) · [Hermes ACP setup](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)


Every listed executable initialized over ACP v1 on macOS arm64. In disposable sessions, Pulsar dispatched a slash command and returned a permission denial through five installed providers with a loopback model.

| Provider | Version | Command tested |
| --- | --- | --- |
| Claude Agent ACP | 0.110.0 | `/context` |
| Antigravity CLI | 1.5.18 | `/compact` |
| OMP | 19.1.1 | `/context` |
| OpenCode | 2.2.5 | `/compact` |
| GitHub Copilot with offline BYOK | 1.0.116 | `/context` |

Cursor required a signed-in CLI to create a session. Codex ACP 2.12.0 initialized and failed to synchronize managed preferences during session creation on this Mac. The native Codex app-server integration has separate live steering and stop checks.

The built-in list uses launch commands from provider documentation or the [ACP Registry](https://agentclientprotocol.com/get-started/registry). The registry checks whether its published distributions return authentication methods during the ACP handshake.

The November 24, 2026 audit covered all 46 registry entries. For npm-distributed CLIs, weekly downloads provided an additional adoption signal. CodeBuddy recorded 129,470 package downloads and Qoder recorded 22,076 for November 17–23. Download counts include repeat installations. [CodeBuddy downloads](https://api.npmjs.org/downloads/point/2026-11-17:2026-11-23/@tencent-ai/codebuddy-code) · [Qoder downloads](https://api.npmjs.org/downloads/point/2026-11-17:2026-11-23/@qoder-ai/qodercli)

Direct stdio checks on macOS confirmed ACP v1 initialization for Antigravity CLI 1.5.16 and OpenCode 2.2.5. On November 24, 2026, both completed a real text prompt through the Pulsar managed bridge. A separate Chromium check at iPhone 13 mini dimensions sent a prompt from the phone composer to OpenCode and displayed its reply. The Antigravity check ran from the operator’s signed-in Terminal and returned the expected marker. To repeat the check, run `bun scripts/live/acp-smoke.ts antigravity` from this checkout.

On November 26, 2026, five adapters passed live command and permission checks with disposable sessions and local models: Claude Agent ACP 0.110.0, Antigravity 1.5.18, OMP 19.1.1, OpenCode 2.2.5, and GitHub Copilot CLI 1.0.116. Each exposed commands and honored a denied permission request. Cursor still required sign-in.

Claude Agent ACP 0.110.0, pi ACP 0.0.35, and Amp ACP 0.13.0 created sessions. Codex ACP 2.12.0 completed two turns through Pulsar’s managed bridge on Linux. A local Responses endpoint returned the second answer only after receiving the first prompt, its answer, and the new message together. The command catalog exposed 13 commands, including `/status` and `/compact`. Pulsar changed `/model` from `gpt-5.5` to `gpt-6.2-sol` and back, then changed `/effort` from `medium` to `low` and back. The provider confirmed each selection. [Linux qualification](https://github.com/yocontra/pulsar/actions/runs/45973658142)

CodeBuddy 2.186.0 and Qoder CLI 1.1.97 returned ACP v1 during initialization. Each returned a session error in a fresh workspace without credentials.

On November 24, 2026, GitHub Copilot CLI 1.0.115 and Cursor CLI 2026.11.22-e9042b2 both initialized over ACP v1 on macOS arm64. In scratch workspaces, both returned `-32000 Authentication required` from `session/new`. The Pulsar managed bridge reported the sign-in requirement for each provider. Copilot also required authentication when the test supplied the existing GitHub CLI credential, and Cursor CLI reported that it was signed out. These two sign-in checks ended before prompt delivery. [GitHub Copilot CLI authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli) · [Cursor CLI ACP](https://cursor.com/docs/cli/acp)

In isolated macOS arm64 environments, Cline 3.0.75, Kilo 7.8.32, Qwen Code 0.28.4, Auggie 0.37.0, and Kimi CLI 1.52.0 all initialized over ACP v1. Kilo created a session. The other four returned `-32000 Authentication required` from `session/new`. Auggie requires terminal sign-in and reported no ACP authentication methods. These checks stopped after session creation. [ACP Registry distributions](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)

Cline 3.0.76 and Kilo 7.8.38 each completed two managed turns with an OpenAI-compatible model on loopback. The second request carried the first reply. Both accepted mode changes, stopped a pending turn, and reopened the same session ID with both replies in Pulsar. Cline exposed Act and Plan with one model choice. Its local provider setup used `cline auth` with `CLINE_PROVIDER=openai-compatible` and a dummy `CLINE_API_KEY` for the scratch ACP process. Kilo exposed six provider commands and two model choices. The second turn used the model selected via `/model`. [Cline ACP](https://github.com/cline/cline/blob/main/docs/usage/acp.mdx) · [Kilo compatible providers](https://kilo.ai/docs/ai-providers/openai-compatible)

Kiro CLI 3.6.0, goose 1.61.0, Factory Droid 1.20.0, Grok Build 1.0.92, and Mistral Vibe 3.1.5 initialized over ACP v1 on macOS arm64 using official distributions and temporary homes. Kiro, Droid, Grok, and Vibe returned authentication errors from `session/new`. Goose returned an internal error and its log identified the missing `GOOSE_PROVIDER` setting. The checks used fresh homes without credentials and ended at session creation. [Kiro installation](https://kiro.dev/docs/getting-started/installation/) · [goose release](https://github.com/aaif-goose/goose/releases/tag/v1.61.0) · [Droid CLI reference](https://github.com/Factory-AI/factory/blob/main/docs/reference/cli-reference.mdx) · [Grok installation](https://docs.x.ai/build/overview) · [Vibe installation](https://docs.mistral.ai/vibe/code/cli)

With a loopback OpenAI-compatible model configured, Mistral Vibe 3.1.5, Grok Build 1.0.92, and Kimi Code 2.8.1 each completed two managed turns, stopped an active request, and resumed the same ID. The next model request after resume included both earlier prompts and replies. Vibe and Kimi also changed and restored their permission modes. Grok advertised commands and model settings and did not advertise ACP modes. On this Mac, the Kimi npm launcher's Node runtime returned `EMFILE` from file watching. Running the same vendor package under Bun completed the check. [Vibe offline models](https://docs.mistral.ai/vibe/code/cli/offline-models) · [Grok custom models](https://docs.x.ai/build/settings) · [Kimi providers](https://moonshotai.github.io/kimi-code/en/configuration/providers.html)

Factory Droid 1.20.0 used the loopback model in ordinary `droid exec` and still required Factory sign-in to create an ACP session with the same configuration. Auggie 1.2.3 opened a managed session. Its terminal model selector listed no models with the scratch local configuration, and its ACP prompt returned an internal error before the loopback server received a request. [Droid custom models](https://docs.factory.com/model-independence/byok) · [Auggie 1.x release](https://www.augmentcode.com/changelog/auggie-cli-1-2-0-release-notes)

Additional session checks used DeepAgents ACP 0.1.7, Dirac 0.6.2, GLM Agent 1.17.1, siGit Code 1.7.10 and fast-agent ACP 0.10.66. Each created a session over stdio. Configure a model for fast-agent before starting it. IBM Bob 2.1.0, Corust Agent 0.6.0, DimCode 0.5.32, Kimchi 1.40.0, Stakpak 0.3.88 and Poolside 1.0.16 initialized and required authentication to open a session.

Snowflake Cortex Code 1.0.73 and Crow CLI 0.1.49 opened managed sessions. MiniMax Code ACP 0.7.9 initialized and requested terminal sign-in with `mcode login`.

CodeWhale 0.10.4 completed a managed turn with a loopback model, requested passkey approval for the Pulsar `list_agents` tool, and received its own registered ID from the tool. A fresh process reopened the same conversation and completed a follow-up with the prior history. Pulsar supplies its MCP server through a private copy of the CodeWhale user configuration for each launch. It removes the copy when the bridge closes. CodeWhale applies its usual trust checks to project servers. [CodeWhale MCP configuration](https://github.com/codewhale-hq/CodeWhale/blob/v0.10.4/docs/MCP.md)

Harn 0.10.202 rejected the Pulsar MCP server during session creation. The built-in catalog omits this version.

Muse Code 1.4.24 initialized and requested sign-in. Pulsar enables its experimental ACP mode for the provider process. Fast-agent also registered with Pulsar and started its MCP server with `FAST_AGENT_MODEL=codexplan`.


### Other providers in the Paseo catalog

These checks used temporary workspaces on macOS, with additional Ubuntu checks for Nova and VTCode. [Paseo catalog comparison](paseo-comparison.md)

| Provider tested | Result |
| --- | --- |
| Agoragentic 1.3.6 | Registered a session but ignored the supplied MCP server and returned a fixed tool-bridge response. |
| Hoplite 3.5.2 | Dropped client-supplied MCP servers. Sign-in remained incomplete. |
| Minion Code 0.1.45 | Failed to import its ACP dependency. Pinning the SDK to 0.12.1 let a test session register, but the provider did not start the supplied MCP server. |
| Nova 1.1.59 and 1.1.69 | On Ubuntu, both created distinct sessions and validated the registered local model endpoint. The first managed prompt failed before reaching that endpoint, and neither started the supplied MCP server. [Linux qualification](https://github.com/yocontra/pulsar/actions/runs/45976397233) |
| TRAE CLI 0.217.0 | Initialized over ACP. Creating a session required Enterprise SSO or a personal access token. The managed test ended before registration and prompt delivery. |
| VTCode 0.96.14 and 0.185.3 | Both completed two local-model turns with history. Neither started the supplied Pulsar MCP server. Separate workspaces received the same session ID, and a fresh process could not load the conversation by that ID. [Concurrent registrations](https://github.com/yocontra/pulsar/actions/runs/45975115916) · [Prompt, MCP and reload checks](https://github.com/yocontra/pulsar/actions/runs/45975615414) |
