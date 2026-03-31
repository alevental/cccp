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
| `type` | `"agent" \| "pge" \| "human_gate"` | Yes | Stage discriminator |
| `mcp_profile` | `string` | No | Named MCP profile from `cccp.yaml` |
| `variables` | `Record<string, string>` | No | Stage-level variable overrides |

---

### `agent` -- Simple Agent Dispatch

Dispatches a single agent to perform a task.

```yaml
- name: research
  type: agent
  task: "Research the project and write a summary."
  agent: researcher
  operation: deep-analysis        # Optional: for directory-style agents
  mcp_profile: base               # Optional: MCP server profile
  inputs:                          # Optional: files the agent should read
    - "{artifact_dir}/context.md"
  output: "{artifact_dir}/research.md"  # Optional: expected output file
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
- name: implement-auth
  type: pge
  task: "Sprint 1 > Task 3: Implement OAuth module"
  plan: "{artifact_dir}/master-plan.md"  # Optional: plan document path
  inputs:                                # Optional: stage-level inputs shared across all agents
    - "{artifact_dir}/architecture.md"
  planner:
    agent: architect
    operation: task-planning             # Optional
    mcp_profile: research-tools          # Optional: overrides stage-level
    inputs:                              # Optional: planner-specific inputs
      - "{artifact_dir}/design.md"
  generator:
    agent: implementer
    mcp_profile: writing-tools           # Optional
    inputs:                              # Optional: generator-specific inputs
      - "{artifact_dir}/api-spec.md"
    allowed_tools:                       # Optional
      - Read
      - Write
  evaluator:
    agent: reviewer
    operation: code-review               # Optional
    mcp_profile: review-tools            # Optional
    allowed_tools:
      - Read
      - Write
  contract:
    deliverable: "src/auth/oauth.ts"
    template: templates/implementation-contract.md  # Optional: structural guide for contract writer
    guidance: |                          # Optional: free-form guidance for planner and contract writer
      Must handle backward compatibility.
    max_iterations: 3
  on_fail: stop                          # Optional: stop | human_gate | skip
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

## Complete Example

```yaml
name: feature-docs
description: Generate and review feature documentation.

variables:
  feature_name: authentication
  doc_format: markdown

stages:
  # Stage 1: Research the codebase
  - name: research
    type: agent
    task: "Analyze the {feature_name} feature and document findings."
    agent: researcher
    output: "{artifact_dir}/research.md"

  # Stage 2: Write documentation with quality loop
  - name: write-docs
    type: pge
    task: "Write comprehensive {feature_name} documentation."
    inputs:
      - "{artifact_dir}/research.md"
    planner:
      agent: architect
      operation: doc-planning
    generator:
      agent: writer
      operation: feature-docs
    evaluator:
      agent: reviewer
    contract:
      deliverable: "{artifact_dir}/{feature_name}-docs.md"
      guidance: |
        Focus on public APIs, configuration options, and error handling.
        Include working code examples for every major use case.
      max_iterations: 3
    on_fail: human_gate

  # Stage 3: Human review before publishing
  - name: final-review
    type: human_gate
    prompt: "Review the {feature_name} documentation. Check for accuracy and completeness."
    artifacts:
      - "{artifact_dir}/{feature_name}-docs.md"
      - "{artifact_dir}/research.md"

  # Stage 4: Publish (post-approval)
  - name: publish
    type: agent
    task: "Move approved docs to the docs/ directory and update the index."
    agent: publisher
    inputs:
      - "{artifact_dir}/{feature_name}-docs.md"
```

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
- Valid `type` discriminator (`agent`, `pge`, `human_gate`)
- PGE stages must have `planner`, `generator`, and `evaluator`
- `max_iterations` between 1 and 10
- `on_fail` must be one of `stop`, `human_gate`, `skip`
- `on_reject` must be one of `stop`, `retry`

## Related Documentation

- [Pipeline Schema](../architecture/pipeline-schema.md) -- complete Zod schema reference
- [Agent Authoring](agent-authoring.md) -- writing agent definitions
- [PGE Cycle](../patterns/pge-cycle.md) -- detailed PGE flow
- [Configuration](../api/configuration.md) -- `cccp.yaml` settings
