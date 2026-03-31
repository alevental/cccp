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
  status: "running" | "passed" | "failed" | "error" | "interrupted";
  stages: Record<string, StageState>;
  stageOrder: string[];    // preserves YAML order
  gate?: GateInfo;         // active gate, if any
  projectDir?: string;     // used to locate the database
}

interface StageState {
  name: string;
  type: string;            // "agent" | "pge" | "human_gate"
  status: StageStatus;     // pending | in_progress | passed | failed | skipped | error
  iteration?: number;      // PGE: current iteration (1-based)
  pgeStep?: PgeStep;       // PGE: last completed sub-step within iteration
  artifacts?: Record<string, string>;  // key → absolute path
  durationMs?: number;
  error?: string;
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
  project_dir TEXT
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
| `mcp-server.ts` | `listRuns`, `getRunByArtifactDir` | `saveState` (gate response only) | Direct DB access; calls `reload()` before reads for cross-process sync |
| `gate-watcher.ts` | `loadState` (polling every 2s) | — | Read-only; passes `reloadFromDisk: true` for cross-process sync |
| `dashboard.tsx` | `loadState` (polling every 300ms), `getEvents` | — | Read-only; calls `reload()` before reads |
| `cli.ts` | `loadState` (resume, dashboard commands) | `saveState` (initial state for TUI) | Direct DB access |

## Write points

State is saved after every transition in the runner and PGE engine:

| Location | Transition | Fields updated |
|----------|-----------|----------------|
| `runner.ts` | Pipeline start | Full state created |
| `runner.ts` | Stage start | `status: "in_progress"` |
| `runner.ts` | Stage complete | `status`, `durationMs`, `error` |
| `runner.ts` | Pipeline finish | `status`, `completedAt` |
| `pge.ts` (via callback) | Planner done | `pgeStep: "planner_dispatched"`, task plan path |
| `pge.ts` (via callback) | Contract done | `pgeStep: "contract_dispatched"`, contract path |
| `pge.ts` (via callback) | Generator done | `pgeStep: "generator_dispatched"`, `iteration`, deliverable path |
| `pge.ts` (via callback) | Evaluator done | `pgeStep: "evaluator_dispatched"`, evaluation path |
| `pge.ts` (via callback) | Routing decision | `pgeStep: "routed"` |

## Cross-process synchronization

The runner writes state; the MCP server, gate watcher, and dashboard read it. Synchronization uses:

- **Atomic flush**: `db.flush()` writes to a `.tmp` file, then renames. This prevents partial reads.
- **Reload**: `db.reload()` re-reads the database file from disk into the in-memory sql.js instance. Readers call this before querying to pick up the runner's latest writes.
- **No locking**: There is no file-level or row-level locking. In practice, only one writer (the runner) writes state at any given time. The MCP server only writes gate responses (`gate.status = "approved"/"rejected"`), which the gate watcher detects on its next poll.

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

## State lifecycle

1. **Created**: `createState()` called by the runner at pipeline start
2. **Updated**: After every stage transition (see write points above)
3. **Completed**: `finishPipeline()` sets `status` and `completedAt`
4. **Resumed**: `findResumePoint()` scans for first non-completed stage
5. **Garbage collected**: Never — old runs persist in the database until manually deleted

## Known limitations

- **No concurrent-write protection**: Beyond atomic rename, there's no mechanism to prevent two writers from conflicting. In practice, only the runner writes state during execution.
- **PGE sub-step resume is tracked but not used**: `resumeIteration` and `resumeStep` are recorded, but the runner restarts the full PGE cycle from the interrupted stage.
- **Database singleton**: `openDatabase()` caches by resolved `projectDir`. A second open to the same database returns the same in-memory instance. Cross-process access requires explicit `reload()`.
