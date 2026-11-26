# Agent Client Protocol sessions

Run `pulsar acp <provider>` in your project to start a managed session. Install the provider's CLI or adapter and put its executable on the launching machine's PATH. Sign in with the provider before starting the session. Pulsar uses the installed executable over stdio.

For Google Antigravity, install Antigravity CLI 1.5.0 or later and run these commands from a terminal on the machine that will run the agent. [Google Antigravity ACP documentation](https://antigravity.google/docs/cli/acp/)

```sh
agy acp --login
cd /path/to/project
pulsar acp antigravity
```

New sessions started from the Pulsar app use managed ACP when the provider's ACP executable and `pulsar` are on the launch machine's PATH. Claude Code, Codex, OpenCode, and pi also have direct integrations. If the app cannot find the ACP executable, it starts the original terminal harness. The picker shows the preferred mode that the machine's login shell found.

Use `pulsar acp <provider> --resume <session-id>` when the provider supports reopening ACP sessions. Run it from the original project directory. Resume existing native sessions with their harness's own resume command. See [Harness support](adapters.md).

When an ACP agent or adapter reports its context window or a cumulative amount in US dollars, the session header shows those values. The cost label identifies the amount reported through ACP. An invoice comes from the provider. The Usage page groups token records from supported session logs by the time of each response. ACP context counters and cumulative session cost stay in the session header.

To check a local installation from this checkout, use `bun scripts/live/acp-smoke.ts <provider> --session-only`. Omit `--session-only` to send a normal Pulsar message to the idle session and verify its reply.

## Provider commands

<!-- acp-catalog:start -->
| Provider ID | Local command | Integration | Reference |
| --- | --- | --- | --- |
| `antigravity` | `agy acp` | native | [Google Antigravity](https://antigravity.google/docs/cli/acp/) |
| `cursor` | `cursor-agent acp` | native | [Cursor](https://cursor.com/docs/cli/acp) |
| `copilot` | `copilot --acp --stdio` | native | [GitHub Copilot](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) |
| `opencode` | `opencode acp` | native | [OpenCode](https://opencode.ai/docs/cli/acp/) |
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

Every listed executable initialized over ACP v1 on macOS arm64. Antigravity and OpenCode also completed prompts.

The built-in list uses launch commands from provider documentation or the [ACP Registry](https://agentclientprotocol.com/get-started/registry). The registry checks whether its published distributions return authentication methods during the ACP handshake.

The November 24, 2026 audit covered all 46 registry entries. For npm-distributed CLIs, weekly downloads provided an additional adoption signal. CodeBuddy recorded 129,470 package downloads and Qoder recorded 22,076 for November 17–23. Download counts include repeat installations. [CodeBuddy downloads](https://api.npmjs.org/downloads/point/2026-11-17:2026-11-23/@tencent-ai/codebuddy-code) · [Qoder downloads](https://api.npmjs.org/downloads/point/2026-11-17:2026-11-23/@qoder-ai/qodercli)

Direct stdio checks on macOS confirmed ACP v1 initialization for Antigravity CLI 1.5.16 and OpenCode 2.2.5. On November 24, 2026, both completed a real text prompt through the Pulsar managed bridge. A separate Chromium check at iPhone 13 mini dimensions sent a prompt from the phone composer to OpenCode and displayed its reply. The Antigravity check ran from the operator’s signed-in Terminal and returned the expected marker. To repeat the check, run `bun scripts/live/acp-smoke.ts antigravity` from this checkout.

Claude Agent ACP 0.110.0, pi ACP 0.0.35, and Amp ACP 0.13.0 created sessions. Codex ACP 2.12.0 initialized, then reported an error while it loaded workspace requirements in the test environment.

CodeBuddy 2.186.0 and Qoder CLI 1.1.97 returned ACP v1 during initialization. Each returned a session error in a fresh workspace without credentials.

On November 24, 2026, GitHub Copilot CLI 1.0.115 and Cursor CLI 2026.11.22-e9042b2 both initialized over ACP v1 on macOS arm64. In scratch workspaces, both returned `-32000 Authentication required` from `session/new`. The Pulsar managed bridge reported the sign-in requirement for each provider. Copilot also required authentication when the test supplied the existing GitHub CLI credential, and Cursor CLI reported that it was signed out. Prompt delivery remains unverified for these versions. [GitHub Copilot CLI authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli) · [Cursor CLI ACP](https://cursor.com/docs/cli/acp)

In isolated macOS arm64 environments, Cline 3.0.75, Kilo 7.8.32, Qwen Code 0.28.4, Auggie 0.37.0, and Kimi CLI 1.52.0 all initialized over ACP v1. Kilo created a session. The other four returned `-32000 Authentication required` from `session/new`. Auggie requires terminal sign-in and reported no ACP authentication methods. These checks stopped after session creation. [ACP Registry distributions](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)

Kiro CLI 3.6.0, goose 1.61.0, Factory Droid 1.20.0, Grok Build 1.0.92, and Mistral Vibe 3.1.5 initialized over ACP v1 on macOS arm64 using official distributions and temporary homes. Kiro, Droid, Grok, and Vibe returned authentication errors from `session/new`. Goose returned an internal error and its log identified the missing `GOOSE_PROVIDER` setting. The checks used fresh homes without credentials and ended at session creation. [Kiro installation](https://kiro.dev/docs/getting-started/installation/) · [goose release](https://github.com/aaif-goose/goose/releases/tag/v1.61.0) · [Droid CLI reference](https://github.com/Factory-AI/factory/blob/main/docs/reference/cli-reference.mdx) · [Grok installation](https://docs.x.ai/build/overview) · [Vibe installation](https://docs.mistral.ai/vibe/code/cli)

Additional session checks used DeepAgents ACP 0.1.7, Dirac 0.6.2, GLM Agent 1.17.1, siGit Code 1.7.10 and fast-agent ACP 0.10.66. Each created a session over stdio. Configure a model for fast-agent before starting it. IBM Bob 2.1.0, Corust Agent 0.6.0, DimCode 0.5.32, Kimchi 1.40.0, Stakpak 0.3.88 and Poolside 1.0.16 initialized and required authentication to open a session.

Snowflake Cortex Code 1.0.73 and Crow CLI 0.1.49 opened managed sessions. MiniMax Code ACP 0.7.9 initialized and requested terminal sign-in with `mcode login`.

Autohand 0.9.12 requires a different MCP stdio frame format. Harn 0.10.202 rejected the Pulsar MCP server during session creation. VTCode 0.96.14 reused a session ID across unrelated workspaces. The built-in catalog omits these versions.

Muse Code 1.4.24 initialized and requested sign-in. Pulsar enables its experimental ACP mode for the provider process. Fast-agent also registered with Pulsar and started its MCP server with `FAST_AGENT_MODEL=codexplan`.
