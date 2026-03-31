# CCCP — Claude Code and Cmux Pipeline Reagent

## What this project is

A standalone TypeScript CLI that provides deterministic YAML-based pipeline orchestration for workflows built around Claude Code and cmux. It moves the "file-routing state machine" pattern out of Claude's context window and into code, solving context degradation on long runs.

## Build & test

```bash
npm install
npm test              # vitest — 158 tests, ~5s
npm run typecheck     # tsc --noEmit
npx tsx src/cli.ts    # run CLI in dev mode (use instead of `npm run dev`)
```

## Key commands

```bash
cccp run -f <pipeline.yaml> -p <project> [--dry-run] [--headless]
cccp resume -p <project> -r <run-id-prefix>
cccp dashboard -r <run-id-prefix>
cccp gate-server                          # MCP server for gate interaction
cccp init                                 # scaffold cccp.yaml + example pipeline
```

## Architecture

- **Pipeline YAML** → Zod-validated into typed `Pipeline` objects (`src/pipeline.ts`)
- **Types**: all domain types in `src/types.ts` (Pipeline, Stage, RunContext, PipelineState, StageState, etc.)
- **Stage types**: `agent` (single dispatch), `pge` (Plan-Generate-Evaluate cycle with retry), `human_gate` (approval gate)
- **Agent dispatch**: injectable `AgentDispatcher` interface (`src/dispatcher.ts`); default spawns `claude -p --output-format stream-json` (`src/agent.ts`)
- **PGE cycle**: planner -> evaluator (contract mode) -> generator -> evaluator (evaluation mode) -> regex parse `### Overall: PASS/FAIL` -> route (`src/pge.ts`, `src/evaluator.ts`). Planner and contract run once; generator/evaluator loop retries on FAIL. State passed by reference with `onProgress` callback.
- **State**: SQLite at `.cccp/cccp.db` via sql.js, atomic flush, stage-level + PGE-iteration-level resume (`src/state.ts`, `src/db.ts`)
- **Agent resolution**: multi-path search — flat files (`writer.md`) and directory agents with operations (`architect/agent.md` + `architect/plan-authoring.md`) (`src/agent-resolver.ts`)
- **MCP config**: named profiles with `extends` inheritance, per-agent `--strict-mcp-config` (`src/mcp/mcp-config.ts`, `src/config.ts`)
- **Gates**: `FilesystemGateStrategy` polls SQLite; MCP server exposes `cccp_gate_respond` tool; `GateNotifier` proactively elicits approval via MCP elicitation (`src/gate/`, `src/mcp/gate-notifier.ts`)
- **TUI**: Ink/React dashboard watches SQLite + stream logs (`src/tui/`)
- **Stream parser**: typed discriminated union for claude stream-json events (`src/stream/stream.ts`)
- **Logging**: injectable `Logger` interface (`src/logger.ts`) — ConsoleLogger, QuietLogger, SilentLogger
- **Context**: `buildRunContext()` constructs RunContext from CLI options (`src/context.ts`)
- **cmux**: set-status, set-progress, notify, log via cmux CLI wrapper (`src/tui/cmux.ts`)

## Project-agnostic design

CCCP ships **no agents and no pipelines**. It resolves agents from paths defined in the consuming project's `cccp.yaml`. Templates (contract, evaluation) are defaults that can be overridden.

## Conventions

- ESM (`"type": "module"`) — all imports use `.js` extension
- TSX files for Ink components (`src/tui/*.tsx`)
- Tests in `tests/` using vitest, named `*.test.ts`
- Temp files go to `os.tmpdir()` with `cccp-` prefix and UUID
- State files use atomic write (write `.tmp` then `rename`)
