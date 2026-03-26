# CCCPR

**Claude Code and Cmux Pipeline Reagent** — deterministic YAML-based pipeline orchestration for workflows built around [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [cmux](https://github.com/manaflow-ai/cmux).

## The problem

Complex multi-stage workflows (SDLC pipelines, research pipelines, content pipelines) rely on Claude as a "file-routing state machine" — dispatching agents, reading evaluations, routing on PASS/FAIL. Over long runs, context degrades: Claude forgets iteration counts, skips sub-stages, misreads evaluations, or loses routing logic.

## The solution

CCCPR moves the state machine into deterministic TypeScript code. It reads YAML pipeline definitions, dispatches agents via `claude -p` (each with fresh context), parses evaluations with regex, and routes without interpretation. A cmux split-pane dashboard shows live progress. Human approval gates are handled via an MCP server.

- Uses Max subscription — no API keys needed
- Each agent gets a fresh context window
- Evaluation routing is regex, not interpretation
- State persists to disk — resume after crashes
- Works with any project, any agents, any workflow

## Install

```bash
git clone <repo-url> && cd cccpr
npm install
npm link  # makes `cccpr` available globally
```

## Quick start

Scaffold a project:

```bash
cd my-project
cccpr init
```

This creates:

```
cccpr.yaml             # project config (agent paths, MCP profiles)
pipelines/example.yaml # example pipeline
agents/                # example agent definitions
```

Preview what the pipeline will do:

```bash
cccpr run -f pipelines/example.yaml -p my-project --dry-run
```

Run it for real:

```bash
cccpr run -f pipelines/example.yaml -p my-project
```

## Pipeline YAML

Pipelines are sequences of typed stages:

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
    generator:
      agent: architect
      operation: design        # optional sub-operation
      mcp_profile: base        # optional MCP server profile
    evaluator:
      agent: reviewer
    contract:
      deliverable: "{artifact_dir}/design.md"
      criteria:
        - name: modularity
          description: "System is decomposed into independent modules."
        - name: data-flow
          description: "Data flow between components is documented."
      max_iterations: 3
    on_fail: stop              # stop | skip | human_gate

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
| `pge` | Write contract → dispatch generator → dispatch evaluator → parse `### Overall: PASS/FAIL` → retry on FAIL up to `max_iterations` |
| `human_gate` | Block until approved via MCP tool call or state file edit |

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

CCCPR ships no agents — you bring your own. Agents are markdown files that become the `--system-prompt-file` for `claude -p`.

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

CCCPR searches for agents in order (first match wins):

1. `agents/` relative to the pipeline YAML file
2. `<project>/.claude/agents/`
3. `<project>/agents/`
4. Paths listed in `cccpr.yaml` → `agent_paths`

## Project config (`cccpr.yaml`)

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

CCCPR reads only this line. Everything else in the evaluation (criterion tables, iteration guidance) is for the generator agent on retry.

## CLI reference

```
cccpr run -f <pipeline.yaml> -p <project> [options]
  --dry-run              Show what would execute without running agents
  --headless             Auto-approve all human gates
  --webhook-url <url>    POST pipeline events to a webhook
  -d, --project-dir      Project directory (default: cwd)
  -a, --artifact-dir     Override artifact output directory
  -v, --var key=value    Set pipeline variables (repeatable)

cccpr resume -p <project> -a <artifact-dir> [--headless]
  Resume an interrupted pipeline from the last incomplete stage

cccpr dashboard -a <artifact-dir>
  Launch the TUI dashboard to monitor a running pipeline

cccpr gate-server
  Start the MCP server for pipeline gate interaction

cccpr init [--dir <path>]
  Scaffold cccpr.yaml, example pipeline, and example agents
```

## Gate interaction

When a pipeline hits a `human_gate` stage, it writes `gate_pending` to `.cccpr/state.json` and waits.

**Option 1: MCP server** — Register the gate server in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "cccpr-gate": {
      "command": "npx",
      "args": ["tsx", "/path/to/cccpr/src/cli.ts", "gate-server"]
    }
  }
}
```

Then from Claude Code: call `pipeline_status` to see what's pending, `pipeline_gate_respond` to approve/reject.

**Option 2: Headless** — `cccpr run --headless` auto-approves all gates.

## State & resume

Pipeline state is persisted to `{artifact_dir}/.cccpr/state.json` after every transition (stage start, contract write, generator dispatch, evaluator dispatch, routing decision). If a run is interrupted:

```bash
cccpr resume -p my-project -a docs/projects/my-project/planning
```

Completed stages are skipped. PGE stages resume at the correct iteration and sub-step.

## cmux integration

When running inside a [cmux](https://github.com/manaflow-ai/cmux) workspace (`CMUX_WORKSPACE_ID` is set), CCCPR automatically:

- Updates the sidebar status pill with current stage
- Sets the progress bar
- Sends desktop notifications for gates and pipeline completion
- Can open the dashboard in a cmux split pane

Without cmux, CCCPR falls back to plain terminal output.

## Development

```bash
npm test           # run all tests (107 tests)
npm run test:watch # watch mode
npm run build      # compile TypeScript to dist/
```

## License

MIT
