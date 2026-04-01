# Pipeline Authoring

Pipelines are YAML files that define a sequence of stages to execute. Each stage dispatches an agent, runs a PGE cycle, or blocks for human approval.

**Source files:**
- [`src/pipeline.ts`](../../src/pipeline.ts) -- Zod schema and loader
- [`src/types.ts`](../../src/types.ts) -- TypeScript type definitions
- [`src/runner.ts`](../../src/runner.ts) -- stage execution logic

## Pipeline Structure

```yaml
name: build-docs                        # Required: pipeline name
description: Build project documentation  # Optional
variables:                               # Optional: default variables
  version: "2.0"
  format: markdown

stages:                                  # Required: at least one stage
  - name: research
    type: agent
    # ...
  - name: review
    type: pge
    # ...
  - name: approval
    type: human_gate
    # ...
```

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Pipeline identifier (used in state, artifacts, display) |
| `description` | `string` | No | Human-readable description |
| `variables` | `Record<string, string>` | No | Default variables available to all stages |
| `stages` | `Stage[]` | Yes | Ordered list of stages (minimum 1) |

### Variable interpolation

Variables use `{variable_name}` syntax and are available in string fields like `output`, `inputs`, `deliverable`, and `artifacts`. Built-in variables are always available:

| Variable | Source |
|----------|--------|
| `{project}` | `--project` CLI flag |
| `{project_dir}` | `--project-dir` CLI flag or cwd |
| `{artifact_dir}` | Resolved artifact directory |
| `{pipeline_name}` | Pipeline `name` field |

Pipeline-level `variables` are merged with built-ins, then CLI `--var` flags override everything. Stage-level `variables` override pipeline-level for that stage only.

## Stage Types

All stages share these base fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Unique stage identifier |
| `task` | `string` | No | Task instruction for the agent |
| `task_file` | `string` | No | Path to file containing task (mutually exclusive with `task`) |
| `type` | `"agent" \| "pge" \| "autoresearch" \| "pipeline" \| "human_gate"` | Yes | Stage discriminator |
| `mcp_profile` | `string` | No | Named MCP profile from `cccp.yaml` |
| `variables` | `Record<string, string>` | No | Stage-level variable overrides |

---

### `agent` -- Simple Agent Dispatch

Dispatches a single agent to perform a task.

```yaml
- name: service-assessment
  type: agent
  task: "Assess the service architecture and identify failure modes."
  agent: architect
  operation: health-assessment    # Optional: for directory-style agents
  mcp_profile: base               # Optional: MCP server profile
  inputs:                          # Optional: files the agent should read
    - "{artifact_dir}/context.md"
  output: "{artifact_dir}/service-assessment.md"  # Optional: expected output file
  allowed_tools:                   # Optional: restrict available tools
    - Read
    - Write
    - Grep
  variables:                       # Optional: stage-level variable overrides
    depth: detailed
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | `string` | Yes | Agent name (resolved via search paths) or direct path |
| `operation` | `string` | No | Operation name for directory-style agents |
| `inputs` | `string[]` | No | File paths passed to the agent as context |
| `output` | `string` | No | Expected output file path (checked after execution) |
| `allowed_tools` | `string[]` | No | Explicit tool allowlist passed to Claude |

If `output` is specified, the runner verifies the file exists after the agent completes and throws `MissingOutputError` if absent.

---

### `pge` -- Plan-Generate-Evaluate Cycle

Runs a planner -> contract -> generate -> evaluate loop with automatic retries on the generator/evaluator cycle.

```yaml
# From feature-development.yaml — implementation stage
- name: implementation
  type: pge
  task: "Implement the feature according to the design."
  inputs:                                # Optional: stage-level inputs shared across all agents
    - "{artifact_dir}/prd.md"
    - "{artifact_dir}/design.md"
  planner:
    agent: architect
    operation: task-planning             # Optional: for directory-style agents
    mcp_profile: research-tools          # Optional: overrides stage-level
  generator:
    agent: implementer
    mcp_profile: writing-tools           # Optional
    allowed_tools:                       # Optional
      - Read
      - Write
  evaluator:
    agent: code-reviewer
    mcp_profile: review-tools            # Optional
    allowed_tools:
      - Read
      - Write
  contract:
    deliverable: "{artifact_dir}/implementation-report.md"
    template: templates/implementation-contract.md  # Optional: structural guide for contract writer
    guidance: |                          # Optional: free-form guidance for planner and contract writer
      All PRD acceptance criteria must be met. Tests required for new code paths.
    max_iterations: 5
  on_fail: human_gate                    # Optional: stop | human_gate | skip
