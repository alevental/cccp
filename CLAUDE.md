# CCCP — Claude Code and Cmux Pipeline Reagent

## What this project is

A standalone TypeScript CLI that provides deterministic YAML-based pipeline orchestration for workflows built around Claude Code and cmux. It moves the "file-routing state machine" pattern out of Claude's context window and into code, solving context degradation on long runs.

## Build & test

```bash
npm install
npm test              # vitest — 270 tests, ~5s
npm run typecheck     # tsc --noEmit
npx tsx src/cli.ts    # run CLI in dev mode (use instead of `npm run dev`)
```

## Key commands

```bash
npx @alevental/cccp run -f <pipeline.yaml> -p <project> [--dry-run] [--headless] [--no-tui]
npx @alevental/cccp resume -p <project> -r <run-id-prefix> [--from <stage>] [--no-tui]
npx @alevental/cccp dashboard -r <run-id-prefix>
npx @alevental/cccp mcp-server            # MCP server for gate interaction
npx @alevental/cccp init                  # scaffold minimal project
npx @alevental/cccp examples              # scaffold all agents + example pipelines
```

## Architecture

- **Pipeline YAML** → Zod-validated into typed `Pipeline` objects (`src/pipeline.ts`)
- **Types**: all domain types in `src/types.ts` (Pipeline, Stage, RunContext, PipelineState, StageState, etc.)
- **Stage types**: `agent` (single dispatch), `pge` (Plan-Generate-Evaluate cycle with retry), `autoresearch` (iterative artifact optimization), `pipeline` (sub-pipeline composition), `human_gate` (approval gate). Stages can be wrapped in `parallel` blocks for concurrent execution. All stages support `outputs:` (structured key-value data via `.outputs.json`) and `when:` (conditional execution based on prior stage status/outputs). Output values are injected as variables for downstream interpolation (`{stage.key}`).
- **Parallel execution**: `parallel` groups in pipeline YAML run their stages concurrently via `Promise.all()`. Supports `fail_fast` (default) and `wait_all` failure modes. Constraints: no `human_gate` or `pipeline` stages inside groups, unique outputs per group. Resume re-runs only incomplete stages within a group. (`src/runner.ts`, `src/types.ts`)
- **Agent dispatch**: injectable `AgentDispatcher` interface (`src/dispatcher.ts`); default spawns `claude -p --output-format stream-json` (`src/agent.ts`). Per-agent `model` and `effort` overrides are passed as `--model` and `--effort` CLI flags. Resolution order: agent config > stage level > `phase_defaults` > pipeline level (`src/stage-helpers.ts`)
- **PGE cycle**: planner -> evaluator (contract mode) -> generator -> evaluator (evaluation mode) -> regex parse `### Overall: PASS/FAIL` -> route (`src/pge.ts`, `src/evaluator.ts`). Planner prompt explicitly frames the task as planning (not execution) with bookended instructions. Planner and contract run once; generator/evaluator loop retries on FAIL. State passed by reference with `onProgress` callback. When a PGE stage declares `outputs:`, the generator receives `outputsPath`/`outputKeys` in its task context and the evaluator receives guidance to verify `.outputs.json` exists with all declared keys.
- **State**: SQLite at `.cccp/cccp.db` via sql.js, atomic flush, stage-level + PGE-iteration-level resume. Pipeline status: `running`, `passed`, `failed`, `error`, `interrupted`, `paused`. Sub-pipeline child state is pre-linked to parent before execution and persisted via `parentOnProgress`, enabling correct resume from mid-child-pipeline crashes. `resetFromStage()` enables clean reset from a named stage onward (clears state, events, checkpoints, and artifact files); supports dotted paths for sub-pipeline stages (e.g., `--from sprint-0.doc-refresh`). (`src/state.ts`, `src/db.ts`)
- **Template agents**: 18 agents (7 directory + 11 flat) in `.claude/agents/`, usable both as Claude Code subagents and CCCP pipeline agents. Agent definitions are pure role/identity — pipeline-specific instructions (evaluation format, file I/O) are injected by the runner at dispatch time. Directory agents: `architect`, `product-manager`, `marketer`, `qa-engineer`, `strategist`, `designer`, `customer-success`. Flat agents: `researcher`, `reviewer`, `implementer`, `code-reviewer`, `copywriter`, `analyst`, `exec-reviewer`, `growth-strategist`, `ops-manager`, `devops`, `writer`.
- **Example pipelines**: 10 pipelines covering engineering (`feature-development`, `sprint-cycle`), product (`product-launch`), marketing (`content-calendar`), growth (`growth-experiment`), strategy (`quarterly-planning`, `business-case`), design (`design-sprint`), customer success (`customer-feedback-loop`), operations (`incident-runbook`).
- **Agent resolution**: multi-path search — flat files (`researcher.md`) and directory agents with operations (`architect/agent.md` + `architect/task-planning.md`) (`src/agent-resolver.ts`)
- **MCP config**: named profiles with `extends` inheritance, per-agent `--strict-mcp-config` (`src/mcp/mcp-config.ts`, `src/config.ts`). Channel-based gate notifications require `--dangerously-load-development-channels server:cccp` on the Claude Code side.
- **Gates**: `FilesystemGateStrategy` polls SQLite every 5s; MCP server exposes `cccp_gate_respond`, `cccp_gate_review`, `cccp_pause`, and `cccp_session_id` tools; `GateNotifier` uses three-tier notification (channel push, elicitation form, manual tools). Feedback written as numbered artifacts via `writeFeedbackArtifact()` (`src/gate/feedback-artifact.ts`). `human_review: true` on agent/PGE stages fires post-completion gates with feedback retry (max 3). Session affinity via `--session-id` routes notifications to the correct MCP instance (`src/gate/`, `src/mcp/gate-notifier.ts`)
- **Pause**: Press `p` in the TUI or call `cccp_pause` MCP tool to request a pause. The runner finishes the current stage and stops at the next clean breakpoint with `status: "paused"`. Resume with `cccp resume`. Pause signal uses a dedicated `pause_requested` column in the DB (separate from state JSON to avoid write races). (`src/runner.ts`, `src/db.ts`)
- **TUI**: Ink/React dashboard watches SQLite + stream logs (`src/tui/`). Renders at 10 FPS with 15-minute remount cycle to cap yoga-layout WASM memory. Adaptive poll interval: 500ms when active, 5s when gate-idle. Gate stages use static `⏸` icon (no spinner animation). sql.js WASM module reclaimed every ~15 min via `reclaimWasmMemory()` (both inline and standalone dashboards). Keyboard-scrollable detail log (↑↓ PgUp/PgDn); press `p` to pause. Active agents panel shows only in_progress agents with elapsed timers; 1-3 agents use horizontal columns, 4+ use compact rows. Sub-pipeline stages render inline with `├─` indent; in cmux, depth-1 sub-pipelines also get their own split-pane dashboard via `cccp dashboard --scope` (auto-launched, auto-closed). Stage/phase start events include model, effort, inputs, and output metadata. Stage errors (crashes, missing outputs, `.outputs.json` validation failures) emit `stage_complete` events with error details so the TUI shows them immediately. Disable with `--no-tui` or `--headless`.
- **Stream parser**: typed discriminated union for claude stream-json events (`src/stream/stream.ts`)
- **Logging**: injectable `Logger` interface (`src/logger.ts`) — ConsoleLogger, QuietLogger, SilentLogger
- **Context**: `buildRunContext()` constructs RunContext from CLI options (`src/context.ts`)
- **cmux**: set-status, set-progress, notify, log, sendText, sendKey, newSplit, launchScopedDashboard via cmux CLI wrapper (`src/tui/cmux.ts`)

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
