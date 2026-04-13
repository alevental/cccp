---
name: cccp-pipeline
description: Write CCCP pipeline YAML files. Complete schema reference with examples. Use when writing, modifying, or reviewing pipeline definitions.
allowed-tools: Write, Read, Bash(cccp:*)
---

# CCCP Pipeline Authoring Reference

This is the complete reference for writing CCCP pipeline YAML files. Use this to produce correct, valid pipeline definitions.

## Pipeline Structure

```yaml
name: string                    # Required. Pipeline identifier.
description: string             # Optional. Human-readable description.
variables:                      # Optional. Default variables for all stages.
  key: "value"
model: string                   # Optional. Pipeline-level default model.
effort: low|medium|high|max     # Optional. Pipeline-level default effort.
phase_defaults:                 # Optional. Per-phase model/effort defaults.
  planner:
    model: string
    effort: low|medium|high|max
  generator:
    model: string
    effort: low|medium|high|max
  evaluator:
    model: string
    effort: low|medium|high|max
  adjuster:
    model: string
    effort: low|medium|high|max
  executor:
    model: string
    effort: low|medium|high|max
stages:                         # Required. At least one stage.
  - name: string                # Required. Unique stage identifier.
    type: agent | pge | autoresearch | pipeline | human_gate | loop
    # ... stage-specific fields
```

## Shared Stage Fields

Every stage type supports these base fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique stage identifier |
| `task` | string | No | Inline task instructions (supports `{variable}` interpolation) |
| `task_file` | string | No | Path to file containing task (mutually exclusive with `task`) |
| `mcp_profile` | string | No | Named MCP profile from `cccp.yaml` |
| `variables` | map | No | Stage-level variable overrides |
| `outputs` | map | No | Structured outputs: keys are variable names, values are descriptions for the agent. For PGE stages, the generator writes `.outputs.json` and the evaluator verifies it exists |
| `when` | string or list | No | Condition(s) — stage is skipped if any condition is not met |

`task` and `task_file` cannot both be set on the same stage.

## Stage Type: `agent`

Single agent dispatch. Simplest stage type.

```yaml
- name: research
  type: agent
  task: "Research the topic and write a summary."
  agent: researcher                    # Required. Agent name or path.
  operation: spec-writing              # Optional. For directory agents only.
  inputs:                              # Optional. Files agent should read.
    - "{artifact_dir}/brief.md"
  output: "{artifact_dir}/research.md" # Optional. Expected output path.
  allowed_tools:                       # Optional. Restrict built-in tools.
    - Read
    - Grep
    - Glob
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | Yes | Agent name (searched in agent paths) or direct path |
| `operation` | string | No | Operation file for directory-style agents |
| `inputs` | string[] | No | File paths passed to agent (interpolated) |
| `output` | string | No | Expected output path (stage fails if missing after execution) |
| `allowed_tools` | string[] | No | Restrict which built-in tools the agent can use (does not affect MCP tools) |
| `model` | string | No | Model override (`haiku`, `sonnet`, `opus`, or full model name) |
| `effort` | string | No | Effort level override (`low`, `medium`, `high`, `max`) |

## Stage Type: `pge`

Plan-Generate-Evaluate cycle with retry loop.

```yaml
- name: implementation
  type: pge
  task: "Implement the feature."
  model: opus                          # Optional. Stage-level model default.
  effort: high                         # Optional. Stage-level effort default.
  plan: "{artifact_dir}/plan.md"       # Optional. Plan document path.
  inputs:                              # Optional. Shared across all agents.
    - "{artifact_dir}/design.md"
  planner:                             # Required. Planner agent config.
    agent: architect
    operation: task-planning
    effort: medium                     # Optional. Per-agent override.
    inputs:                            # Optional. Planner-specific inputs.
      - "{artifact_dir}/requirements.md"
  generator:                           # Required. Generator agent config.
    agent: implementer
    mcp_profile: dev-tools
  evaluator:                           # Required. Evaluator agent config.
    agent: code-reviewer
  contract:
    deliverable: "{artifact_dir}/implementation-report.md"  # Required. Output path.
    guidance: "All acceptance criteria must be met."         # Optional. Free-form.
    template: "templates/contract-template.md"              # Optional. Structural guide.
    max_iterations: 5                                       # Required. 1-10.
  on_fail: human_gate                  # Optional. Default: "stop".
