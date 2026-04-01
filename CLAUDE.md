# CCCP — Claude Code and Cmux Pipeline Reagent

## What this project is

A standalone TypeScript CLI that provides deterministic YAML-based pipeline orchestration for workflows built around Claude Code and cmux. It moves the "file-routing state machine" pattern out of Claude's context window and into code, solving context degradation on long runs.

## Build & test

```bash
npm install
npm test              # vitest — 181 tests, ~5s
npm run typecheck     # tsc --noEmit
npx tsx src/cli.ts    # run CLI in dev mode (use instead of `npm run dev`)
```

## Key commands

```bash
npx @alevental/cccp run -f <pipeline.yaml> -p <project> [--dry-run] [--headless]
npx @alevental/cccp resume -p <project> -r <run-id-prefix>
npx @alevental/cccp dashboard -r <run-id-prefix>
npx @alevental/cccp mcp-server            # MCP server for gate interaction
npx @alevental/cccp init                  # scaffold minimal project
npx @alevental/cccp examples              # scaffold all agents + example pipelines
```

## Architecture

- **Pipeline YAML** → Zod-validated into typed `Pipeline` objects (`src/pipeline.ts`)
- **Types**: all domain types in `src/types.ts` (Pipeline, Stage, RunContext, PipelineState, StageState, etc.)
- **Stage types**: `agent` (single dispatch), `pge` (Plan-Generate-Evaluate cycle with retry), `autoresearch` (iterative artifact optimization), `human_gate` (approval gate)
- **Agent dispatch**: injectable `AgentDispatcher` interface (`src/dispatcher.ts`); default spawns `claude -p --output-format stream-json` (`src/agent.ts`)
- **PGE cycle**: planner -> evaluator (contract mode) -> generator -> evaluator (evaluation mode) -> regex parse `### Overall: PASS/FAIL` -> route (`src/pge.ts`, `src/evaluator.ts`). Planner and contract run once; generator/evaluator loop retries on FAIL. State passed by reference with `onProgress` callback.
- **State**: SQLite at `.cccp/cccp.db` via sql.js, atomic flush, stage-level + PGE-iteration-level resume (`src/state.ts`, `src/db.ts`)
- **Template agents**: 18 agents (7 directory + 11 flat) in `.claude/agents/`, usable both as Claude Code subagents and CCCP pipeline agents. Agent definitions are pure role/identity — pipeline-specific instructions (evaluation format, file I/O) are injected by the runner at dispatch time. Directory agents: `architect`, `product-manager`, `marketer`, `qa-engineer`, `strategist`, `designer`, `customer-success`. Flat agents: `researcher`, `reviewer`, `implementer`, `code-reviewer`, `copywriter`, `analyst`, `exec-reviewer`, `growth-strategist`, `ops-manager`, `devops`, `writer`.
- **Example pipelines**: 10 pipelines covering engineering (`feature-development`, `sprint-cycle`), product (`product-launch`), marketing (`content-calendar`), growth (`growth-experiment`), strategy (`quarterly-planning`, `business-case`), design (`design-sprint`), customer success (`customer-feedback-loop`), operations (`incident-runbook`).
- **Agent resolution**: multi-path search — flat files (`researcher.md`) and directory agents with operations (`architect/agent.md` + `architect/task-planning.md`) (`src/agent-resolver.ts`)
- **MCP config**: named profiles with `extends` inheritance, per-agent `--strict-mcp-config` (`src/mcp/mcp-config.ts`, `src/config.ts`)
- **Gates**: `FilesystemGateStrategy` polls SQLite; MCP server exposes `cccp_gate_respond` tool; `GateNotifier` proactively elicits approval via MCP elicitation (`src/gate/`, `src/mcp/gate-notifier.ts`)
- **TUI**: Ink/React dashboard watches SQLite + stream logs (`src/tui/`)
- **Stream parser**: typed discriminated union for claude stream-json events (`src/stream/stream.ts`)
- **Logging**: injectable `Logger` interface (`src/logger.ts`) — ConsoleLogger, QuietLogger, SilentLogger
- **Context**: `buildRunContext()` constructs RunContext from CLI options (`src/context.ts`)
- **cmux**: set-status, set-progress, notify, log, sendText, sendKey, newSplit via cmux CLI wrapper (`src/tui/cmux.ts`)

## npm package

Published as `@alevental/cccp` on npm. Install via `npm install @alevental/cccp` or use `npx @alevental/cccp <command>`. The `files` field ships `dist/`, `examples/`, `.claude/skills/`, and `README.md`. The `prepublishOnly` script runs typecheck + tests + build.

## Template agents and example pipelines

CCCP ships **18 template agents and 10 example pipelines** as starting points. `npx @alevental/cccp init` scaffolds a minimal project (4 core agents + 2 skills). `npx @alevental/cccp examples` scaffolds the full set. Agents live in `.claude/agents/` so they work both as Claude Code interactive subagents and as CCCP pipeline agents. Agent definitions are pure role/identity descriptions — pipeline-specific context (contracts, file paths, evaluation format) is injected by the runner. Projects resolve agents from paths defined in `cccp.yaml`.

## Skills

Two Claude Code skills ship in `.claude/skills/`:
- **`/cccp-run`** — CLI command reference, cmux pane management, gate interaction, MCP server registration
- **`/cccp-pipeline`** — Complete pipeline authoring reference with full schema, few-shot examples, and patterns. Designed for autonomous agent use (non-interactive).

## Conventions

- ESM (`"type": "module"`) — all imports use `.js` extension
- TSX files for Ink components (`src/tui/*.tsx`)
- Tests in `tests/` using vitest, named `*.test.ts`
- Temp files go to `os.tmpdir()` with `cccp-` prefix and UUID
- State files use atomic write (write `.tmp` then `rename`)
