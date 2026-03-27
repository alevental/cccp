# CCCP Architecture Overview

## What CCCP is

A standalone TypeScript CLI that provides deterministic YAML-based pipeline orchestration for workflows built around Claude Code and cmux. It replaces Claude-as-state-machine with code-as-state-machine.

## Core components

### Pipeline loader (`src/pipeline.ts`)
Reads YAML pipeline definitions and validates them against a Zod schema. Produces typed `Pipeline` objects with discriminated union stage types.

### Stage types
- **`agent`** — Dispatch one agent via `claude -p`, collect output file
- **`pge`** — Plan-Generate-Evaluate cycle: write contract → dispatch generator → dispatch evaluator → parse `### Overall: PASS/FAIL` → retry on FAIL up to max_iterations
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

### PGE engine (`src/pge.ts`, `src/evaluator.ts`, `src/contract.ts`)
The Plan-Generate-Evaluate cycle:
1. Write contract from template + YAML criteria (`src/contract.ts`)
2. Dispatch generator agent with contract path and task context
3. Dispatch evaluator agent with contract + deliverable
4. Parse evaluation file for `### Overall: PASS/FAIL` via regex (`src/evaluator.ts`)
5. Route: PASS → next stage, FAIL + iterations left → retry with evaluation feedback, FAIL + max reached → escalate

### State persistence (`src/state.ts`)
Pipeline state is persisted to `{artifact_dir}/.cccp/state.json` with atomic writes (write to `.tmp` then `rename`). State is updated after every transition: stage start, contract write, generator dispatch, evaluator dispatch, routing decision, stage completion.

Resume finds the first non-completed stage and skips everything before it. PGE stages resume at the correct iteration and sub-step.

### MCP config (`src/mcp-config.ts`, `src/config.ts`)
Named MCP profiles defined in `cccp.yaml` with `extends` inheritance. Each profile generates a `--mcp-config` JSON file with only the servers that agent needs.

### Gate system (`src/gate/`)
- **`gate-strategy.ts`** — Strategy interface for gate handling
- **`gate-watcher.ts`** — `FilesystemGateStrategy` polls state.json for `approved`/`rejected`
- **`auto-approve.ts`** — `AutoApproveStrategy` for headless/CI mode
- **`mcp-server.ts`** — MCP server exposing `pipeline_status`, `pipeline_gate_respond`, `pipeline_logs`

### TUI dashboard (`src/tui/`)
- **`cmux.ts`** — cmux CLI wrapper (set-status, set-progress, log, notify)
- **`components.tsx`** — Ink React components (StageList, AgentActivity, Header)
- **`dashboard.tsx`** — Watches state.json + stream logs, renders live progress

### Stream parser (`src/stream.ts`)
Parses stream-json events from `claude -p` stdout. Tracks agent activity (active tools, token usage, latest text). Writes `.stream.jsonl` log files for replay.

## Data flow

```
CLI (cli.ts)
  → loads YAML → Pipeline (pipeline.ts)
  → loads cccp.yaml → ProjectConfig (config.ts)
  → resolves agents → search paths (agent-resolver.ts)
  → runs stages sequentially (runner.ts)
      → agent stages: resolve → dispatch → check output
      → pge stages: contract → generate → evaluate → route
      → gate stages: write pending → poll/MCP → approve/reject
  → state updates after every transition (state.ts)
  → stream events → dashboard (stream.ts → tui/)
  → cmux integration (tui/cmux.ts)
```

## Key design decisions

- **Project-agnostic**: CCCP ships no agents, no pipelines, no MCP configs. Everything is defined by the consuming project.
- **Fresh context per agent**: Each `claude -p` invocation starts with a clean context window. No context rot.
- **Regex routing**: The evaluator's `### Overall: PASS/FAIL` line is the only thing the runner reads. No interpretation.
- **Filesystem-based communication**: Agents read contracts and prior evaluations from disk. State is a JSON file. Gates are polled from state.json.
- **Atomic state writes**: Write to `.tmp` then `rename` prevents corruption from crashes.