```

### PGE Agent Config (planner, generator, evaluator)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | Yes | Agent name or path |
| `operation` | string | No | Operation for directory agents |
| `mcp_profile` | string | No | Agent-specific MCP profile (overrides stage-level) |
| `allowed_tools` | string[] | No | Restrict which built-in tools the agent can use (does not affect MCP tools) |
| `inputs` | string[] | No | Agent-specific inputs (merged with stage `inputs`) |
| `model` | string | No | Model override for this agent (highest priority) |
| `effort` | string | No | Effort override for this agent (highest priority) |

### PGE Contract Fields

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `deliverable` | string | Yes | - | Path where generator writes output |
| `max_iterations` | integer | Yes | 1-10 | Maximum retry iterations |
| `guidance` | string | No | - | Free-form guidance for planner and contract writer |
| `template` | string | No | - | Path to structural template for contract |

### PGE Execution Flow

1. **Planner**: Reads plan document + inputs, writes `task-plan.md`
2. **Contract**: Evaluator reads task plan + guidance/template, writes `contract.md`
3. **Generator**: Reads contract + task plan + inputs, produces `deliverable`
4. **Evaluator**: Reads contract + deliverable, writes `evaluation-N.md`
5. **Route**: PASS → stage succeeds. FAIL → retry from step 3. Max iterations → apply `on_fail`.

The evaluator output must contain `### Overall: PASS` or `### Overall: FAIL`.

### `on_fail` Strategies

| Value | Behavior |
|-------|----------|
| `"stop"` (default) | Mark stage failed, halt pipeline |
| `"skip"` | Mark stage skipped, continue pipeline |
| `"human_gate"` | Pause for human approval |

## Stage Type: `ge`

Generate-Evaluate cycle — PGE without the planner. The evaluator writes the contract directly from the task description and inputs, then the generate-evaluate loop runs against that contract.

```yaml
- name: write-docs
  type: ge
  task: "Write comprehensive API documentation."
  inputs:                                # Optional. Shared across generator and evaluator.
    - "{artifact_dir}/research.md"
  generator:                             # Required. Generator agent config.
    agent: writer
    inputs:                              # Optional. Generator-specific inputs.
      - "{artifact_dir}/api-spec.md"
  evaluator:                             # Required. Evaluator agent config.
    agent: reviewer
  contract:
    deliverable: "{artifact_dir}/api-docs.md"    # Required. Output path.
    guidance: "Must cover all endpoints."         # Optional. Free-form.
    template: "templates/doc-contract.md"         # Optional. Structural guide.
    max_iterations: 3                             # Required. 1-10.
  on_fail: human_gate                    # Optional. Default: "stop".
  human_review: true                     # Optional. Gate after PASS.
```

### GE Execution Flow

1. **Contract**: Evaluator reads task + all inputs (stage + generator), writes `contract.md`
2. **Generator**: Reads contract + inputs, produces `deliverable`
3. **Evaluator**: Reads contract + deliverable, writes `evaluation-N.md`
4. **Route**: PASS → stage succeeds. FAIL → retry from step 2. Max iterations → apply `on_fail`.

Uses same `PgeAgentConfig` for generator and evaluator, same contract fields, same `on_fail` strategies as PGE.

**When to use GE vs PGE:** Use GE when the task is clear and specific enough that a planner is unnecessary. Use PGE when you need a planner to decompose complex work into a detailed task plan first.

## Stage Type: `autoresearch`

Iterative artifact optimization. Adjust-Execute-Evaluate loop.

