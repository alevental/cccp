# PGE Engine Internals

## Overview

The PGE (Plan-Generate-Evaluate) engine in `src/pge.ts` is the core quality loop. It orchestrates the planner -> contract -> generate -> evaluate -> route cycle with deterministic iteration tracking.

## Control flow

```
runPgeCycle(stage, ctx)
  |
  +-- mkdir stageDir
  +-- resolveAgent(planner) -> loadAgentMarkdown
  +-- resolveAgent(evaluator) -> loadAgentMarkdown
  +-- resolveAgent(generator) -> loadAgentMarkdown
  +-- writeMcpConfigFile(plannerProfile) / writeMcpConfigFile(genProfile) / writeMcpConfigFile(evalProfile)
  |
  +-- Phase 1: Planning
  |     +-- writeSystemPromptFile(plannerMarkdown)
  |     +-- buildTaskContext(task, plan, inputs)
  |     +-- dispatchAgent(planner) -> writes task-plan.md
  |     +-- saveState(planner_dispatched)
  |
  +-- Phase 2: Contract Writing
  |     +-- writeSystemPromptFile(evalMarkdown)
  |     +-- buildTaskContext(write contract, task-plan, guidance, template)
  |     +-- dispatchAgent(evaluator in contract mode) -> writes contract.md
  |     +-- saveState(contract_dispatched)
  |
  +-- Phase 3: Generate-Evaluate Loop
        +-- for iter = 1..maxIter:
              |
              +-- writeSystemPromptFile(genMarkdown)
              +-- buildTaskContext(task, contract, task-plan, output, prevEval, iter)
              +-- dispatchAgent(generator) -> check exit code, check output exists
              +-- saveState(generator_dispatched)
              |
              +-- writeSystemPromptFile(evalMarkdown)
              +-- buildTaskContext(evaluate, contract, deliverable, evalOutput, iter)
              +-- dispatchAgent(evaluator in evaluation mode) -> check exit code, check output exists
              +-- saveState(evaluator_dispatched)
              |
              +-- parseEvaluation(evalPath) -> PASS / FAIL / parse_error
              +-- saveState(routed)
              |
              +-- if PASS -> return pass
                  if FAIL + iters left -> set lastEvalPath, continue
                  if FAIL + max -> return fail
                  if parse_error -> return error
```

## Key invariants

1. **Agent crash != evaluation FAIL.** A non-zero exit code from `claude -p` is an `AgentCrashError` -- an infrastructure failure. An evaluation FAIL is a quality signal from the evaluator agent.

2. **Evaluation parse error is distinct.** If the evaluator's output doesn't contain `### Overall: PASS` or `### Overall: FAIL`, that's a `parse_error` -- neither pass nor fail. The runner surfaces this separately.

3. **Previous evaluation is passed to generator on retry.** The generator's task context includes the path to the prior evaluation file so it can read the feedback and address specific issues.

4. **State is updated at every sub-step.** Planner dispatched, contract dispatched, generator dispatched, evaluator dispatched, routed. This enables resume at any point within an iteration.

5. **The planner runs once, before the generate-evaluate loop.** The planner produces a task plan that feeds into both the contract writer and the generator.

6. **The evaluator serves dual roles.** In contract mode, it reads the task plan and writes a contract with verifiable acceptance criteria. In evaluation mode, it reads the contract and deliverable and writes an evaluation.

## Evaluation regex

```typescript
const OVERALL_RE = /^###\s+Overall:\s*(PASS|FAIL)\s*$/m;
```

The `m` flag enables multiline matching. The regex anchors to the start of a line (`^`) to avoid matching inside code blocks or inline text. Only `PASS` and `FAIL` (case-sensitive) are valid verdicts.

## Contract writing

Contracts are written by the **evaluator agent in contract mode**, not mechanically generated from YAML. The pipeline stage provides:

- `contract.guidance` (optional) -- free-form guidance for the contract writer
- `contract.template` (optional) -- a structural guide for the evaluator when writing the contract
- The task plan produced by the planner

The evaluator reads the task plan, considers any guidance and template, and writes `contract.md` with verifiable acceptance criteria. This ensures:

- Criteria are context-aware, derived from the actual task plan and codebase
- The contract reflects the evaluator's understanding of what "done" means
- Custom templates can guide the contract's structure via `contract.template`

## Input merging

Inputs are available at two levels and merged before dispatch:

- **Stage-level `inputs`** -- shared across all agents (planner, generator, evaluator)
- **Agent-level `inputs`** -- specific to planner, generator, or evaluator

Resolution: `effectiveInputs = [...stageInputs, ...agentInputs]`, all interpolated with variable values.

```yaml
- name: implement-auth
  type: pge
  inputs:                          # Stage-level: shared by all agents
    - "{artifact_dir}/architecture.md"
  planner:
    agent: architect
    inputs:                        # Agent-level: planner-specific
      - "{artifact_dir}/design.md"
  generator:
    agent: implementer
    inputs:                        # Agent-level: generator-specific
      - "{artifact_dir}/api-spec.md"
  evaluator:
    agent: reviewer
    # No agent-level inputs -- only gets stage-level
```

In this example, the planner receives `[architecture.md, design.md]`, the generator receives `[architecture.md, api-spec.md]`, and the evaluator receives `[architecture.md]`.

## Escalation strategies

When `on_fail` is triggered (max iterations exhausted with FAIL):

- **`stop`** (default) -- `runPgeStage` in runner.ts returns `status: "failed"`, pipeline halts
- **`skip`** -- Returns `status: "skipped"`, pipeline continues to next stage
- **`human_gate`** -- Writes a pending gate to the SQLite state database, waits for approval via gate strategy. If approved, pipeline continues. If rejected, pipeline halts.

## File layout per PGE stage

```
{artifact_dir}/
  {stage-name}/
    task-plan.md          # written by planner
    contract.md           # written by evaluator (contract mode)
    evaluation-1.md       # written by evaluator (evaluation mode) on iteration 1
    evaluation-2.md       # written by evaluator on iteration 2 (if retry)
  {deliverable}           # written by generator (path from YAML)
```
