# CCCP — Claude Code and Cmux Pipeline Reagent

## What this project is

A standalone TypeScript CLI that provides deterministic YAML-based pipeline orchestration for workflows built around Claude Code and cmux. It moves the "file-routing state machine" pattern out of Claude's context window and into code, solving context degradation on long runs.

## Build & test

```bash
npm install
npm test              # vitest — 107 tests, ~5s
npx tsx src/cli.ts    # run CLI in dev mode (use instead of `npm run dev`)
```

## Key commands

```bash
cccp run -f <pipeline.yaml> -p <project> [--dry-run] [--headless]
cccp resume -p <project> -a <artifact-dir>
cccp dashboard -a <artifact-dir>
cccp gate-server                          # MCP server for gate interaction
cccp init                                 # scaffold cccp.yaml + example pipeline
```

## Architecture

- **Pipeline YAML** → Zod-validated into typed `Pipeline` objects (`src/pipeline.ts`)
- **Stage types**: `agent` (single dispatch), `pge` (Plan-Generate-Evaluate cycle with retry), `human_gate` (approval gate)
- **Agent dispatch**: `claude --bare -p ... --system-prompt-file ... --output-format stream-json` (`src/agent.ts`)
- **PGE cycle**: contract → generator → evaluator → regex parse `### Overall: PASS/FAIL` → route (`src/pge.ts`, `src/evaluator.ts`)
- **State**: `.cccp/state.json` with atomic writes, stage-level + PGE-iteration-level resume (`src/state.ts`)
- **Agent resolution**: multi-path search — flat files (`writer.md`) and directory agents with operations (`architect/agent.md` + `architect/plan-authoring.md`) (`src/agent-resolver.ts`)
- **MCP config**: named profiles with `extends` inheritance, per-agent `--strict-mcp-config` (`src/mcp-config.ts`, `src/config.ts`)
- **Gates**: `FilesystemGateStrategy` polls state.json; MCP server exposes `pipeline_status` / `pipeline_gate_respond` tools (`src/gate/`)
- **TUI**: Ink/React dashboard watches state.json + stream logs (`src/tui/`)
- **cmux**: set-status, set-progress, notify, log via cmux CLI wrapper (`src/tui/cmux.ts`)

## Project-agnostic design

CCCP ships **no agents and no pipelines**. It resolves agents from paths defined in the consuming project's `cccp.yaml`. Templates (contract, evaluation) are defaults that can be overridden.

## Conventions

- ESM (`"type": "module"`) — all imports use `.js` extension
- TSX files for Ink components (`src/tui/*.tsx`)
- Tests in `tests/` using vitest, named `*.test.ts`
- Temp files go to `os.tmpdir()` with `cccp-` prefix and UUID
- State files use atomic write (write `.tmp` then `rename`)