```yaml
- name: tune-prompt
  type: autoresearch
  task: "Summarize the document using the prompt."
  artifact: prompts/summarizer.md                # Required. Tunable artifact path.
  ground_truth: expected/summary.md              # Required. Known-correct output.
  output: "{artifact_dir}/actual-summary.md"     # Required. Executor output path.
  inputs:                                        # Optional. Shared inputs.
    - source-material.md
  adjuster:                                      # Required. Adjusts artifact.
    agent: prompt-tuner
  executor:                                      # Required. Runs task with artifact.
    agent: summarizer
  evaluator:                                     # Required. Compares output to ground truth.
    agent: diff-evaluator
  max_iterations: 10                             # Optional. Omit for unlimited.
  on_fail: stop                                  # Optional. Default: "stop".
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `artifact` | string | Yes | - | Path to the artifact being tuned |
| `ground_truth` | string | Yes | - | Path to known-correct expected output |
| `output` | string | Yes | - | Path where executor writes output |
| `inputs` | string[] | No | - | Shared input files |
| `adjuster` | PgeAgentConfig | Yes | - | Agent that modifies the artifact |
| `executor` | PgeAgentConfig | Yes | - | Agent that runs the task |
| `evaluator` | PgeAgentConfig | Yes | - | Agent that compares output to ground truth |
| `max_iterations` | integer | No | 1+ or omit | Omit for unlimited iterations |
| `on_fail` | string | No | stop/human_gate/skip | Behavior on max iterations reached |

### Autoresearch Execution Flow

1. **Iteration 1**: Skip adjuster. Executor runs task using initial artifact. Evaluator compares.
2. **Iteration 2+**: Adjuster reads previous evaluation, modifies artifact. Executor runs. Evaluator compares.
3. **Route**: PASS → done. FAIL → loop. Max reached → apply `on_fail`.

## Stage Type: `human_gate`

Pause pipeline for human approval.

```yaml
- name: design-approval
  type: human_gate
  prompt: "Review the design document. Approve to proceed."
  artifacts:                           # Optional. Files for reviewer to inspect.
    - "{artifact_dir}/design.md"
  on_reject: stop                      # Optional. Default: "stop".
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | No | Instructions for the reviewer |
| `artifacts` | string[] | No | File paths for review |
| `on_reject` | string | No | `"stop"` (default) or `"retry"` |

In `--headless` mode, all gates are auto-approved.

## Stage Type: `pipeline`

Sub-pipeline composition. Invokes another pipeline YAML inline within the parent.

```yaml
- name: run-docs
  type: pipeline
  file: pipelines/build-docs.yaml        # Required. Path to sub-pipeline YAML.
  variables:                              # Optional. Explicit variables for the child.
    source: "{artifact_dir}/research.md"
  artifact_dir: "{artifact_dir}/docs"     # Optional. Override artifact dir for child.
  on_fail: skip                           # Optional. Default: "stop".
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `file` | string | Yes | - | Path to sub-pipeline YAML (resolved relative to parent pipeline dir, supports variable interpolation) |
| `variables` | map | No | - | Variables passed to sub-pipeline (child does NOT inherit parent's custom vars) |
| `artifact_dir` | string | No | - | Override artifact directory for the child pipeline |
| `on_fail` | string | No | stop/human_gate/skip | Behavior if sub-pipeline fails |

### Pipeline Composition Mechanics

- Sub-pipeline runs inline — its stages execute sequentially as part of the parent run
- Child state is nested inside parent's stage state (not a separate run)
- Variables are **explicit pass-through only**: child gets built-in vars (`{project}`, `{project_dir}`, `{artifact_dir}`, `{pipeline_name}`) recomputed for its context, plus any `variables` explicitly passed
- Circular dependencies are detected (max depth 5) and cause the stage to error
- Resume works across pipeline boundaries
- `on_fail` strategies work the same as PGE/autoresearch/loop stages

## Stage Type: `loop`

Configurable body stages + evaluator retry cycle. Generalizes the PGE/autoresearch pattern: run N body stages, evaluate, retry on FAIL.

```yaml
- name: qa-review
  type: loop
  task: "Fix all issues until QA review passes"
  max_iterations: 5
  inputs:
    - "{artifact_dir}/feature-spec.md"
  stages:
    - name: fix
      agent: implementer
      task: "Fix the issues identified in the review"
      skip_first: true                    # Optional. Skip this body stage on iteration 1.
    - name: test
      agent: qa-engineer
      task: "Run the full test suite"
      output: "{artifact_dir}/qa/test-results.md"
  evaluator:
    agent: reviewer
    task: "Review implementation quality"
    inputs:
      - "{artifact_dir}/qa/test-results.md"
  on_fail: human_gate
  human_review: true
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `stages` | LoopBodyStage[] | Yes | At least 1 | Body stages executed sequentially each iteration |
| `evaluator` | PgeAgentConfig | Yes | - | Agent that evaluates after all body stages complete |
| `max_iterations` | integer | Yes | 1-20 | Maximum retry iterations |
| `inputs` | string[] | No | - | Shared inputs for all body stages and evaluator |
| `on_fail` | string | No | stop/human_gate/skip | Behavior when max iterations exhausted with FAIL |
| `human_review` | boolean | No | - | Fire a human review gate after successful completion |
| `model` | string | No | - | Stage-level default model for body stages and evaluator |
| `effort` | string | No | low/medium/high/max | Stage-level default effort |

