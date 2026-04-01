# Agent Authoring

Agents in CCCP are markdown files that define system prompts for Claude Code subprocesses. They can be simple flat files or directory-based agents with multiple operations.

**Source files:**
- [`src/agent-resolver.ts`](../../src/agent-resolver.ts) -- search path resolution
- [`src/prompt.ts`](../../src/prompt.ts) -- markdown loading, task context assembly

## Agent Formats

### Flat-file agent

A single `.md` file containing the agent's system prompt:

```
agents/
  researcher.md          # Engineering: research and analysis
  reviewer.md            # General-purpose evaluator
  implementer.md         # Engineering: code generation
  code-reviewer.md       # Engineering: code evaluation (PASS/FAIL format)
  copywriter.md          # Marketing: long-form content
  analyst.md             # Strategy: data and metrics analysis
  exec-reviewer.md       # Strategy: executive-level evaluation
  growth-strategist.md   # Growth: experiment design
  ops-manager.md         # Operations: runbook and process authoring
  devops.md              # Operations: infrastructure review
  writer.md              # General-purpose document generation
```

Example flat-file agent (`agents/code-reviewer.md`):

```markdown
---
name: code-reviewer
description: Reviews code against a contract and produces a PASS/FAIL evaluation.
---

# Code Reviewer

You are a code review agent. Evaluate deliverables against acceptance criteria.

## Instructions

1. Read the contract to understand the acceptance criteria
2. Read the deliverable code
3. For each criterion, determine PASS or FAIL with specific evidence
4. Write your evaluation using this format:

### Criterion Results

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | [name]    | PASS/FAIL | [specific evidence] |

### Overall: PASS / FAIL

### Iteration Guidance (if FAIL)

1. [Specific fix needed]
```

The YAML frontmatter (`---` delimited) is optional and informational. The entire file content (including frontmatter) is passed as the system prompt via `--append-system-prompt-file`.

### Directory-style agent

A directory containing `agent.md` (the base prompt) and one or more operation files:

```
agents/
  architect/                  # Engineering: architecture and planning
    agent.md                  # Base agent definition (always loaded)
    design.md                 # Operation: technical design
    task-planning.md          # Operation: implementation task breakdown
    sprint-brief.md           # Operation: sprint brief generation
    sprint-review.md          # Operation: sprint quality review
    health-assessment.md      # Operation: service health assessment
  product-manager/            # Product: requirements and prioritization
    agent.md
    spec-writing.md           # Operation: PRD authoring
    prioritization.md         # Operation: backlog prioritization
  marketer/                   # Marketing: strategy and content planning
    agent.md
    positioning.md            # Operation: product positioning
    launch-plan.md            # Operation: launch planning
    content.md                # Operation: content strategy and planning
  qa-engineer/                # Engineering: test planning and authoring
    agent.md
    test-planning.md          # Operation: test plan creation
    test-authoring.md         # Operation: test implementation
  strategist/                 # Strategy: business and competitive analysis
    agent.md
    competitive-analysis.md   # Operation: competitive landscape
    quarterly-planning.md     # Operation: OKR and roadmap planning
    business-case.md          # Operation: business case authoring
  designer/                   # Design: UX research and design specs
    agent.md
    ux-research.md            # Operation: user research synthesis
    design-spec.md            # Operation: design specification
    design-review.md          # Operation: design evaluation
  customer-success/           # Customer Success: feedback analysis
    agent.md
    feedback-synthesis.md     # Operation: feedback theme synthesis
```

When a directory agent is invoked with an operation, the base `agent.md` and the operation file are concatenated with a separator:

```typescript
// From src/prompt.ts
const base = await readFile(agentPath, "utf-8");
const opContent = await readFile(operationFile, "utf-8");
return `${base}\n\n---\n\n${opContent}`;
```

This allows the base agent to define the agent's identity and capabilities, while operations specialize it for specific tasks.

#### Using operations in pipelines

```yaml
stages:
  - name: technical-design
    type: pge
    task: "Design the technical architecture for this feature."
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
      max_iterations: 3

  - name: implement
    type: pge
    task: "Implement the feature according to the design."
    inputs:
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
      max_iterations: 5
    on_fail: human_gate
```

## Search Path Resolution

**File:** `src/agent-resolver.ts`

The resolver searches for agents in multiple directories, in priority order:

### Default search paths (built by `src/cli.ts`)

1. `<pipeline-yaml-dir>/agents/` -- agents co-located with the pipeline
2. `<project-dir>/.claude/agents/` -- project-level agent directory
3. `<project-dir>/agents/` -- another common convention
4. Paths from `agent_paths` in `cccp.yaml`

### Resolution algorithm

For each search directory, the resolver tries (first match wins):

1. **Flat file:** `<dir>/<agent>.md`
2. **Directory agent:** `<dir>/<agent>/agent.md`

If an `operation` is specified and the agent is directory-style, it also resolves `<dir>/<agent>/<operation>.md`.

### Direct path mode

If the agent name contains `/` or ends in `.md`, it is treated as a direct path (absolute or relative to the project directory):

```yaml
agent: ./custom-agents/my-agent.md           # Relative to project dir
agent: /absolute/path/to/agent.md            # Absolute path
agent: my-agents/special/agent.md            # Relative path with directory
```

### Error handling

The resolver provides clear error messages:

