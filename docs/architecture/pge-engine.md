# PGE Engine Internals

## Overview

The PGE (Plan-Generate-Evaluate) engine in `src/pge.ts` is the core quality loop. It orchestrates the contract → generate → evaluate → route cycle with deterministic iteration tracking.

## Control flow

```
runPgeCycle(stage, ctx)
  │
  ├── mkdir stageDir
  ├── writeContract(contractPath, criteria)
  ├── resolveAgent(generator) → loadAgentMarkdown
  ├── resolveAgent(evaluator) → loadAgentMarkdown
  ├── writeMcpConfigFile(genProfile) / writeMcpConfigFile(evalProfile)
  │
  └── for iter = 1..maxIter:
        │
        ├── writeSystemPromptFile(genMarkdown)
        ├── buildTaskContext(task, contract, output, prevEval, iter)
        ├── dispatchAgent(generator) → check exit code, check output exists
        ├── saveState(generator_dispatched)
        │
        ├── writeSystemPromptFile(evalMarkdown)
        ├── buildTaskContext(evaluate, contract, deliverable, evalOutput, iter)
        ├── dispatchAgent(evaluator) → check exit code, check output exists
        ├── saveState(evaluator_dispatched)
        │
        ├── parseEvaluation(evalPath) → PASS / FAIL / parse_error
        ├── saveState(routed)
        │
        └── if PASS → return pass
            if FAIL + iters left → set lastEvalPath, continue
            if FAIL + max → return fail
            if parse_error → return error
```

## Key invariants

1. **Agent crash ≠ evaluation FAIL.** A non-zero exit code from `claude -p` is an `AgentCrashError` — an infrastructure failure. An evaluation FAIL is a quality signal from the evaluator agent.

2. **Evaluation parse error is distinct.** If the evaluator's output doesn't contain `### Overall: PASS` or `### Overall: FAIL`, that's a `parse_error` — neither pass nor fail. The runner surfaces this separately.

3. **Previous evaluation is passed to generator on retry.** The generator's task context includes the path to the prior evaluation file so it can read the feedback and address specific issues.

4. **State is updated at every sub-step.** Contract written, generator dispatched, evaluator dispatched, routed. This enables resume at any point within an iteration.

## Evaluation regex

```typescript
const OVERALL_RE = /^###\s+Overall:\s*(PASS|FAIL)\s*$/m;
```

The `m` flag enables multiline matching. The regex anchors to the start of a line (`^`) to avoid matching inside code blocks or inline text. Only `PASS` and `FAIL` (case-sensitive) are valid verdicts.

## Contract generation

Contracts are written by `src/contract.ts`, not by agents. The YAML pipeline defines criteria; the runner writes the contract file before dispatching the generator. This ensures:

- Criteria are always present and correctly formatted
- The contract is never forgotten or modified by an agent
- Custom templates can override the default format via `contract.template`

## Escalation strategies

When `on_fail` is triggered (max iterations exhausted with FAIL):

- **`stop`** (default) — `runPgeStage` in runner.ts returns `status: "failed"`, pipeline halts
- **`skip`** — Returns `status: "skipped"`, pipeline continues to next stage
- **`human_gate`** — Writes `gate_pending` to state.json, waits for approval via gate strategy. If approved, pipeline continues. If rejected, pipeline halts.

## File layout per PGE stage

```
{artifact_dir}/
  {stage-name}/
    contract.md           # written by runner before first iteration
    evaluation-1.md       # written by evaluator on iteration 1
    evaluation-2.md       # written by evaluator on iteration 2 (if retry)
  {deliverable}           # written by generator (path from YAML)
```