### LoopBodyStage Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique within the loop (must not match loop stage name) |
| `agent` | string | Yes | Agent to dispatch |
| `operation` | string | No | Directory agent operation |
| `task` | string | No | Override task for this body stage (mutually exclusive with `task_file`) |
| `task_file` | string | No | Path to task file (mutually exclusive with `task`) |
| `output` | string | No | Expected output path (if set, agent must create this file) |
| `skip_first` | boolean | No | Skip this body stage on iteration 1 (at least one body must NOT have skip_first) |
| `inputs` | string[] | No | Agent-specific inputs (merged with stage-level inputs) |
| `model` | string | No | Model override |
| `effort` | string | No | Effort override |
| `mcp_profile` | string | No | MCP profile override |
| `allowed_tools` | string[] | No | Restrict which built-in tools the agent can use (does not affect MCP tools) |

### Loop Execution Flow

1. For each iteration 1..max_iterations:
   - For each body stage (skip if `skip_first` and iter == 1):
     - Dispatch body agent (first active body gets `previousEvaluation` on iter > 1)
   - Dispatch evaluator with `### Overall: PASS/FAIL` format
   - Parse evaluation result
2. **Route**: PASS → done. FAIL + iters left → retry. Max reached → apply `on_fail`.

## Parallel Execution Groups

Run independent stages concurrently. Stages in a `parallel` block execute simultaneously as separate subprocesses, reducing total pipeline runtime when stages don't depend on each other's outputs.

### When to Use Parallel Groups

Use parallel groups when stages share the same inputs but produce independent outputs. Common patterns:

- **Content fan-out**: After research/positioning is complete, multiple content pieces (blog post, release notes, social copy, changelog) can all be written simultaneously since they read the same source material
- **Multi-perspective analysis**: Run competitive analysis, market sizing, and customer research in parallel when they all stem from the same brief
- **Independent code tasks**: After a design is approved, implementation of separate modules or writing tests alongside documentation can happen concurrently
- **Multi-format generation**: Produce different output formats (PDF report, slide deck, executive summary) from the same source artifact in parallel

The key question is: **does stage B need to read stage A's output?** If not, they can be parallel.

```yaml
- parallel:
    on_failure: wait_all              # Optional. "fail_fast" (default) or "wait_all".
    stages:
      - name: blog-post
        type: pge
        task: "Write the launch blog post."
        # ... full stage config
      - name: release-notes
        type: agent
        task: "Write release notes."
        agent: copywriter
        output: "{artifact_dir}/release-notes.md"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `on_failure` | string | No | `"fail_fast"` (default): stop group on first failure. `"wait_all"`: let all stages finish. |
| `stages` | Stage[] | Yes | At least 2 stages. Each stage uses the standard schema. |

### Constraints

- **No `human_gate` inside parallel groups** — gates block execution and cannot run alongside other stages
- **No `pipeline` stages inside parallel groups** — sub-pipelines have complex state interactions
- **No `loop` stages inside parallel groups** — loops have iterative state that requires sequential execution
- **No conflicting outputs** — stages in the same group cannot write to the same `output` or `contract.deliverable` path
- **Unique stage names** — all stage names must be unique across the entire pipeline (including inside groups)

### Failure Handling

| Mode | Behavior |
|------|----------|
| `fail_fast` (default) | When one stage fails, remaining unstarted stages are skipped. Already-running stages finish naturally. Pipeline stops after the group. |
| `wait_all` | All stages run to completion regardless of individual failures. Pipeline stops after the group if any stage failed. |

### Resume

When resuming a pipeline that was interrupted during a parallel group, only the stages that didn't complete are re-executed. Completed stages within the group are skipped.

### Example: Parallel Content Creation

```yaml
stages:
  - name: positioning
    type: pge
    # ... defines positioning strategy

  - parallel:
      on_failure: wait_all
      stages:
        - name: blog-post
          type: pge
          task: "Write the launch blog post."
          inputs:
            - "{artifact_dir}/positioning.md"
          # ... PGE config
        - name: release-notes
          type: agent
          task: "Write release notes."
          agent: copywriter
          output: "{artifact_dir}/release-notes.md"

  - name: launch-approval
    type: human_gate
    prompt: "Review all materials."
