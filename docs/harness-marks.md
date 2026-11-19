# Harness marks

The app shows which harness an agent runs in with that harness's mark, in
one color on a tinted square (`HarnessGlyph`, `AgentAvatar`). Each mark
lives in the harness's UI adapter, `web/src/harnesses/<id>.ts`, as SVG path
data drawn inline in `currentColor` (no external files, so it works under
the strict CSP). Colors come from the `--ds-h-<harness>-*` tokens and pass
AA in both themes.

| Harness | Source | License |
| --- | --- | --- |
| Claude Code | Simple Icons 16.36.0, `claude.svg` | CC0 1.0 |
| Cursor | Simple Icons 16.36.0, `cursor.svg` | CC0 1.0 |
| Gemini | Simple Icons 16.36.0, `googlegemini.svg` | CC0 1.0 |
| OpenCode | Simple Icons 16.36.0, `opencode.svg` | CC0 1.0 |
| pi | Simple Icons 16.36.0, `pi.svg` | CC0 1.0 |
| omp | the π of omp.sh's favicon (github.com/can1357/oh-my-pi) | MIT |
| Codex | drawn for Pulsar: a C around a prompt chevron | Pulsar's license |
| VS Code | drawn for Pulsar: angle brackets | Pulsar's license |

Simple Icons' CC0 covers the SVG data, not the trademarks. The marks are
used nominatively: they identify the product an agent runs in, show no
endorsement, and are not changed beyond color and size. OpenAI and Microsoft
publish no logo licensed for this use, so Codex and VS Code get original
marks. To add a harness, add its adapter with a `name` and an `icon`
(and a `--ds-h-<id>-*` token pair for its colors).
