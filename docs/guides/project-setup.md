# Project Setup

This guide walks through setting up CCCP in a new or existing project, from scaffolding to running your first pipeline.

**Source files:**
- [`src/cli.ts`](../../src/cli.ts) -- `cccp init` command
- [`src/config.ts`](../../src/config.ts) -- `cccp.yaml` loader

## Prerequisites

- Node.js 18+
- Claude Code CLI (`claude`) installed and authenticated
- CCCP: `npm install @alevental/cccp` or use `npx @alevental/cccp`

## Step 1: Scaffold with `cccp init`

Run from your project root:

```bash
npx @alevental/cccp init
```

This creates a minimal scaffold:

```
your-project/
  cccp.yaml                          -- project configuration
  pipelines/
    example.yaml                     -- example 3-stage pipeline (agent + pge + gate)
  .claude/agents/
    researcher.md                    -- research agent
    writer.md                        -- writer/generator agent
    reviewer.md                      -- evaluator agent
    architect/
      agent.md                       -- base architect identity
  .claude/skills/
    research.md                      -- research skill
    evaluate.md                      -- evaluation skill
```

Alternatively, scaffold into a specific directory:

```bash
npx @alevental/cccp init -d ~/projects/my-project
```

## Step 1b: Get All Agents and Pipelines (Optional)

To scaffold the full set of template agents and example pipelines:

```bash
npx @alevental/cccp examples
```

This generates 44 agent files (18 identities) and 11 example pipelines covering engineering, product, marketing, growth, strategy, design, customer success, and operations. Use `--agents-only` or `--pipelines-only` to scaffold selectively. Files that already exist are skipped.

## Step 2: Configure `cccp.yaml`

The generated `cccp.yaml` provides sensible defaults. Customize as needed:

```yaml
# Directories to search for agent definitions (in priority order).
agent_paths:
  - ./agents
  - ./.claude/agents

# Default artifact output directory pattern.
artifact_dir: docs/projects/{project}/{pipeline_name}

# Claude config directory for agent subprocesses.
# Uncomment and set if agents need a different profile than your interactive session.
# claude_config_dir: /Users/me/.claude-profile

# Permission mode for agent subprocesses.
# Pipeline agents run non-interactively, so they need pre-granted permissions.
permission_mode: bypassPermissions
```

### Key decisions

**Agent paths:** Where will your agent markdown files live? The default `./agents` works for most projects. Add `.claude/agents` if you want to co-locate with other Claude Code configuration.

**Artifact directory:** Where should pipeline outputs go? The default pattern `docs/projects/{project}/{pipeline_name}` creates a structured output directory. Use `--artifact-dir` at runtime to override.

**Permission mode:** `bypassPermissions` is recommended for pipeline agents since they run non-interactively and cannot prompt for approval. If you need tighter control, use `acceptEdits`.

**Claude config directory:** Set this if your pipeline agents should use a different authentication profile or settings than your interactive Claude Code session.

See [Configuration](../api/configuration.md) for the full schema reference.

## Step 3: Set Up MCP Profiles (Optional)

If your agents need access to MCP servers (e.g., QMD for documentation search, Figma for design work), define profiles in `cccp.yaml`:

```yaml
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

# Apply 'base' to all stages by default.
default_mcp_profile: base
```

Then reference profiles in your pipeline stages:

```yaml
stages:
  - name: research
    type: agent
    agent: researcher
    mcp_profile: base          # Gets QMD access

  - name: design
    type: agent
    agent: designer
    mcp_profile: design        # Gets QMD + Figma access
```

## Step 4: Register the MCP Server (Optional)

To interact with running pipelines from Claude Code (approve gates, check status), register the CCCP MCP server in your project's `.mcp.json`:

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

This enables Claude Code to use the `cccp_runs`, `cccp_status`, `cccp_gate_respond`, `cccp_logs`, and `cccp_artifacts` tools. The MCP server also includes a gate notifier that automatically prompts for approval when a pipeline reaches a human gate (requires Claude Code v2.1.76+). See [MCP Tools](../api/mcp-tools.md) for details.

## Step 5: Write Your Agents

Create agent markdown files in your agents directory. Start with the examples from `cccp init` and customize.

### Minimal agent

```markdown
---
name: researcher
description: Researches a topic and writes a summary.
---

# Researcher

You are a research agent for the {project_name} project.

## Instructions

1. Read the project's key files
2. Write a clear summary to the output path
```

### Directory agent with operations

```
agents/
  architect/
    agent.md                 # Base identity and capabilities
    design.md                # Specialization for technical design
    task-planning.md         # Specialization for implementation task breakdown
```

See [Agent Authoring](agent-authoring.md) for the full guide.

## Step 6: Write Your Pipeline

Create a pipeline YAML file in `pipelines/` (or any directory):