```

## Variables

### Syntax

Use `{variable_name}` in any string field. Unresolved placeholders are left as-is. Variable values can reference other variables — resolution is recursive:

```yaml
variables:
  artifact_dir: "docs/projects/{project}"   # {project} resolves within the value
```

### Built-in Variables

| Variable | Source | Example |
|----------|--------|---------|
| `{project}` | CLI `--project` flag | `"myapp"` |
| `{project_dir}` | CLI `--project-dir` or cwd | `/path/to/project` |
| `{artifact_dir}` | Resolved artifact directory | `docs/projects/myapp/pipeline-name` |
| `{pipeline_name}` | Pipeline `name` field | `"feature-dev"` |

### Precedence (highest wins)

1. CLI: `--var key=value`
2. Stage-level: `variables` block on the stage
3. Pipeline-level: top-level `variables` block
4. Built-in variables

### Example

```yaml
name: sprint-cycle
variables:
  sprint: "1"

stages:
  - name: implement
    type: agent
    task: "Implement sprint {sprint}."
    agent: implementer
    output: "{artifact_dir}/sprint-{sprint}-complete.md"
```

Override at CLI: `cccp run -f sprint.yaml -p app -v sprint=3`

## Model and Effort

Control which Claude model and effort level each agent dispatch uses. Both are optional — omitting them inherits from the Claude Code environment.

### Resolution Order (highest priority wins)

1. **Agent config** — `planner.effort: medium`, `generator.model: sonnet`
2. **Stage level** — `effort: high` on the PGE/agent stage
3. **Phase defaults** — `phase_defaults.planner.effort: medium` at pipeline level
4. **Pipeline level** — `effort: high` at the top of the YAML

### Valid Values

- **`model`**: Any Claude CLI model alias (`haiku`, `sonnet`, `opus`) or full model name (`claude-sonnet-4-6`)
- **`effort`**: `low`, `medium`, `high`, `max` (max is Opus only)

### Example

```yaml
name: my-pipeline
effort: high
phase_defaults:
  planner:
    effort: medium          # all planners use medium unless overridden
  evaluator:
    model: haiku
    effort: low             # evaluators are cheap and fast

stages:
  - name: implement
    type: pge
    planner:
      agent: architect
      # inherits effort: medium from phase_defaults.planner
    generator:
      agent: implementer
      model: sonnet         # agent-level override
    evaluator:
      agent: reviewer
      # inherits model: haiku, effort: low from phase_defaults.evaluator
    contract:
      deliverable: "{artifact_dir}/output.md"
      max_iterations: 3

  - name: quick-check
    type: agent
    agent: analyst
    model: haiku
    effort: low             # stage-level override for simple agent stage
    output: "{artifact_dir}/analysis.md"
```

## Agent Resolution

### Search Order (first match wins)

1. `<pipeline-dir>/agents/<agent>.md`
2. `<project-dir>/.claude/agents/<agent>.md`
3. `<project-dir>/.claude/agents/<agent>/agent.md` (directory agent)
4. `<project-dir>/agents/<agent>.md`
5. Paths from `cccp.yaml` → `agent_paths`

### Flat vs Directory Agents

**Flat agent**: Single `.md` file. Cannot use `operation`.
```yaml
agent: researcher    # resolves to researcher.md
```

**Directory agent**: Folder with `agent.md` + operation files. Use `operation` to specialize.
```yaml
agent: architect
operation: design    # resolves to architect/agent.md + architect/design.md
```

### Direct Paths

If the agent name contains `/` or ends in `.md`, it's treated as a direct path:
```yaml
agent: ./custom-agents/my-agent.md
```

## Project Configuration (`cccp.yaml`)

```yaml
agent_paths:                           # Additional agent search directories
  - ./agents
  - ./shared-agents

artifact_dir: "docs/projects/{project}/{pipeline_name}"  # Artifact path pattern

default_mcp_profile: base              # Fallback MCP profile

permission_mode: bypassPermissions     # default | acceptEdits | bypassPermissions | auto

mcp_profiles:
  base:
    servers:
      qmd:
        command: qmd
        args: [serve, --stdio]
  advanced:
    extends: base                      # Inherits base servers
    servers:
      figma:
        command: npx
        args: [-y, figma-console-mcp]
