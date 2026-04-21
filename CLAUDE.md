# CCCP — Claude Code and Cmux Pipeline Reagent

## What this project is

A standalone TypeScript CLI that provides deterministic YAML-based pipeline orchestration for workflows built around Claude Code and cmux. It moves the "file-routing state machine" pattern out of Claude's context window and into code, solving context degradation on long runs.

## Build & test

```bash
npm install
npm test              # vitest — 329 tests, ~5s
npm run typecheck     # tsc --noEmit
npx tsx src/cli.ts    # run CLI in dev mode (use instead of `npm run dev`)
```

## Key commands

```bash
npx @alevental/cccp run -f <pipeline.yaml> -p <project> [--dry-run] [--headless] [--no-tui]
npx @alevental/cccp resume -p <project> -r <run-id-prefix> [--from <stage>] [--no-tui]
npx @alevental/cccp dashboard -r <run-id-prefix>
npx @alevental/cccp mcp-server            # MCP server for gate interaction
npx @alevental/cccp agent-monitor --stream-log <path>  # per-agent detail monitor
npx @alevental/cccp init                  # scaffold minimal project
npx @alevental/cccp examples              # scaffold all agents + example pipelines
```

## Architecture

- **Pipeline YAML** → Zod-validated into typed `Pipeline` objects (`src/pipeline.ts`)
- **Types**: all domain types in `src/types.ts` (Pipeline, Stage, RunContext, PipelineState, StageState, etc.)
- **Stage types**: `agent` (single dispatch), `pge` (Plan-Generate-Evaluate cycle with retry), `ge` (Generate-Evaluate cycle — PGE without the planner), `autoresearch` (iterative artifact optimization), `pipeline` (sub-pipeline composition), `human_gate` (approval gate), `agent_gate` (delivery-identical to human_gate — same channels and `cccp_gate_respond` flow — but the MCP channel message instructs the receiving Claude Code session to decide the gate autonomously rather than prompting the user; no evaluator subprocess), `pipeline_handoff` (terminal stage that signals an outer orchestrator to launch the next pipeline in a specified cmux target; acked via `cccp_handoff_ack`), `loop` (configurable body stages + evaluator retry cycle). Stages can be wrapped in `parallel` blocks for concurrent execution. All stages support `outputs:` (structured key-value data via `.outputs.json`) and `when:` (conditional execution based on prior stage status/outputs). Output values are injected as variables for downstream interpolation (`{stage.key}`).
- **Parallel execution**: `parallel` groups in pipeline YAML run their stages concurrently via `Promise.all()`. Supports `fail_fast` (default) and `wait_all` failure modes. Constraints: no `human_gate` / `agent_gate` / `pipeline_handoff` / `pipeline` / `loop` stages inside groups, unique outputs per group. Resume re-runs only incomplete stages within a group. (`src/runner.ts`, `src/types.ts`)
- **Agent dispatch**: injectable `AgentDispatcher` interface (`src/dispatcher.ts`); default spawns `claude -p --output-format stream-json` (`src/agent.ts`). `PaneAwareDispatcher` decorator wraps dispatch with cmux pane open/close for per-agent monitor views; pane creation is serialised via a promise queue so parallel dispatches stack vertically. Per-agent `model` and `effort` overrides are passed as `--model` and `--effort` CLI flags. Resolution order: agent config > stage level > `phase_defaults` > pipeline level (`src/stage-helpers.ts`). `dispatchAgent()` returns `AgentResult.summary` — the last `task_progress` description from the stream — which is attached to `_done` and `stage_complete` events and rendered as dimmed narrative lines in the TUI detail log.
- **PGE cycle**: planner -> evaluator (contract mode) -> generator -> evaluator (evaluation mode) -> regex parse `### Overall: PASS/FAIL` -> route (`src/pge.ts`, `src/evaluator.ts`). Planner prompt explicitly frames the task as planning (not execution) with bookended instructions. Planner and contract run once; generator/evaluator loop retries on FAIL. State passed by reference with `onProgress` callback. When a PGE stage declares `outputs:`, the generator receives `outputsPath`/`outputKeys` in its task context and the evaluator receives guidance to verify `.outputs.json` exists with all declared keys.
- **GE cycle**: evaluator (contract mode) -> generator -> evaluator (evaluation mode) -> regex parse `### Overall: PASS/FAIL` -> route (`src/ge.ts`, `src/evaluator.ts`). Same as PGE but without the planner — the contract writer receives the task description and inputs directly instead of a task plan. Contract and evaluator reuse same agent. Generator/evaluator loop retries on FAIL. Supports `outputs:`, `on_fail`, `human_review`, and all PGE escalation strategies.
- **Loop cycle**: body stages (dispatched sequentially) -> evaluator -> regex parse `### Overall: PASS/FAIL` -> route (`src/loop.ts`). Body stages with `skip_first: true` are skipped on iteration 1. Only the first active body stage receives `previousEvaluation` and `gateFeedback`. Evaluator always gets `evaluatorFormat: true`. Max 20 iterations, escalation via `on_fail`. Supports `human_review` gate after successful completion.
- **State**: SQLite at `.cccp/cccp.db` via sql.js, atomic flush, stage-level + PGE-iteration-level resume. Pipeline status: `running`, `passed`, `failed`, `error`, `interrupted`, `paused`. Sub-pipeline child state is pre-linked to parent before execution and persisted via `parentOnProgress`, enabling correct resume from mid-child-pipeline crashes. `resetFromStage()` enables clean reset from a named stage onward (clears state, events, checkpoints, and artifact files); supports dotted paths for sub-pipeline stages (e.g., `--from sprint-0.doc-refresh`). (`src/state.ts`, `src/db.ts`)
- **Template agents**: 18 agents (7 directory + 11 flat) in `.claude/agents/`, usable both as Claude Code subagents and CCCP pipeline agents. Agent definitions are pure role/identity — pipeline-specific instructions (evaluation format, file I/O) are injected by the runner at dispatch time. Directory agents: `architect`, `product-manager`, `marketer`, `qa-engineer`, `strategist`, `designer`, `customer-success`. Flat agents: `researcher`, `reviewer`, `implementer`, `code-reviewer`, `copywriter`, `analyst`, `exec-reviewer`, `growth-strategist`, `ops-manager`, `devops`, `writer`.
- **Example pipelines**: 10 pipelines covering engineering (`feature-development`, `sprint-cycle`), product (`product-launch`), marketing (`content-calendar`), growth (`growth-experiment`), strategy (`quarterly-planning`, `business-case`), design (`design-sprint`), customer success (`customer-feedback-loop`), operations (`incident-runbook`).
- **Agent resolution**: multi-path search — flat files (`researcher.md`) and directory agents with operations (`architect/agent.md` + `architect/task-planning.md`) (`src/agent-resolver.ts`)
- **MCP config**: named profiles with `extends` inheritance, per-agent `--strict-mcp-config` (`src/mcp/mcp-config.ts`, `src/config.ts`). Channel-based gate notifications require `--dangerously-load-development-channels server:cccp` on the Claude Code side.
- **Gates**: `FilesystemGateStrategy` polls SQLite every 5s; MCP server exposes `cccp_gate_respond`, `cccp_gate_review`, `cccp_pause`, and `cccp_session_id` tools; `GateNotifier` uses three-tier notification (channel push, elicitation form, manual tools). Feedback written as numbered artifacts via `writeFeedbackArtifact()` (`src/gate/feedback-artifact.ts`). `human_review: true` on agent/PGE/GE stages fires post-completion gates with feedback retry (max 3). Session affinity via `--session-id` routes notifications to the correct MCP instance (`src/gate/`, `src/mcp/gate-notifier.ts`)
- **Pause**: Press `p` in the TUI or call `cccp_pause` MCP tool to request a pause. The runner finishes the current stage and stops at the next clean breakpoint with `status: "paused"`. Resume with `cccp resume`. Pause signal uses a dedicated `pause_requested` column in the DB (separate from state JSON to avoid write races). (`src/runner.ts`, `src/db.ts`)
- **DB service**: `DbService` (`src/db-service.ts`) centralises database access for cross-process readers (dashboard, gate-notifier, MCP server). Two modes: `"writer"` (same-process, no reload) and `"reader"` (reload-before-read + periodic `reclaimWasmMemory()` timer, default 15 min). Eliminates scattered manual reload/reclaim logic. The gate-watcher accepts an optional `DbService` and has a 12-hour safety timeout to prevent infinite polling on corrupted gate state.
- **Runner WASM reclaim**: `runPipeline()` starts a `setInterval(reclaimWasmMemory, 10min)` at top-level invocation (`src/runner.ts`) to cap sql.js WASM growth from `db.export()` churn during long runs. Sub-pipelines share the process and skip the timer. Configurable via `CCCP_WASM_RECLAIM_MS` env var (0 disables). Event pruning in `db.ts:flush()` runs every 10 flushes (kept at the 500-event-per-run cap).
- **TUI**: Ink/React dashboard watches SQLite + stream logs (`src/tui/`). Two-line header: line 1 shows pipeline name, project, run ID (8-char prefix), elapsed time, heap/RSS; line 2 shows git repo details (branch, commit hash, dirty/clean, ahead/behind, worktree tag, repo name) fetched once on mount via `getGitInfo()` (`src/git.ts`). Sub-pipeline stages show child run IDs (8-char prefix) next to the parent stage name in the stage list. Renders at 10 FPS with 15-minute remount cycle to cap yoga-layout WASM memory. Adaptive poll interval: 500ms when active, 5s when gate-idle. Gate stages use static `⏸` icon (no spinner animation). Standalone dashboard creates a `DbService` for sql.js WASM reclaim; inline dashboard uses in-process event bus (no reload needed). Keyboard-scrollable detail log (↑↓ PgUp/PgDn); press `p` to pause; press `m` to toggle Memory Diagnostics view (`src/tui/memory-view.tsx`) showing RSS/heap/external/arrayBuffers with deltas, growth rates, ASCII sparklines, V8 heap-space breakdown, and in-process counters — `MemorySampleRing` (600 samples) persists across the 15-min remount cycle. Active agents panel shows only in_progress agents with elapsed timers; 1-3 agents use horizontal columns, 4+ use compact rows. Sub-pipeline stages render inline with `├─` indent; in cmux, depth-1 sub-pipelines also get their own split-pane dashboard via `cccp dashboard --scope` (auto-launched, auto-closed). Per-agent monitor panes (`cccp agent-monitor`) auto-launch in cmux for each agent dispatch — full-fidelity event view with global expand/collapse toggle (`e` key), stacked vertically to the right of the primary TUI. Stage/phase start events include model, effort, inputs, and output metadata. Stage errors (crashes, missing outputs, `.outputs.json` validation failures) emit `stage_complete` events with error details so the TUI shows them immediately. Disable with `--no-tui` or `--headless`.
- **Stream parser**: typed discriminated union for claude stream-json events (`src/stream/stream.ts`). `AgentActivity.taskProgress` captures narrative step descriptions from `task_progress` events (separate from `lastText` which is overwritten by all text events). LoopStep tracks body stage and evaluator sub-steps within loop iterations. `StreamDetailAccumulator` (`src/stream/stream-detail.ts`) builds full-fidelity chronological `MonitorEntry` lists (no truncation) for the agent-monitor TUI. `SingleFileTailer` watches a single `.stream.jsonl` via `fs.watch` + poll fallback.
- **Logging**: injectable `Logger` interface (`src/logger.ts`) — ConsoleLogger, QuietLogger, SilentLogger
- **Context**: `buildRunContext()` constructs RunContext from CLI options (`src/context.ts`)
- **cmux**: set-status, set-progress, notify, log, sendText, sendKey, newSplit, closeSurface, launchScopedDashboard, getCccpCliPrefix via cmux CLI wrapper (`src/tui/cmux.ts`). `getCccpCliPrefix()` resolves the correct CLI command for pane subcommands (dev-mode tsx vs published package). `AgentPaneManager` (`src/tui/agent-panes.ts`) manages per-agent monitor panes: first active agent splits right, subsequent agents stack down via serialised promise queue. Panes auto-close on agent completion.

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
