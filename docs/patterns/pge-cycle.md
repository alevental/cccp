# PGE Cycle (Plan-Generate-Evaluate)

The PGE cycle is a contract-based quality loop. A planner agent produces a task plan, the evaluator writes a contract from that plan, a generator produces a deliverable against the contract, and the evaluator grades it. On failure, the generator/evaluator loop retries with feedback. It is the core pattern for producing high-quality artifacts in CCCP pipelines.

**Source files:**
- [`src/pge.ts`](../../src/pge.ts) -- PGE cycle implementation
- [`src/evaluator.ts`](../../src/evaluator.ts) -- evaluation parsing
- [`src/types.ts`](../../src/types.ts) -- `PgeStage`, `PgeResult`, `PgeAgentConfig` types

## Flow

```
                     +-----------+
                     | Dispatch  |
                     | Planner   |
                     +-----+-----+
                           |
                           v
                     +-----------+
                     | Dispatch  |
                     | Evaluator |
                     | (contract)|
                     +-----+-----+
                           |
                           v
              +----> +-----------+
              |      | Dispatch  |
              |      | Generator |
              |      +-----+-----+
              |            |
              |            v
              |      +-----------+
              |      | Dispatch  |
              |      | Evaluator |
              |      | (evaluate)|
              |      +-----+-----+
              |            |
              |            v
              |      +-----------+
              |      |  Parse    |
              |      | Evaluation|
              |      +-----+-----+
              |            |
     retry    |     +------+------+
     (iter    |     |             |
      left)   +--FAIL           PASS ---> done
                    |
                    v (max iterations)
              +-----------+
              | Escalation|
              +-----------+
              |     |     |
              v     v     v
            stop  gate  skip
```

## Step 1: Dispatch Planner

The planner agent runs once before the generate-evaluate loop. It reads the plan document (if provided via the `plan` field) and the codebase, then writes a `task-plan.md` file with a detailed breakdown of the work.

The planner's user prompt explicitly frames the task as **planning, not execution**. The raw stage task (e.g. "Create a wireframe") is wrapped with bookended instructions:

1. **Opening framing** — identifies the agent as a planner producing a task plan for a separate generator agent to execute. Instructs the planner not to produce the deliverable itself.
2. **Task body** — the stage `task` field, presented under a "Work to be Planned" heading (not "Task").
3. **Closing reminder** — appended to the Guidance section, reiterating that the output must be a plan document, not the deliverable or any finished content.

The planner receives:

- **System prompt:** The planner agent's markdown definition (via `--append-system-prompt-file`)
- **User prompt (task context):** Built by `buildTaskContext()` with:
  - Planning framing + stage task instruction (wrapped, not raw)
  - Plan document path (if `plan` is specified)
  - Effective inputs (stage-level + planner-specific)
  - Output path (`task-plan.md` in the stage directory)
  - Guidance with closing planning reminder

### Input merging

The planner's effective inputs are the stage-level `inputs` merged with the planner's own `inputs`:

```yaml
inputs:                          # Stage-level
  - "{artifact_dir}/architecture.md"
planner:
  agent: architect
  operation: task-planning
  inputs:                        # Planner-specific
    - "{artifact_dir}/design.md"
```

Effective planner inputs: `[architecture.md, design.md]`

## Step 2: Dispatch Evaluator (Contract Mode)

The evaluator agent is dispatched in contract-writing mode. It reads the task plan produced by the planner and writes `contract.md` with verifiable acceptance criteria.

The evaluator receives:

- **System prompt:** The evaluator agent's markdown definition
- **User prompt:** Task context with:
  - Task: "Write a contract with verifiable acceptance criteria"
  - Input: the task plan path
  - Output: contract file path (`contract.md` in the stage directory)
  - Contract guidance (if `contract.guidance` is specified)
  - Contract template (if `contract.template` is specified) -- used as a structural guide

The contract is an artifact written by an agent, not mechanically generated from YAML. This allows the evaluator to produce context-aware criteria derived from the actual task plan and codebase.

### Contract artifact

The contract is written to `<artifact-dir>/<stage-name>/contract.md` and tracked as a state artifact:

```typescript
setStageArtifact(state, stage.name, "contract", contractPath);
```

## Step 3: Dispatch Generator

The generator agent receives:

