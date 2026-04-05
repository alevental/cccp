# State Persistence & Resume

## State database

Pipeline state lives in a SQLite database at `{projectDir}/.cccp/cccp.db`, managed by `src/db.ts` via sql.js (WASM). One database per project, all runs in one place. The database is flushed to disk atomically (write to `.tmp` then `rename`) after every state change.

Three tables: `runs` (materialized current state), `events` (append-only audit log), `checkpoints` (cached stage outputs). See ADR-001 for the migration rationale.

## Schema

### TypeScript types

```typescript
interface PipelineState {
  runId: string;           // UUID, unique per run
  pipeline: string;        // pipeline name from YAML
  project: string;         // --project CLI arg
  pipelineFile: string;    // path to pipeline YAML (for resume)
  startedAt: string;       // ISO timestamp
  completedAt?: string;    // set on finish
  status: "running" | "passed" | "failed" | "error" | "interrupted" | "paused";
  stages: Record<string, StageState>;
  stageOrder: string[];    // preserves YAML order
  gate?: GateInfo;         // active gate, if any
  projectDir?: string;     // used to locate the database
}

interface StageState {
  name: string;
  type: string;            // "agent" | "pge" | "human_gate" | "autoresearch" | "pipeline"
  status: StageStatus;     // pending | in_progress | passed | failed | skipped | error
  iteration?: number;      // PGE: current iteration (1-based)
  pgeStep?: PgeStep;       // PGE: last completed sub-step within iteration
  artifacts?: Record<string, string>;  // key → absolute path
  outputs?: Record<string, string>;    // collected structured outputs (key → value)
  durationMs?: number;
  error?: string;
  groupId?: string;        // parallel group ID (e.g. "parallel-0"), set for stages in parallel blocks
}
```

### SQL tables

```sql
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  pipeline TEXT NOT NULL,
  project TEXT NOT NULL,
  pipeline_file TEXT NOT NULL,
  artifact_dir TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  stages_json TEXT NOT NULL,     -- JSON-serialized Record<string, StageState>
  stage_order_json TEXT NOT NULL, -- JSON-serialized string[]
  gate_json TEXT,                -- JSON-serialized GateInfo | null
  project_dir TEXT,
  session_id TEXT,
  pause_requested INTEGER DEFAULT 0  -- cross-process pause signal (v3)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  stage_name TEXT,
  data TEXT,                      -- JSON-serialized arbitrary data
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  run_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (run_id, stage_name, key)
);
```

## Who mutates state

| Actor | Reads | Writes | Mechanism |
|-------|-------|--------|-----------|
| `runner.ts` | `loadState` (resume) | `saveState`, `saveStateWithEvent` | Direct DB access via `state.ts` |
| `pge.ts` | — | Mutates in-memory state via `updatePgeProgress`, `setStageArtifact` | State passed by reference; runner persists via `onProgress` callback |
| `mcp-server.ts` | `listRuns`, `getRunByArtifactDir` | `saveState` (gate response), `setPauseRequested` (pause) | Direct DB access; calls `reload()` before reads for cross-process sync |
| `gate-watcher.ts` | `loadState` (polling every 5s) | — | Read-only; passes `reloadFromDisk: true` for cross-process sync. Calls `reclaimWasmMemory()` every ~15 min. |
| `dashboard.tsx` | `loadState` (adaptive: 500ms active, 5s gate-idle), `getEvents` | — | Read-only; uses setTimeout chain with overlap guard |
| `cli.ts` | `loadState` (resume, dashboard commands) | `saveState` (initial state for TUI) | Direct DB access |

## Write points

State is saved after every transition in the runner and PGE engine:

| Location | Transition | Fields updated |
|----------|-----------|----------------|
| `runner.ts` | Pipeline start | Full state created |
| `runner.ts` | Stage start | `status: "in_progress"` |
| `runner.ts` | Stage complete | `status`, `durationMs`, `error` |
| `runner.ts` | Pipeline finish | `status`, `completedAt` |
| `runner.ts` | Pipeline paused | `status: "paused"`, `completedAt` |
| `pge.ts` (via callback) | Planner done | `pgeStep: "planner_dispatched"`, task plan path |
| `pge.ts` (via callback) | Contract done | `pgeStep: "contract_dispatched"`, contract path |
| `pge.ts` (via callback) | Generator done | `pgeStep: "generator_dispatched"`, `iteration`, deliverable path |
| `pge.ts` (via callback) | Evaluator done | `pgeStep: "evaluator_dispatched"`, evaluation path |
| `pge.ts` (via callback) | Routing decision | `pgeStep: "routed"` |

## Cross-process synchronization

The runner writes state; the MCP server, gate watcher, and dashboard read it. Synchronization uses:

- **Atomic flush**: `db.flush()` writes to a `.tmp` file, then renames. This prevents partial reads.
- **Reload**: `db.reload()` re-reads the database file from disk into the in-memory sql.js instance. Readers call this before querying to pick up the runner's latest writes.
- **No locking**: There is no file-level or row-level locking. In practice, only one writer (the runner) writes state at any given time. The MCP server writes gate responses (`gate.status = "approved"/"rejected"`) and pause requests (`pause_requested` column). Pause uses a dedicated DB column (not the state JSON) to avoid write races with the runner.

### Gate response flow

1. Runner writes `gate: { stageName, status: "pending", prompt }` to state
2. Gate watcher starts polling with `reloadFromDisk: true`
3. MCP server receives `cccp_gate_respond` call, loads state, updates `gate.status`, saves
4. Gate watcher detects the change on next poll, returns `GateResponse` to runner
5. Runner clears `gate` from state