```

#### PGE flow

1. **Planner** dispatched -- reads plan document + codebase, writes `task-plan.md`
2. **Evaluator (contract mode)** dispatched -- reads task plan, writes `contract.md` with verifiable acceptance criteria
3. **Generator** dispatched -- reads contract + task plan, produces deliverable
4. **Evaluator (evaluation mode)** dispatched -- reads contract + deliverable, writes evaluation
5. Parse `### Overall: PASS/FAIL`, retry generator/evaluator loop or escalate

#### Planner, generator, and evaluator

All three share the same `PgeAgentConfig` shape:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | `string` | Yes | Agent name |
| `operation` | `string` | No | Operation for directory-style agents |
| `mcp_profile` | `string` | No | MCP profile override |
| `allowed_tools` | `string[]` | No | Tool allowlist |
| `inputs` | `string[]` | No | Agent-specific input files (merged with stage-level `inputs`) |

#### Input merging

Inputs are available at two levels:

- **Stage-level `inputs`** -- shared across all agents (planner, generator, evaluator)
- **Agent-level `inputs`** -- specific to each agent

Resolution: `effectiveInputs = [...stageInputs, ...agentInputs]`, all interpolated with variables.

#### Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deliverable` | `string` | Yes | Path where the generator writes output |
| `max_iterations` | `number` | Yes | 1-10 retry attempts |
| `template` | `string` | No | Structural guide for the evaluator when writing the contract |
| `guidance` | `string` | No | Free-form guidance for planner and contract writer |

The contract is written by the evaluator agent (in contract mode), not mechanically generated. The evaluator reads the task plan and produces a contract with verifiable acceptance criteria.

#### Escalation strategies (`on_fail`)

Controls what happens when `max_iterations` are exhausted with a FAIL verdict:

| Strategy | Behavior |
|----------|----------|
| `stop` (default) | Stage fails, pipeline stops |
| `human_gate` | Creates a human gate; approval continues pipeline, rejection stops |
| `skip` | Stage is marked `skipped`, pipeline continues |

See [PGE Cycle](../patterns/pge-cycle.md) for detailed flow documentation.

---

### `human_gate` -- Human Approval Gate

Blocks the pipeline until a human approves or rejects.