- **System prompt:** The agent's markdown definition (via `--append-system-prompt-file`)
- **User prompt (task context):** Built by `buildTaskContext()` with:
  - Task instruction from the stage (`task` field)
  - Contract path (so the agent can read acceptance criteria)
  - Task plan path (so the agent can read the detailed plan)
  - Output path (where to write the deliverable)
  - Previous evaluation path (on retry iterations)
  - Effective inputs (stage-level + generator-specific)
  - Iteration number and max iterations

### First iteration prompt

```markdown
# Task

Implement the OAuth module.

## Contract

Read the contract at: /project/docs/projects/my-project/implement-auth/contract.md

## Task Plan

Read the task plan at: /project/docs/projects/my-project/implement-auth/task-plan.md

## Inputs

- /project/docs/projects/my-project/architecture.md
- /project/docs/projects/my-project/api-spec.md

## Output

Write your output to: /project/src/auth/oauth.ts

## Iteration

This is iteration 1 of 3.
```

### Retry iteration prompt

```markdown
# Task

Implement the OAuth module.

## Contract

Read the contract at: /project/docs/projects/my-project/implement-auth/contract.md

## Task Plan

Read the task plan at: /project/docs/projects/my-project/implement-auth/task-plan.md

## Inputs

- /project/docs/projects/my-project/architecture.md
- /project/docs/projects/my-project/api-spec.md

## Output

Write your output to: /project/src/auth/oauth.ts

## Previous Evaluation

Your previous attempt was evaluated. Read the feedback at: /project/docs/projects/my-project/implement-auth/evaluation-1.md
Address all issues identified in the evaluation before producing your revised output.

## Iteration

This is iteration 2 of 3.
```

The generator must produce a file at the deliverable path. If it crashes (non-zero exit) or fails to produce the file, an `AgentCrashError` or `MissingOutputError` is thrown.

## Step 4: Dispatch Evaluator (Evaluation Mode)

The evaluator agent receives:

- **System prompt:** The evaluator's markdown definition
- **User prompt:** Task context with:
  - Task: "Evaluate the deliverable against the contract"
  - Contract path
  - Inputs: the deliverable path
  - Output: evaluation file path (`evaluation-<N>.md`)
  - Iteration info

The evaluator reads the contract and deliverable, then writes an evaluation file.

## Step 5: Parse Evaluation

**File:** `src/evaluator.ts`

The evaluator's output is parsed with a regex to extract the overall verdict:

```typescript
const OVERALL_RE = /^###\s+Overall:\s*(PASS|FAIL)\s*$/m;
```

This matches exactly `### Overall: PASS` or `### Overall: FAIL` at the start of a line.

### Outcomes

| Outcome | Condition |
|---------|-----------|
| `pass` | `### Overall: PASS` found |
| `fail` | `### Overall: FAIL` found |
| `parse_error` | File unreadable or no matching line found |

### Expected evaluation format

Evaluators should produce output in this format (see [Agent Authoring](../guides/agent-authoring.md)):

```markdown
## Evaluation: documentation

### Criterion Results

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | completeness | PASS | All sections present. |
| 2 | accuracy | FAIL | The API endpoint /auth/refresh is incorrect. |
| 3 | clarity | PASS | Well-structured with clear headings. |

### Overall: FAIL

### Iteration Guidance

1. Fix the /auth/refresh endpoint documentation
2. Add the missing error codes for 401 responses
```

## Step 6: Route

Based on the evaluation outcome:

### PASS

The cycle ends successfully:

```typescript
return {
  outcome: "pass",
  iterations: iter,
  maxIterations: maxIter,
  evaluationPath: evalPath,
  contractPath,
  taskPlanPath,
  durationMs: Date.now() - start,
};
```

### FAIL with retries remaining

The previous evaluation path is passed to the next generator iteration so it can address the feedback. The loop continues (only the generator/evaluator loop retries -- the planner and contract steps do not repeat).

### FAIL at max iterations

The escalation strategy (`on_fail`) is applied:

| Strategy | Behavior |
|----------|----------|
| `stop` (default) | Returns `outcome: "fail"`, pipeline stops |
| `human_gate` | Creates a pending gate; approval marks stage as `skipped`, rejection marks as `failed` |
| `skip` | Returns `outcome: "fail"` but stage is marked `skipped`, pipeline continues |