```

### MCP Configuration

MCP profiles control which MCP servers an agent can access. Agents are **fully isolated** — they only see servers from their assigned profile. They never inherit MCP servers from the project's `.mcp.json`.

#### Server definition

Each server entry takes:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | Yes | The executable to run |
| `args` | string[] | No | Command-line arguments |
| `env` | map | No | Environment variables for the server process |

#### Profile inheritance

Profiles support single `extends` inheritance. Child profiles inherit all parent servers and can add or override by name:

```yaml
mcp_profiles:
  base:
    servers:
      qmd:
        command: qmd
        args: [serve, --stdio]
  research:
    extends: base                    # inherits qmd
    servers:
      web:
        command: npx
        args: [-y, web-search-mcp]
```

#### Profile resolution order (highest priority wins)

1. **Agent-level** `mcp_profile` (on planner/generator/evaluator/body stage config)
2. **Stage-level** `mcp_profile`
3. **`default_mcp_profile`** from `cccp.yaml`
4. No MCP servers (no `--mcp-config` passed)

#### `allowed_tools` vs `mcp_profile`

These are **orthogonal controls** over agent capabilities:

- **`allowed_tools`** restricts **built-in tools** (Read, Write, Bash, Grep, etc.)
- **`mcp_profile`** controls **MCP server access** (which external tool servers the agent can reach)

They compose independently. An agent can have restricted built-in tools but full MCP access, or vice versa:

```yaml
- name: research
  type: agent
  agent: researcher
  mcp_profile: research              # full MCP access (qmd, web)
  allowed_tools: [Read, Grep, Glob]  # read-only built-in tools
```

## Conditional Execution & Stage Outputs

### `outputs:` — Structured data from stages

Stages can declare structured outputs. The runner tells the agent to write `.outputs.json`:

```yaml
- name: research
  type: agent
  agent: researcher
  task: "Analyze feasibility."
  outputs:
    decision: "proceed or abandon"
    risk_level: "low, medium, or high"
```

After the stage passes, the runner reads `{artifactDir}/{stageName}/.outputs.json` and validates all keys. Output values become variables: `{research.decision}`, `{research.risk_level}`.

Works with all stage types including PGE. For PGE stages, the **generator** receives the outputs path and keys in its prompt, and the **evaluator** receives guidance to verify `.outputs.json` exists with all declared keys (missing file = automatic FAIL).

### `when:` — Conditional stage execution

Skip a stage unless conditions are met:

```yaml
- name: design
  type: pge
  when: "research.decision == proceed"
```

Multiple conditions (AND — all must be true):

```yaml
- name: high-risk-review
  type: human_gate
  when:
    - "research.decision == proceed"
    - "research.risk_level == high"
```

**Condition syntax:** `stageName.key == value` or `stageName.key != value`. The reserved key `status` refers to the stage's execution status (passed/failed/skipped/error).

**Rules:**
- Referenced stages must appear earlier in execution order
- Cannot reference stages in the same parallel group
- Output keys must be lowercase identifiers, cannot be `status`
- Skipped stages produce no outputs; downstream `==` checks fail, `!=` checks pass
- Stage status is set to `skipped` when conditions are not met

## Complete Examples

### Example 1: Minimal Agent Pipeline

A simple three-stage pipeline: research, review, approve.

```yaml
name: example
description: Research, write, review with human approval.

stages:
  - name: research
    type: agent
    task: "Research the project and write a summary."
    agent: researcher
    output: "{artifact_dir}/research.md"

  - name: review
    type: pge
    task: "Write a technical document and evaluate it."
    inputs:
      - "{artifact_dir}/research.md"
    planner:
      agent: architect
      operation: plan-authoring
    generator:
      agent: writer
    evaluator:
      agent: reviewer
    contract:
      deliverable: "{artifact_dir}/document.md"
      guidance: "All required sections must be present and technically accurate."
      max_iterations: 3
    on_fail: stop

  - name: approval
    type: human_gate
    prompt: "Please review the document and approve."
    artifacts:
      - "{artifact_dir}/document.md"
```

### Example 2: Feature Development (PGE + Human Gates)

Full SDLC: spec, design, implement, test, ship.

```yaml
name: feature-development
description: Full feature development cycle — spec, design, implement, test, ship.

