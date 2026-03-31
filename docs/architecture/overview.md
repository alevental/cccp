# CCCP Architecture Overview

## What CCCP is

A standalone TypeScript CLI that provides deterministic YAML-based pipeline orchestration for workflows built around Claude Code and cmux. It replaces Claude-as-state-machine with code-as-state-machine.

## Core components

### Pipeline loader (`src/pipeline.ts`)
Reads YAML pipeline definitions and validates them against a Zod schema. Produces typed `Pipeline` objects with discriminated union stage types.

### Stage types
- **`agent`** — Dispatch one agent via `claude -p`, collect output file
- **`pge`** — Plan-Generate-Evaluate cycle: dispatch planner -> dispatch evaluator (contract mode) -> dispatch generator -> dispatch evaluator (evaluation mode) -> parse `### Overall: PASS/FAIL` -> retry generator/evaluator loop on FAIL up to max_iterations
- **`human_gate`** — Block pipeline until approved via MCP tool call or state file edit

### Agent dispatch (`src/agent.ts`)
Each agent runs as a separate `claude --bare -p` subprocess with:
- `--system-prompt-file` — the agent's markdown definition
- `--output-format stream-json` — for real-time event streaming
- `--strict-mcp-config` — only the MCP servers the agent's profile specifies

### Agent resolver (`src/agent-resolver.ts`)
Resolves agent names to file paths by searching configured directories. Supports:
- **Flat file agents**: `writer.md`
- **Directory agents with operations**: `architect/agent.md` + `architect/plan-authoring.md`
- Search path priority: pipeline-local → project `.claude/agents/` → project `agents/` → config paths

### PGE engine (`src/pge.ts`, `src/evaluator.ts`)
The Plan-Generate-Evaluate cycle:
1. Dispatch **planner agent** -- reads plan document + codebase, writes `task-plan.md`
2. Dispatch **evaluator (contract mode)** -- reads task plan, writes `contract.md` with verifiable acceptance criteria
3. Dispatch **generator** -- reads contract + task plan, produces deliverable
4. Dispatch **evaluator (evaluation mode)** -- reads contract + deliverable, writes evaluation
5. Parse evaluation file for `### Overall: PASS/FAIL` via regex (`src/evaluator.ts`)
6. Route: PASS -> next stage, FAIL + iterations left -> retry generator/evaluator loop with evaluation feedback, FAIL + max reached -> escalate

### State persistence (`src/state.ts`, `src/db.ts`)
Pipeline state is persisted to a SQLite database at `{projectDir}/.cccp/cccp.db` via sql.js (WASM). State is updated after every transition: stage start, contract write, generator dispatch, evaluator dispatch, routing decision, stage completion. All types (`PipelineState`, `StageState`, `GateInfo`, etc.) are defined in `src/types.ts`.

Resume finds the first non-completed stage and skips everything before it. PGE stages resume at the correct iteration and sub-step.

### MCP config (`src/mcp/mcp-config.ts`, `src/config.ts`)
Named MCP profiles defined in `cccp.yaml` with `extends` inheritance. Each profile generates a `--mcp-config` JSON file with only the servers that agent needs.

### Gate system (`src/gate/`, `src/mcp/gate-notifier.ts`)
- **`gate-strategy.ts`** — Strategy interface for gate handling
- **`gate-watcher.ts`** — `FilesystemGateStrategy` polls SQLite for `approved`/`rejected` (reloads from disk each poll for cross-process updates)
- **`auto-approve.ts`** — `AutoApproveStrategy` for headless/CI mode
- **`gate-notifier.ts`** — `GateNotifier` proactively elicits approval from connected Claude Code sessions via MCP elicitation

See `docs/architecture/gate-system.md` for details.

### MCP server (`src/mcp/mcp-server.ts`)
General-purpose MCP server with 5 tools: `cccp_runs`, `cccp_status`, `cccp_gate_respond`, `cccp_logs`, `cccp_artifacts`. Includes a `GateNotifier` that automatically detects pending gates and prompts for approval via MCP elicitation. Reloads DB from disk on each tool call for cross-process consistency.

See `docs/api/mcp-tools.md` for tool reference.

### TUI dashboard (`src/tui/`)
Ink/React split-pane dashboard: stages (left), agent activity (right), event log (bottom). Polls SQLite for state changes, subscribes to activity bus for real-time agent events.

See `docs/architecture/tui-dashboard.md` for details.

### Stream parser (`src/stream/stream.ts`)
Parses nested `message.content[]` events from claude's stream-json output using a discriminated union of typed event interfaces. Tracks tool calls, thinking, token usage, cost. In-process activity bus (`src/activity-bus.ts`) bridges to dashboard.

See `docs/architecture/streaming.md` for details.

## Data flow

```
CLI (cli.ts)
  → loads YAML → Pipeline (pipeline.ts)
  → loads cccp.yaml → ProjectConfig (config.ts)
  → resolves agents → search paths (agent-resolver.ts)
  → runs stages sequentially (runner.ts)
      → agent stages: resolve → dispatch → check output
      → pge stages: plan → contract → generate → evaluate → route
      → gate stages: write pending → elicitation/MCP/poll → approve/reject
  → state updates after every transition (state.ts)
  → stream events → dashboard (stream.ts → tui/)
  → cmux integration (tui/cmux.ts)
```

## Key design decisions

- **Project-agnostic**: CCCP ships no agents, no pipelines, no MCP configs. Everything is defined by the consuming project.
- **Fresh context per agent**: Each `claude -p` invocation starts with a clean context window. No context rot.
- **Regex routing**: The evaluator's `### Overall: PASS/FAIL` line is the only thing the runner reads. No interpretation.
- **Artifact-driven communication**: Agents read contracts and evaluations from disk. Artifacts are markdown files — the orchestrator only reads the `### Overall: PASS/FAIL` line.
- **SQLite state backend**: Pipeline state persisted to `{projectDir}/.cccp/cccp.db` via sql.js (WASM). Append-only events table for audit trail. Atomic flush via `tmp` + `rename`.