## State Tracking

The PGE cycle persists fine-grained progress to the database, enabling resume at the sub-step level:

| Step | `pgeStep` value | What just happened |
|------|----------------|-------------------|
| Planner dispatched | `planner_dispatched` | Planner agent completed, task plan written |
| Contract dispatched | `contract_dispatched` | Evaluator (contract mode) completed, contract written |
| Generator dispatched | `generator_dispatched` | Generator agent completed (per iteration) |
| Evaluator dispatched | `evaluator_dispatched` | Evaluator agent completed (per iteration) |
| Routed | `routed` | Evaluation parsed and routing decision made |

Artifacts tracked per stage:

- `task-plan` -- task plan file path
- `contract` -- contract file path
- `deliverable` -- deliverable file path
- `evaluation-N` -- evaluation file for iteration N

## When to Use PGE vs GE vs Simple Agent

### Use `pge` when:

- The output has objective quality criteria that can be evaluated
- You want automatic retry on failure
- The deliverable is high-stakes and worth multiple iterations
- The task is complex enough to benefit from a planner decomposing it into a detailed task plan

### Use `ge` when:

- The task is clear and specific enough that a planner isn't needed
- You still want contract-based evaluation and automatic retry
- The deliverable has objective quality criteria
- You want a lighter-weight quality loop (contract → generate → evaluate) without the planning overhead

GE is identical to PGE but skips the planner step — the evaluator writes the contract directly from the task description and inputs. See [`src/ge.ts`](../../src/ge.ts).

### Use `agent` when:

- The task is straightforward (research, file operations, simple transforms)
- There are no clear pass/fail criteria
- Speed matters more than guaranteed quality
- The output is intermediate (consumed by a later PGE or GE stage)

## Complete YAML Example

```yaml
name: feature-implementation
description: Plan and implement a feature with quality loop.

stages:
  # Simple agent stage for research (no quality loop needed)
  - name: research
    type: agent
    task: "Research the authentication feature."
    agent: researcher
    output: "{artifact_dir}/research.md"

  # PGE stage for the main deliverable
  - name: implement-auth
    type: pge
    task: "Implement the OAuth authentication module."
    plan: "{artifact_dir}/master-plan.md"
    inputs:
      - "{artifact_dir}/research.md"
    planner:
      agent: architect
      operation: task-planning
      inputs:
        - "{artifact_dir}/design.md"
    generator:
      agent: implementer
      inputs:
        - "{artifact_dir}/api-spec.md"
    evaluator:
      agent: reviewer
    contract:
      deliverable: "src/auth/oauth.ts"
      template: templates/implementation-contract.md
      guidance: |
        Must handle backward compatibility.
      max_iterations: 3
    on_fail: human_gate    # Escalate to human if 3 iterations all fail

  # Human approval after PGE passes
  - name: final-review
    type: human_gate
    prompt: "Review the implementation before merging."
    artifacts:
      - "src/auth/oauth.ts"
```

## PgeResult Type

```typescript
export interface PgeResult {
  /** Final evaluation outcome. */
  outcome: "pass" | "fail" | "error";
  /** Number of iterations executed. */
  iterations: number;
  /** Max iterations allowed. */
  maxIterations: number;
  /** Path to the final evaluation file. */
  evaluationPath?: string;
  /** Path to the contract file. */
  contractPath?: string;
  /** Path to the task plan file. */
  taskPlanPath?: string;
  /** Duration in milliseconds (total across all iterations). */
  durationMs: number;
}
```

## Model and Effort

Each PGE sub-agent (planner, generator, evaluator) can use a different model and effort level. This is useful for cost optimization — planners and evaluators often don't need the same reasoning depth as generators.

Resolution order: agent config > stage level > `phase_defaults` > pipeline level. See [Pipeline Schema](../architecture/pipeline-schema.md#model-and-effort-resolution) for full details.

## Related Documentation

- [Pipeline Authoring](../guides/pipeline-authoring.md) -- PGE stage YAML syntax
- [Agent Authoring](../guides/agent-authoring.md) -- writing planner, generator, and evaluator agents
- [Agent Dispatch](agent-dispatch.md) -- how planner/generator/evaluator agents are executed
- [Pipeline Schema](../architecture/pipeline-schema.md) -- `PgeStage` type definition