stages:
  - name: product-spec
    type: pge
    task: "Write a product requirements document based on the feature brief."
    inputs:
      - "{artifact_dir}/feature-brief.md"
    planner:
      agent: product-manager
      operation: spec-writing
    generator:
      agent: product-manager
      operation: spec-writing
    evaluator:
      agent: reviewer
    contract:
      deliverable: "{artifact_dir}/prd.md"
      guidance: "Must include user stories, acceptance criteria, scope boundaries, success metrics, and dependencies."
      max_iterations: 3

  - name: spec-approval
    type: human_gate
    prompt: "Review the PRD. Approve to proceed to technical design."
    artifacts:
      - "{artifact_dir}/prd.md"

  - name: technical-design
    type: pge
    task: "Design the technical architecture for this feature."
    inputs:
      - "{artifact_dir}/prd.md"
    planner:
      agent: architect
      operation: design
    generator:
      agent: architect
      operation: design
    evaluator:
      agent: reviewer
    contract:
      deliverable: "{artifact_dir}/design.md"
      guidance: "Architecture must address all PRD requirements. Include component diagram, API contracts, and data flow."
      max_iterations: 3

  - name: design-approval
    type: human_gate
    prompt: "Review the technical design. Approve to proceed to implementation."
    artifacts:
      - "{artifact_dir}/design.md"

  - name: implementation
    type: pge
    task: "Implement the feature according to the design."
    inputs:
      - "{artifact_dir}/prd.md"
      - "{artifact_dir}/design.md"
    planner:
      agent: architect
      operation: task-planning
    generator:
      agent: implementer
    evaluator:
      agent: code-reviewer
    contract:
      deliverable: "{artifact_dir}/implementation-report.md"
      guidance: "All PRD acceptance criteria must be met. Tests required for new code paths."
      max_iterations: 5
    on_fail: human_gate

  - name: test-suite
    type: pge
    task: "Write comprehensive tests for the implemented feature."
    inputs:
      - "{artifact_dir}/design.md"
      - "{artifact_dir}/implementation-report.md"
    planner:
      agent: qa-engineer
      operation: test-planning
    generator:
      agent: qa-engineer
      operation: test-authoring
    evaluator:
      agent: code-reviewer
    contract:
      deliverable: "{artifact_dir}/test-report.md"
      guidance: "Critical paths must have coverage. Edge cases and error conditions must be tested."
      max_iterations: 3

  - name: ship-approval
    type: human_gate
    prompt: "Implementation and tests complete. Approve to ship."
    artifacts:
      - "{artifact_dir}/implementation-report.md"
      - "{artifact_dir}/test-report.md"
```

### Example 3: Autoresearch Loop

Iterative prompt optimization against ground truth.

```yaml
name: prompt-tuning
description: Tunes a prompt until output matches expected result.

stages:
  - name: tune-summarization-prompt
    type: autoresearch
    task: >
      Use the prompt artifact to summarize the source material.
      Read the prompt at the artifact path, follow its instructions,
      and apply them to the source material to produce a summary.
    artifact: autoresearch-artifacts/prompt.md
    ground_truth: autoresearch-artifacts/expected-output.md
    output: "{artifact_dir}/actual-output.md"
    inputs:
      - autoresearch-artifacts/source-material.md
    adjuster:
      agent: prompt-tuner
    executor:
      agent: summarizer
    evaluator:
      agent: diff-evaluator
    # No max_iterations — runs until PASS
```

### Example 4: Loop (QA Review Cycle)

Iterative fix-test-review cycle until QA passes.

```yaml
name: qa-loop
description: Fix issues, test, and review until passing.

stages:
  - name: implement
    type: agent
    agent: implementer
    task: "Implement the feature described in the spec."
    inputs:
      - "{artifact_dir}/feature-spec.md"
    output: "{artifact_dir}/implementation-report.md"

  - name: qa-cycle
    type: loop
    task: "Fix issues and review until QA passes"
    max_iterations: 5
    inputs:
      - "{artifact_dir}/feature-spec.md"
      - "{artifact_dir}/implementation-report.md"
    stages:
      - name: fix
        agent: implementer
        task: "Fix the issues identified in the review"
        skip_first: true
      - name: test
        agent: qa-engineer
        task: "Run the full test suite"
        output: "{artifact_dir}/qa-cycle/test-results.md"
    evaluator:
      agent: reviewer
      task: "Review implementation quality and test results"
      inputs:
        - "{artifact_dir}/qa-cycle/test-results.md"
    on_fail: human_gate
