# CCCP

**Claude Code and Cmux Pipeline Reagent** — deterministic YAML-based pipeline orchestration for workflows built around [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [cmux](https://github.com/manaflow-ai/cmux).

## The problem

Complex multi-stage workflows (SDLC pipelines, research pipelines, content pipelines) rely on Claude as a "file-routing state machine" — dispatching agents, reading evaluations, routing on PASS/FAIL. Over long runs, context degrades: Claude forgets iteration counts, skips sub-stages, misreads evaluations, or loses routing logic.

## The solution

CCCP moves the state machine into deterministic TypeScript code. It reads YAML pipeline definitions, dispatches agents via `claude -p` (each with fresh context), parses evaluations with regex, and routes without interpretation. A cmux split-pane dashboard shows live progress. Human approval gates are handled via an MCP server.

- Uses Max subscription — no API keys needed
- Each agent gets a fresh context window
- Evaluation routing is regex, not interpretation
- State persists to disk — resume after crashes
- Works with any project, any agents, any workflow

## Install

```bash
npm install @alevental/cccp
```

Or use npx (no install):

```bash
npx @alevental/cccp <command>
```

## Quick start

Scaffold a project:

```bash
cd my-project
npx @alevental/cccp init
```

This creates:

```
cccp.yaml                               — project configuration
pipelines/example.yaml                   — example pipeline
.claude/agents/researcher.md             — research agent
.claude/agents/writer.md                 — document writer
.claude/agents/reviewer.md               — evaluation agent
.claude/agents/architect/agent.md        — system architect
.claude/skills/cccp-run/SKILL.md         — /cccp-run skill
.claude/skills/cccp-pipeline/SKILL.md    — /cccp-pipeline skill
```

For all template agents and example pipelines:

```bash
npx @alevental/cccp examples
```

Preview what the pipeline will do:

```bash
npx @alevental/cccp run -f pipelines/example.yaml -p my-project --dry-run
```

Run it for real:

```bash
npx @alevental/cccp run -f pipelines/example.yaml -p my-project
```

## Pipeline YAML

Pipelines are sequences of typed stages, with optional parallel groups for concurrent execution:

```yaml
name: my-pipeline
description: What this pipeline does.

stages:
  # Simple agent dispatch
  - name: research
    type: agent
    agent: researcher
    output: "{artifact_dir}/research.md"

  # Plan-Generate-Evaluate with retry loop
  - name: design
    type: pge
    task: "Design the system architecture."
    inputs:
      - "{artifact_dir}/research.md"
    planner:
      agent: architect
      operation: task-planning
    generator:
      agent: architect
      operation: design        # optional sub-operation
      mcp_profile: base        # optional MCP server profile
    evaluator:
      agent: reviewer
    contract:
      deliverable: "{artifact_dir}/design.md"
      guidance: "System must be modular with documented data flow."
      max_iterations: 3
    on_fail: stop              # stop | skip | human_gate

  # Sub-pipeline composition
  - name: documentation
    type: pipeline
    file: pipelines/build-docs.yaml
    variables:
      source: "{artifact_dir}/design.md"

  # Run independent stages concurrently
  - parallel:
      on_failure: wait_all
      stages:
        - name: blog-post
          type: agent
          agent: copywriter
          output: "{artifact_dir}/blog-post.md"
        - name: release-notes
          type: agent
          agent: copywriter
          output: "{artifact_dir}/release-notes.md"

  # Human approval gate
  - name: approval
    type: human_gate
    prompt: "Review the design. Approve to proceed."
    artifacts:
      - "{artifact_dir}/design.md"
```

### Stage types

| Type | What it does |
|------|-------------|
| `agent` | Dispatch one agent, collect output |
| `pge` | Dispatch planner -> evaluator writes contract -> dispatch generator -> dispatch evaluator -> parse `### Overall: PASS/FAIL` -> retry generator/evaluator on FAIL up to `max_iterations` |
| `autoresearch` | Iterative artifact optimization — adjust artifact, execute task, evaluate against ground truth, retry on FAIL |
| `pipeline` | Invoke another pipeline YAML as a sub-pipeline — runs inline, shares the parent run lifecycle |
| `human_gate` | Block until approved via MCP tool call or state file edit |

Stages can also be wrapped in a `parallel` block to run concurrently. See the [pipeline skill](.claude/skills/cccp-pipeline/SKILL.md) for the full schema.

### Variables

Built-in variables available in all string fields:

| Variable | Value |
|----------|-------|
| `{project}` | Project name from `--project` |
| `{project_dir}` | Project directory |
| `{artifact_dir}` | Resolved artifact output directory |
| `{pipeline_name}` | Pipeline name |
| `{iteration}` | Current PGE iteration (1-based) |

## Agents

CCCP ships 18 template agents as starting points. Run `npx @alevental/cccp examples` to scaffold all of them into your project. Agents are markdown files that become the `--system-prompt-file` for `claude -p`.

**Flat file agent** (`agents/implementer.md`):
```markdown
---
name: implementer
description: Implements code changes.
---

# Implementer Agent

Your instructions here...
```

**Directory agent with operations** (`agents/architect/`):
```
agents/architect/
  agent.md              # base instructions (always included)
  health-assessment.md  # operation: health-assessment
  plan-authoring.md     # operation: plan-authoring
```

Reference an operation in the pipeline:
```yaml
generator:
  agent: architect
  operation: plan-authoring
```

### Agent search paths

CCCP searches for agents in order (first match wins):

1. `agents/` relative to the pipeline YAML file
2. `<project>/.claude/agents/`
3. `<project>/agents/`
4. Paths listed in `cccp.yaml` → `agent_paths`

## Project config (`cccp.yaml`)

Place at your project root:

```yaml
agent_paths:
  - ./agents
  - ./vendor/shared-agents

mcp_profiles:
  base:
    servers:
      qmd:
        command: qmd
        args: [serve, --stdio]
  design:
    extends: base
    servers:
      figma:
        command: npx
        args: [-y, figma-console-mcp]

artifact_dir: docs/projects/{project}/{pipeline_name}
default_mcp_profile: base
```

MCP profiles use `extends` for inheritance. Each agent gets only the servers its profile specifies via `--strict-mcp-config`.

## Evaluation format

Evaluator agents must produce files containing this line:

```markdown
### Overall: PASS
```

or

```markdown
### Overall: FAIL
```

CCCP reads only this line. Everything else in the evaluation (criterion tables, iteration guidance) is for the generator agent on retry.

## CLI reference

```
npx @alevental/cccp run -f <pipeline.yaml> -p <project> [options]
  --dry-run              Show what would execute without running agents
  --headless             Auto-approve all human gates
  -d, --project-dir      Project directory (default: cwd)
  -a, --artifact-dir     Override artifact output directory
  -v, --var key=value    Set pipeline variables (repeatable)

npx @alevental/cccp resume -p <project> -r <run-id-prefix> [--headless]
  Resume an interrupted pipeline from the last incomplete stage

npx @alevental/cccp dashboard -r <run-id-prefix>
  Launch the TUI dashboard to monitor a running pipeline

npx @alevental/cccp mcp-server
  Start the MCP server for pipeline interaction and gate approval

npx @alevental/cccp init [--dir <path>]
  Scaffold cccp.yaml, example pipeline, and example agents

npx @alevental/cccp examples [--dir <path>] [--agents-only] [--pipelines-only]
  Scaffold all template agents and example pipelines
```

## Gate interaction

When a pipeline hits a `human_gate` stage, it writes a pending gate to the SQLite state database (`.cccp/cccp.db`) and waits.

**Option 1: MCP server** — Register the MCP server in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "cccp": {
      "command": "npx",
      "args": ["@alevental/cccp", "mcp-server"]
    }
  }
}
```

Then from Claude Code: call `cccp_status` to see what's pending, `cccp_gate_respond` to approve/reject.

**Option 2: Headless** — `cccp run --headless` auto-approves all gates.

## State & resume

Pipeline state is persisted to a SQLite database at `{projectDir}/.cccp/cccp.db` after every transition (stage start, planner dispatch, contract dispatch, generator dispatch, evaluator dispatch, routing decision). If a run is interrupted:

```bash
npx @alevental/cccp resume -p my-project -r <run-id-prefix>
```

Completed stages are skipped. PGE stages resume at the correct iteration and sub-step.

## cmux integration

When running inside a [cmux](https://github.com/manaflow-ai/cmux) workspace (`CMUX_WORKSPACE_ID` is set), CCCP automatically:

- Updates the sidebar status pill with current stage
- Sets the progress bar
- Sends desktop notifications for gates and pipeline completion
- Can open the dashboard in a cmux split pane

Without cmux, CCCP falls back to plain terminal output.

## Development

```bash
npm test           # run all tests (206 tests)
npm run typecheck  # tsc --noEmit
npm run test:watch # watch mode
npm run build      # compile TypeScript to dist/
```

## License

MIT