```yaml
- name: approval
  type: human_gate
  task: "Review deliverables before deployment."
  prompt: "Please review the documentation and approve for release."
  artifacts:
    - "{artifact_dir}/documentation.md"
    - "{artifact_dir}/changelog.md"
  on_reject: stop                  # Optional: stop | retry
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | `string` | No | Instructions for the reviewer |
| `artifacts` | `string[]` | No | Files the reviewer should inspect |
| `on_reject` | `"stop" \| "retry"` | No | Behavior on rejection (default: `stop`) |

Gate responses come through the MCP server (`cccp_gate_respond` tool) or direct database update. See [Gate System](../architecture/gate-system.md).

---

### `pipeline` -- Sub-Pipeline Composition

Invokes another pipeline YAML as a sub-pipeline. The sub-pipeline runs inline within the parent, shares the same run lifecycle, and its stages appear in the TUI and state tree. This enables composing reusable pipeline fragments without copy-pasting stages.

```yaml
- name: documentation
  type: pipeline
  task: "Build project documentation from research output."
  file: pipelines/build-docs.yaml
  artifact_dir: "{artifact_dir}/docs"    # Optional: scope child artifacts
  on_fail: human_gate                     # Optional: stop | human_gate | skip
  variables:                              # Optional: passed to sub-pipeline
    source: "{artifact_dir}/research.md"
    format: markdown
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | Yes | Path to the sub-pipeline YAML file |
| `artifact_dir` | `string` | No | Override artifact directory for the child pipeline (defaults to parent's) |
| `on_fail` | `EscalationStrategy` | No | Behavior on sub-pipeline failure (default: `"stop"`) |
| `variables` | `Record<string, string>` | No | Variables passed to the sub-pipeline |

**Variable isolation:** The sub-pipeline does **not** inherit parent variables implicitly. Only variables explicitly listed in the `variables` field are passed. Built-in variables (`{project}`, `{project_dir}`, `{artifact_dir}`, `{pipeline_name}`) are recomputed for the sub-pipeline context.

**Cycle detection:** Pipeline nesting is limited to a maximum depth of 5. If a sub-pipeline references itself (directly or transitively), CCCP detects the cycle and fails with an error before execution. The runner tracks visited pipeline file paths to prevent infinite recursion.

**State model:** The sub-pipeline's state is stored as a nested `PipelineState` inside the parent's `StageState` (the `children` field). This keeps the sub-pipeline self-contained and enables recursive resume.

## Complete Example: Cross-Functional Pipeline

This example (from `product-launch.yaml`) shows a cross-functional pipeline spanning research, marketing, and content creation:

```yaml
name: product-launch
description: Product launch pipeline — positioning, launch plan, content creation.

stages:
  # Stage 1: Research agent (flat file) gathers competitive intelligence
  - name: competitive-landscape
    type: agent
    task: "Research the competitive landscape for the product launch."
    agent: researcher
    output: "{artifact_dir}/competitive-research.md"

  # Stage 2: Marketer (directory agent) defines positioning via PGE cycle
  - name: positioning
    type: pge
    task: "Define product positioning and messaging framework."
    inputs:
      - "{artifact_dir}/competitive-research.md"
    planner:
      agent: marketer
      operation: positioning
    generator:
      agent: marketer
      operation: positioning
    evaluator:
      agent: exec-reviewer
    contract:
      deliverable: "{artifact_dir}/positioning.md"
      guidance: "Must include target audience, value propositions, competitive differentiators, and messaging pillars."
      max_iterations: 3

  # Stage 3: Human gate before committing to launch plan
  - name: positioning-approval
    type: human_gate
    prompt: "Review positioning and messaging. Approve to proceed with launch planning."
    artifacts:
      - "{artifact_dir}/positioning.md"

  # Stage 4: Content creation with copywriter and general reviewer
  - name: blog-post
    type: pge
    task: "Write the launch blog post."
    inputs:
      - "{artifact_dir}/positioning.md"
    planner:
      agent: marketer
      operation: content
    generator:
      agent: copywriter
    evaluator:
      agent: reviewer
    contract:
      deliverable: "{artifact_dir}/blog-post.md"
      guidance: "Must align with positioning. Engaging, clear, technically accurate."
      max_iterations: 3

  # Stage 5: Simple agent dispatch for release notes
  - name: release-notes
    type: agent
    task: "Write release notes based on the positioning and launch plan."
    agent: copywriter
    inputs:
      - "{artifact_dir}/positioning.md"
    output: "{artifact_dir}/release-notes.md"
```

## Complete Example: Variable Usage

This example (from `sprint-cycle.yaml`) shows how variables parameterize a reusable pipeline:

```yaml
name: sprint-cycle
description: Single sprint execution — brief, implement, test, review.

variables:
  sprint: "1"                    # Default sprint number; override with --var sprint=2

stages:
  - name: sprint-brief
    type: agent
    task: "Read the master plan and produce the sprint brief for sprint {sprint}."
    agent: architect
    operation: sprint-brief
    output: "{artifact_dir}/sprint-{sprint}-brief.md"

  - name: implement
    type: pge
    task: "Implement all tasks from the sprint brief."
    plan: "{artifact_dir}/sprint-{sprint}-brief.md"
    planner:
      agent: architect
      operation: task-planning
    generator:
      agent: implementer
    evaluator:
      agent: code-reviewer
    contract:
      deliverable: "{artifact_dir}/sprint-{sprint}-complete.md"
      guidance: "All sprint brief tasks must be implemented with passing tests."
      max_iterations: 5
    on_fail: human_gate
```

## Example Pipelines

CCCP ships 10 example pipelines in `examples/` covering 8 functional areas:

| Pipeline | Area | Description |
|----------|------|-------------|
| `feature-development.yaml` | Engineering | Full feature cycle -- spec, design, implement, test, ship |
| `sprint-cycle.yaml` | Engineering | Single sprint execution with variable-driven sprint number |
| `product-launch.yaml` | Product / Marketing | Positioning, launch plan, blog post, release notes |
| `content-calendar.yaml` | Marketing | Plan and produce a month of content |
| `growth-experiment.yaml` | Growth | Funnel analysis, experiment design, campaign copy |
| `quarterly-planning.yaml` | Strategy | Competitive analysis, OKRs, roadmap |
| `business-case.yaml` | Strategy | Market research, financial analysis, business case |
| `design-sprint.yaml` | Design | UX research, product requirements, design spec |
| `customer-feedback-loop.yaml` | Customer Success | Feedback synthesis and backlog prioritization |
| `incident-runbook.yaml` | Operations | Service assessment, runbook authoring, DevOps review |

## Validation

Pipeline YAML is validated against a Zod schema at load time. Common validation errors:

```
Pipeline validation failed for pipelines/build-docs.yaml:
  - stages.0.type: Invalid discriminator value
  - stages.1.planner: Required
  - stages.1.contract.max_iterations: Number must be greater than or equal to 1
```

The schema enforces:
- At least one stage
- Valid `type` discriminator (`agent`, `pge`, `autoresearch`, `pipeline`, `human_gate`)
- PGE stages must have `planner`, `generator`, and `evaluator`
- `max_iterations` between 1 and 10
- `on_fail` must be one of `stop`, `human_gate`, `skip`
- `on_reject` must be one of `stop`, `retry`

## Related Documentation

- [Pipeline Schema](../architecture/pipeline-schema.md) -- complete Zod schema reference
- [Agent Authoring](agent-authoring.md) -- writing agent definitions
- [PGE Cycle](../patterns/pge-cycle.md) -- detailed PGE flow
- [Configuration](../api/configuration.md) -- `cccp.yaml` settings