```

### Example 5: Pipeline Composition (Sub-Pipelines)

Master pipeline that delegates to reusable sub-pipelines.

```yaml
name: full-build
description: Master build — research, then delegate docs and tests to sub-pipelines.

stages:
  - name: research
    type: agent
    task: "Research the project and produce a summary."
    agent: researcher
    output: "{artifact_dir}/research.md"

  - name: documentation
    type: pipeline
    file: pipelines/build-docs.yaml
    variables:
      source: "{artifact_dir}/research.md"
    on_fail: human_gate

  - name: test-suite
    type: pipeline
    file: pipelines/run-tests.yaml
    artifact_dir: "{artifact_dir}/tests"
    on_fail: skip

  - name: ship-approval
    type: human_gate
    prompt: "Docs and tests complete. Approve to ship."
    artifacts:
      - "{artifact_dir}/research.md"
```

## Patterns

### Input Chaining

Pass the output of one stage as input to the next:

```yaml
stages:
  - name: research
    type: agent
    agent: researcher
    output: "{artifact_dir}/research.md"

  - name: write
    type: agent
    agent: writer
    inputs:
      - "{artifact_dir}/research.md"        # Output from previous stage
    output: "{artifact_dir}/document.md"
```

### Sprint Variables

Parameterize pipelines for reuse across sprints:

```yaml
variables:
  sprint: "1"

stages:
  - name: brief
    type: agent
    agent: architect
    operation: sprint-brief
    output: "{artifact_dir}/sprint-{sprint}-brief.md"

  - name: implement
    type: pge
    plan: "{artifact_dir}/sprint-{sprint}-brief.md"
    # ...
```

Run: `cccp run -f sprint.yaml -p app -v sprint=3`

### Escalation on Failure

Use `on_fail: human_gate` for critical stages so failures get human review instead of halting:

```yaml
contract:
  deliverable: "{artifact_dir}/output.md"
  max_iterations: 5
on_fail: human_gate    # Pause for human instead of stopping
```

Use `on_fail: skip` for non-critical stages that shouldn't block the pipeline:

```yaml
on_fail: skip          # Continue pipeline even if this stage fails
```

### Different Agents per PGE Role

The planner, generator, and evaluator can be completely different agents with different MCP profiles:

```yaml
planner:
  agent: architect
  operation: task-planning
  mcp_profile: research          # Planner gets research tools
generator:
  agent: implementer
  mcp_profile: dev-tools         # Generator gets dev tools
evaluator:
  agent: code-reviewer
  mcp_profile: base              # Evaluator gets minimal tools
```

### Task from File

For complex tasks that don't fit inline in YAML:

```yaml
- name: implement
  type: pge
  task_file: "{artifact_dir}/task-spec.md"   # Read task from file at runtime
  # ...
```

The path is interpolated with variables before reading.

### Sub-Pipeline Composition

Break large pipelines into reusable pieces:

```yaml
# pipelines/sprint.yaml — reusable sprint execution
name: sprint-execution
stages:
  - name: implement
    type: pge
    plan: "{artifact_dir}/brief.md"
    planner:
      agent: architect
      operation: task-planning
    generator:
      agent: implementer
    evaluator:
      agent: code-reviewer
    contract:
      deliverable: "{artifact_dir}/sprint-complete.md"
      max_iterations: 5

# pipelines/master.yaml — composes sprint pipelines
name: master-plan
stages:
  - name: plan
    type: agent
    agent: architect
    operation: sprint-brief
    output: "{artifact_dir}/brief.md"
  - name: execute
    type: pipeline
    file: pipelines/sprint.yaml
```

Child pipelines share `{project}` and `{project_dir}` but get their own `{pipeline_name}` and optionally scoped `{artifact_dir}`.

## Validation

Dry-run to verify a pipeline without executing:

```bash
npx @alevental/cccp@latest run -f pipeline.yaml -p test --dry-run
```

This shows all assembled prompts, resolved agent paths, and interpolated variables without dispatching any agents.

## Updating This Skill

This skill ships with the `@alevental/cccp` package. To get the latest version (e.g. after a package update):

```bash
npx @alevental/cccp@latest update-skills
```

This overwrites `/cccp-pipeline` and `/cccp-run` skills with the latest content without touching agents, pipelines, or project config.
