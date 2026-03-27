# State Persistence & Resume

## State file

Pipeline state lives at `{artifact_dir}/.cccp/state.json`. It's written using atomic writes (write to `.tmp` then `fs.rename`) to prevent corruption from crashes.

## Schema

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

## Write points

State is saved after every transition in the runner and PGE engine:

| Location | Transition | Fields updated |
|----------|-----------|----------------|
| `runner.ts` | Pipeline start | Full state created |
| `runner.ts` | Stage start | `status: "in_progress"` |
| `runner.ts` | Stage complete | `status`, `durationMs`, `error` |
| `runner.ts` | Pipeline finish | `status`, `completedAt` |
| `pge.ts` | Contract written | `pgeStep: "contract_written"`, artifact path |
| `pge.ts` | Generator done | `pgeStep: "generator_dispatched"`, `iteration`, deliverable path |
| `pge.ts` | Evaluator done | `pgeStep: "evaluator_dispatched"`, evaluation path |
| `pge.ts` | Routing decision | `pgeStep: "routed"` |

## Resume logic

`findResumePoint(state)` in `src/state.ts`:

1. If `state.status === "passed"` → return null (nothing to resume)
2. Walk `stageOrder` — skip stages with `status: "passed"` or `"skipped"`
3. Return first non-completed stage with its index, name, and PGE sub-step info

The runner uses this to skip completed stages and restart from the right point. For PGE stages that were `in_progress`, the resume point includes `resumeIteration` and `resumeStep` (though current implementation restarts the full PGE cycle from the interrupted stage — sub-step resume is tracked for future use).

## Gate state

When a `human_gate` stage is reached, the runner writes `gate` to state:

```json
{
  "gate": {
    "stageName": "design-approval",
    "status": "pending",
    "prompt": "Review the design."
  }
}
```

The gate watcher polls state.json every 2 seconds. An external actor (MCP server, direct file edit) sets `status: "approved"` or `"rejected"`. The runner clears `gate` after processing.