```yaml
name: build-docs
description: Build documentation for a feature.

variables:
  feature: authentication

stages:
  - name: research
    type: agent
    task: "Research the {feature} feature."
    agent: researcher
    output: "{artifact_dir}/research.md"

  - name: write
    type: pge
    task: "Write {feature} documentation."
    inputs:
      - "{artifact_dir}/research.md"
    planner:
      agent: architect
      operation: task-planning
    generator:
      agent: writer
    evaluator:
      agent: reviewer
    contract:
      deliverable: "{artifact_dir}/docs.md"
      guidance: "All APIs and config options must be documented accurately."
      max_iterations: 3
    on_fail: human_gate

  - name: approve
    type: human_gate
    prompt: "Review the {feature} documentation."
    artifacts:
      - "{artifact_dir}/docs.md"
```

See [Pipeline Authoring](pipeline-authoring.md) for the full format reference.

## Step 7: Test with Dry Run

Verify your pipeline resolves correctly without executing any agents:

```bash
npx @alevental/cccp run -f pipelines/build-docs.yaml -p my-project --dry-run
```

This shows:
- Resolved agent paths (planner, generator, evaluator)
- Assembled user prompts
- Contract configuration (deliverable, guidance, template)
- Variable interpolation results

Fix any agent resolution or variable errors before running live.

## Step 8: Run the Pipeline

```bash
# Interactive mode (TUI dashboard, manual gate approval)
npx @alevental/cccp run -f pipelines/build-docs.yaml -p my-project

# Headless mode (auto-approve gates, no TUI)
npx @alevental/cccp run -f pipelines/build-docs.yaml -p my-project --headless

# With variable overrides
npx @alevental/cccp run -f pipelines/build-docs.yaml -p my-project -v feature=payments
```

### What happens

1. Pipeline YAML is loaded and validated
2. State is created in the SQLite database at `.cccp/cccp.db`
3. The TUI dashboard starts (unless `--headless`)
4. Stages execute sequentially (or concurrently within parallel groups), persisting state after each transition
5. Stream logs are written to `<artifact-dir>/.cccp/<agent>.stream.jsonl`
6. Pipeline completes with exit code 0 (passed) or 1 (failed/error)

### Artifacts

After a successful run, artifacts are in the artifact directory:

```
docs/projects/my-project/build-docs/
  .cccp/
    cccp.db                      # SQLite state database (in project root)
    researcher.stream.jsonl      # Stream log
    write-planner.stream.jsonl
    write-contract.stream.jsonl
    write-generator.stream.jsonl
    write-evaluator.stream.jsonl
  research.md                    # Research output
  write/
    task-plan.md                 # Written by planner
    contract.md                  # Written by evaluator (contract mode)
    evaluation-1.md              # First evaluation
    evaluation-2.md              # Second evaluation (if retried)
  docs.md                        # Final deliverable
```

## Monitoring

### Inline dashboard

The TUI dashboard runs automatically with `cccp run`. It shows stage progress, live agent activity, and event log.

### Standalone dashboard

Monitor from a separate terminal:

```bash
npx @alevental/cccp dashboard -a docs/projects/my-project/build-docs
```

### MCP tools

When the CCCP MCP server is registered, pending gates are automatically detected and presented as approval forms via MCP elicitation -- no manual polling required. If elicitation is unavailable, use `cccp_status` to check progress and `cccp_gate_respond` to approve gates manually.

## Resuming Interrupted Runs

If a pipeline is interrupted (crash, Ctrl-C, network error), resume from the last checkpoint:

```bash
npx @alevental/cccp resume -p my-project -r <run-id-prefix>
```

The runner skips completed stages and resumes from the first incomplete stage. For PGE stages, it resumes at the iteration and sub-step level.

### Clean reset from a specific stage

To re-run part of a pipeline from scratch without re-running earlier stages, use `--from`:

```bash
npx @alevental/cccp resume -p my-project -r <run-id-prefix> --from review
```

This resets the named stage and all subsequent stages to a clean state (clears state, artifacts, logs, events), then resumes from that point. Stages before `--from` are left untouched.

## Project Structure Summary

```
your-project/
  cccp.yaml                      # Project configuration
  .mcp.json                      # MCP server registration (optional)
  .cccp/
    cccp.db                      # SQLite database (created at runtime)
  agents/
    researcher.md                # Agent definitions
    writer.md
    reviewer.md                  # Evaluator (contract writing + evaluation)
    architect/                   # Directory-style agent
      agent.md
      design.md
      task-planning.md
  pipelines/
    build-docs.yaml              # Pipeline definitions
    deploy.yaml
  docs/projects/                 # Artifact output (default location)
    my-project/
      build-docs/
        .cccp/                   # Run state and stream logs
        research.md              # Generated artifacts
        docs.md
```

## Related Documentation

- [CLI Commands](../api/cli-commands.md) -- all CLI commands and flags
- [Configuration](../api/configuration.md) -- `cccp.yaml` schema
- [Pipeline Authoring](pipeline-authoring.md) -- YAML pipeline format
- [Agent Authoring](agent-authoring.md) -- writing agent definitions