```
Agent "architect" not found. Searched:
  - /project/pipelines/agents
  - /project/.claude/agents
  - /project/agents
```

```
Agent "code-reviewer" is a flat file and does not support operation "deep-analysis"
```

```
Operation "nonexistent" not found for agent "architect" at: /project/agents/architect/nonexistent.md
```

### `ResolvedAgent` type

```typescript
export interface ResolvedAgent {
  /** Absolute path to the agent's main markdown file. */
  agentPath: string;
  /** Absolute path to the operation file (if applicable). */
  operationPath?: string;
  /** Whether this is a directory-style agent. */
  isDirectory: boolean;
}
```

### Listing operations

The `listOperations()` function returns all available operations for a directory-style agent:

```typescript
const ops = await listOperations("architect", searchPaths);
// ["design", "health-assessment", "sprint-brief", "sprint-review", "task-planning"]
```

It reads the agent directory and returns all `.md` files except `agent.md`, with the extension stripped.

## Task Context (User Prompt)

**File:** `src/prompt.ts`

The user prompt (passed via `-p` to Claude) is assembled from the pipeline stage configuration using `buildTaskContext()`:

```typescript
export interface TaskContext {
  task: string;                          // What the agent should do
  inputs?: string[];                     // Files to read first
  output?: string;                       // Where to write output
  previousEvaluation?: string;           // Previous eval (PGE retry)
  iteration?: number;                    // Current iteration (1-based)
  maxIterations?: number;                // Max iterations
  contractPath?: string;                 // Contract file path
  extra?: Record<string, string>;        // Additional context
}
```

### Generated prompt format

```markdown
# Task

Research the project and write a summary.

## Contract

Read the contract at: /path/to/contract.md

## Inputs

- /path/to/input1.md
- /path/to/input2.md

## Output

Write your output to: /path/to/output.md

## Previous Evaluation

Your previous attempt was evaluated. Read the feedback at: /path/to/evaluation-1.md
Address all issues identified in the evaluation before producing your revised output.

## Iteration

This is iteration 2 of 3.
```

Sections are only included when the corresponding fields are set. For a simple `agent` stage with just a `task` and `output`, the prompt is minimal.

## System Prompt Assembly

The agent markdown is written to a temporary file and passed via `--append-system-prompt-file`. This means:

1. The project's `CLAUDE.md` is still loaded as the base system prompt
2. The agent markdown is appended, giving it access to project context

```
[Project CLAUDE.md]          -- loaded automatically by Claude
[Agent markdown]             -- appended via --append-system-prompt-file
[Operation markdown]         -- concatenated with agent.md (if applicable)
```

Temp files use the pattern `cccp-agent-<uuid>.md` in `os.tmpdir()`.

## Agent Writing Best Practices

### Structure

```markdown
---
name: agent-name
description: What this agent does.
---

# Agent Name

Brief identity statement: "You are a [role]."

## Context

What the agent needs to know about the project/domain.

## Instructions

Numbered steps for the primary workflow.

## Output Format

Specify the expected output structure.

## Constraints

- What the agent should NOT do
- Quality standards
- File handling rules
```

### For PGE planners

Planners produce a `task-plan.md` that breaks down the work into concrete steps. The planner receives the plan document path (if provided) and stage inputs in the task context.

```markdown
## Instructions

1. Read the plan document and any provided inputs
2. Analyze the codebase to understand the current state
3. Write a detailed task plan to the output path with:
   - Clear objectives
   - Step-by-step breakdown
   - Files to create or modify
   - Acceptance criteria suggestions
```

### For PGE evaluators

Evaluators serve dual roles in PGE stages:

**Contract mode:** The evaluator reads the task plan and writes a contract with verifiable acceptance criteria. It receives the task plan path, any `contract.guidance`, and `contract.template` in the task context.

**Evaluation mode:** The evaluator reads the contract and deliverable, then produces an evaluation. Output must match the regex `### Overall: PASS` or `### Overall: FAIL`:

```markdown
## Instructions (evaluation mode)

1. Read the contract to understand the acceptance criteria
2. Read the deliverable
3. For each criterion, determine PASS or FAIL with specific evidence
4. Write your evaluation using this format:

### Criterion Results

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | [name]    | PASS/FAIL | [specific evidence] |

### Overall: PASS / FAIL

### Iteration Guidance (if FAIL)

1. [Specific fix needed]
```

### For PGE generators

Generators should:
- Read the contract file (path provided in the task context)
- Read the task plan (path provided in the task context)
- If retrying, read the previous evaluation and address all feedback
- Write output to the deliverable path specified in the task

### Tips

- Keep agents focused on a single concern
- Use operations to specialize directory agents for different tasks
- Reference the contract, task plan, and evaluation in PGE agents -- they receive these paths in the task context
- Avoid embedding file paths -- use the `{variable}` system in the pipeline YAML and let the task context provide paths
- Evaluator agents should be designed to work in both contract-writing and evaluation modes

## Related Documentation

- [Agent Dispatch](../patterns/agent-dispatch.md) -- how agents are executed as subprocesses
- [Pipeline Authoring](pipeline-authoring.md) -- referencing agents in stage definitions
- [PGE Cycle](../patterns/pge-cycle.md) -- generator and evaluator agent requirements
- [Configuration](../api/configuration.md) -- `agent_paths` configuration
