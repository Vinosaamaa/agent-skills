# Agent Skills

A small public source of independently maintained agent skills. Each skill keeps its instructions, implementation, generated-fixture verification, and benchmarks together under `skills/`.

## Available skill

### lavish-transcript

Renders local Codex, Cursor CLI, and Pi JSONL transcripts into a temporary pixel-terminal Lavish review with bounded byte-cursor reads, explicit cumulative 40-block paging, timezone-correct day and genuine-prompt navigation, collapsed tools and diffs, near-live append availability, and strict internal-context filtering.

The renderer requires Node.js 22 or newer, `lavish-axi` on `PATH`, and the supported Agent Chrome commands at:

```text
~/.local/bin/launch-agent-chrome
~/.local/bin/agent-chrome-axi
```

User-requested reviews suppress default-browser opening, focus Agent Chrome through its launcher, open the exact returned Lavish URL through a nonblocking `agent-chrome-axi newpage` handoff, and wait for both navigation completion and the artifact's first-render receipt. Work Chrome is outside this workflow.

## Validate

```bash
npm run validate
npm test
npm run benchmark
```

All transcript tests and benchmarks use generated fixtures. No real transcript or generated review HTML belongs in this repository.

## Install or update one skill

```bash
node scripts/install-skill.mjs lavish-transcript
node scripts/install-skill.mjs lavish-transcript --check
```

The first command atomically stages the selected skill under `${CODEX_HOME:-~/.codex}/skills`; the second verifies byte parity without changing the installation.

Future skills may be added through independently scoped issues when their contracts and verification are defined. This repository does not provide an orchestration or plugin framework.