## Resume logic

`findResumePoint(state)` in `src/state.ts`:

1. If `state.status === "passed"` → return null (nothing to resume)
2. Walk `stageOrder` — skip stages with `status: "passed"` or `"skipped"`
3. Return first non-completed stage with its index, name, and PGE sub-step info

The runner uses this to skip completed stages and restart from the right point. For PGE stages that were `in_progress`, the resume point includes `resumeIteration` and `resumeStep` (though current implementation restarts the full PGE cycle from the interrupted stage — sub-step resume is tracked for future use).

The `resume` CLI command launches the inline TUI dashboard (via `startDashboard()` with `useEventBus={true}`) identically to `cccp run`, using `QuietLogger` to suppress raw console output. The `--headless` flag disables the TUI on resume just as it does on fresh runs.

### Pause request flow

1. User presses `p` in TUI or calls `cccp_pause` MCP tool
2. The `pause_requested` column is set to `1` on the `runs` table (separate from state JSON to avoid write races)
3. Runner checks `db.isPauseRequested(runId)` before each execution step in the main loop
4. When detected: clears the flag, sets `status = "paused"` and `completedAt`, emits `pipeline_paused` event
5. Runner returns early; user resumes with `cccp resume`

## State lifecycle

1. **Created**: `createState()` called by the runner at pipeline start
2. **Updated**: After every stage transition (see write points above)
3. **Paused**: Runner detects `pause_requested` flag, sets `status: "paused"` and `completedAt`
4. **Completed**: `finishPipeline()` sets `status` and `completedAt`
5. **Resumed**: `findResumePoint()` scans for first non-completed stage (works for both interrupted and paused pipelines)
6. **Garbage collected**: Never — old runs persist in the database until manually deleted

## Clean reset (`--from`)

`resetFromStage(state, fromStagePath)` in `src/state.ts`:

When `cccp resume --from <stage>` is used, the named stage and all subsequent stages are wiped clean before the runner starts. This enables a fresh re-run from a specific point.

### Dotted paths for sub-pipeline stages

`--from` supports dotted paths to target stages inside sub-pipelines:

```bash
# Reset from a top-level stage
cccp resume -r a1b2c3d4 --from review

# Reset from a child stage within a sub-pipeline
cccp resume -r a1b2c3d4 --from sprint-0.doc-refresh
```

For dotted paths, the function walks the `children` chain (`state.stages["sprint-0"].children.stages["doc-refresh"]`), resets child stages from the target onward, and sets all ancestor stages to `in_progress` so the runner re-enters them. Arbitrary nesting depth is supported (e.g., `a.b.c`).

### What gets reset

| Layer | Cleanup |
|-------|---------|
| In-memory stage state | `status → "pending"`, clear `iteration`, `pgeStep`, `artifacts`, `outputs`, `durationMs`, `error` |
| Pipeline state | `status → "running"`, clear `completedAt`, clear `gate` |
| Ancestor stages (dotted paths) | `status → "in_progress"`, clear `durationMs`, `error` |
| SQLite events | Top-level: `DELETE ... WHERE stage_name IN (...)`. Dotted: child events matched via `json_extract(data_json, '$.childStage')` |
| SQLite checkpoints | `DELETE FROM checkpoints WHERE run_id = ? AND stage_name IN (...)` |
| Artifact dirs | `rm -rf {artifactDir}/{stageName}/` (uses child's artifact dir for dotted paths) |
| Stream logs | Delete `{artifactDir}/.cccp/{stageName}-*.stream.jsonl` |
| Gate feedback | Delete `{artifactDir}/.cccp/{stageName}-gate-feedback-*.md` |

Deliverable files (which may live outside the stage directory in the project tree) are intentionally not deleted — they may serve as inputs to other stages.

After reset, the standard resume path takes over: `findResumePoint()` sees the target stage as `pending` and the runner starts from there.

## Sub-pipeline state persistence

Sub-pipeline (type: pipeline) stages store their child state as a nested `PipelineState` in `stageState.children`. The runner pre-creates and links this child state to the parent BEFORE executing child stages. This enables:

1. **Crash recovery**: If the process crashes mid-child-execution, the parent state in the DB already has the `children` reference with up-to-date child progress. On resume, the runner passes this to `runStages()` and `findResumePoint()` resumes from the correct child stage.

2. **Live persistence**: The `parentOnProgress` callback calls `saveStateWithEvent(parentState, ...)` after each child event. Since `stageState.children` is a JavaScript reference to the child state object (which `runStages()` mutates in-place), the parent state always contains the latest child progress when saved.

3. **Dotted path reset**: `resetFromStage("parent.child")` walks the `children` chain to target specific child stages without resetting the entire sub-pipeline.

## Parallel group resume

When resuming a pipeline interrupted during a parallel group, `findResumePoint()` returns the first incomplete stage within the group. The runner identifies the containing parallel group from the pipeline definition and re-executes only the stages that didn't complete — completed stages within the group are skipped. State writes from concurrent stages within a parallel group serialize naturally through the Node.js event loop (all parallel stages run as concurrent Promises in the same process).

## Known limitations

- **No concurrent-write protection**: Beyond atomic rename, there's no mechanism to prevent two writers from conflicting. In practice, only the runner writes state during execution. Parallel stages within a group serialize writes through the event loop.
- **PGE sub-step resume is tracked but not used**: `resumeIteration` and `resumeStep` are recorded, but the runner restarts the full PGE cycle from the interrupted stage.
- **Database singleton**: `openDatabase()` caches by resolved `projectDir`. A second open to the same database returns the same in-memory instance. Cross-process access requires explicit `reload()`.
