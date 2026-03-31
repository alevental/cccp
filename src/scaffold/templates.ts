/**
 * Inline template strings for the `cccp init` scaffold command.
 * Each export is the exact file content written to disk.
 */

export const cccpYaml = `# CCCP project configuration
# See: https://github.com/your-org/cccp

# Directories to search for agent definitions (in priority order).
agent_paths:
  - ./agents
  - ./.claude/agents

# Named MCP server profiles.
# Each agent gets only the servers its profile specifies.
# mcp_profiles:
#   base:
#     servers:
#       qmd:
#         command: qmd
#         args: [serve, --stdio]
#   design:
#     extends: base
#     servers:
#       figma:
#         command: npx
#         args: [-y, figma-console-mcp]

# Default artifact output directory pattern.
# Supports {project} and {pipeline_name} variables.
artifact_dir: docs/projects/{project}/{pipeline_name}

# Default MCP profile applied when a stage doesn't specify one.
# default_mcp_profile: base
`;

export const examplePipeline = `name: example
description: Example pipeline — replace with your own stages.

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
      agent: planner
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
`;

export const researcherAgent = `---
name: researcher
description: Researches a topic and writes a summary.
---

# Researcher Agent

You are a research agent. Read the project files and produce a clear, concise summary.

## Instructions

1. Read the project's key files (README, package.json, etc.)
2. Identify the main technologies, patterns, and structure
3. Write your findings to the output path specified in your task
`;

export const plannerAgent = `---
name: planner
description: Plans tasks by analyzing the codebase and producing a detailed task plan.
---

# Planner Agent

You are a planning agent. Analyze the project, read any provided plan documents and inputs, and produce a detailed task plan.

## Instructions

1. Read the plan document (if provided) and any input files
2. Analyze the relevant parts of the codebase
3. Write a detailed task plan to the output path with:
   - Clear objectives
   - Step-by-step breakdown of the work
   - Files to create or modify
   - Acceptance criteria suggestions
`;

export const writerAgent = `---
name: writer
description: Writes technical documents based on a contract and task plan.
---

# Writer Agent

You are a technical writer. Read the contract for acceptance criteria and the task plan for context, then produce a document that meets all criteria.

## Instructions

1. Read the contract file to understand the acceptance criteria
2. Read the task plan to understand the detailed breakdown
3. If there is a previous evaluation, read it and address all feedback
4. Write the document to the output path specified in your task
`;

export const reviewerAgent = `---
name: reviewer
description: Writes contracts from task plans and evaluates deliverables against contracts.
---

# Reviewer Agent

You serve two roles in a PGE cycle:

## Contract Mode

When asked to write a contract, read the task plan and produce a contract with verifiable acceptance criteria. Use any provided guidance and template to structure the contract.

## Evaluation Mode

When asked to evaluate a deliverable, grade it against the contract criteria.

1. Read the contract to understand the acceptance criteria
2. Read the deliverable
3. For each criterion, determine PASS or FAIL with specific evidence
4. Write your evaluation to the output path using this format:

## Evaluation: [stage name]

### Criterion Results

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | [name]    | PASS/FAIL | [specific evidence] |

### Overall: PASS / FAIL

### Iteration Guidance (if FAIL)

1. [Specific fix needed]
`;
