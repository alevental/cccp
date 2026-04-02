# CLI Commands

CCCP provides a set of CLI commands for running pipelines, resuming interrupted runs, monitoring dashboards, serving MCP tools, and scaffolding new projects.

**Source file:** [`src/cli.ts`](../../src/cli.ts)

## `cccp run`

Run a pipeline from a YAML definition.

```
npx @alevental/cccp run -f <path> -p <name> [options]
```

### Required flags

| Flag | Description |
|------|-------------|
| `-f, --file <path>` | Path to the pipeline YAML file |
| `-p, --project <name>` | Project name (used in artifact paths, state tracking) |

### Optional flags

| Flag | Description |
|------|-------------|
| `-d, --project-dir <path>` | Project directory (defaults to `cwd`) |
| `-a, --artifact-dir <path>` | Artifact output directory (overrides `cccp.yaml` and default pattern) |
| `--dry-run` | Show assembled prompts and commands without executing agents |
| `--headless` | Auto-approve all gates (no human interaction); disables TUI |
| `-v, --var <key=value>` | Set pipeline variables (repeatable) |

### Artifact directory resolution

Priority order:

1. `--artifact-dir` CLI flag
2. `artifact_dir` in `cccp.yaml` (supports `{project}` and `{pipeline_name}` variables)
3. Default: `<project-dir>/docs/projects/<project>/<pipeline_name>`

### Agent search paths

Built in this order (first match wins):

1. `<pipeline-yaml-dir>/agents/`
2. `<project-dir>/.claude/agents/`
3. `<project-dir>/agents/`
4. Paths from `agent_paths` in `cccp.yaml`

### Variable resolution

Variables are merged in this order (later overrides earlier):

1. Built-in: `project`, `project_dir`, `artifact_dir`, `pipeline_name`
2. Pipeline-level `variables` from YAML
3. CLI `--var` flags

### TUI behavior

- TUI dashboard is shown by default
- Disabled when `--headless` or `--dry-run` is set
- When TUI is active, console output from agents is suppressed (`quiet: true`)

### Examples

```bash
# Basic run
npx @alevental/cccp run -f pipelines/build-docs.yaml -p my-project

# Dry run to preview prompts
npx @alevental/cccp run -f pipelines/build-docs.yaml -p my-project --dry-run

# Headless (CI) with variables
npx @alevental/cccp run -f pipelines/build-docs.yaml -p my-project \
  --headless \
  -v branch=main \
  -v version=2.0

# Custom artifact directory
npx @alevental/cccp run -f pipelines/build-docs.yaml -p my-project \
  -a /tmp/artifacts/run-001

# Headless mode (auto-approve all gates)
npx @alevental/cccp run -f pipelines/build-docs.yaml -p my-project --headless
```

### Exit codes

- `0` -- pipeline passed
- `1` -- pipeline failed or errored

---

## `cccp resume`

Resume an interrupted pipeline run from its saved state.

```
npx @alevental/cccp resume -p <name> -r <run-id-prefix> [options]
```

### Required flags

| Flag | Description |
|------|-------------|
| `-p, --project <name>` | Project name |
| `-r, --run <id-prefix>` | Run ID or prefix (8+ chars) to resume |

### Optional flags

| Flag | Description |
|------|-------------|
| `-d, --project-dir <path>` | Project directory (defaults to `cwd`) |
| `--headless` | Auto-approve all gates |

### Resume behavior

1. Looks up the run by ID prefix from the SQLite database
2. Finds the resume point (first non-passed, non-skipped stage)
3. Re-loads the original pipeline YAML from the path recorded in state
4. Skips already-completed stages
5. Continues from the interrupted stage

For PGE stages, resume includes the iteration number and sub-step, so a crashed generator or evaluator can be retried without restarting the entire PGE cycle.

### TUI behavior

- TUI dashboard is shown by default (identical to `cccp run`)
- Disabled when `--headless` is set
- When TUI is active, console output from agents is suppressed (`quiet: true`)

### Example

```bash
npx @alevental/cccp resume -p my-project -r a1b2c3d4
```

---

## `cccp dashboard`

Launch the TUI dashboard to monitor a running (or completed) pipeline.

```
npx @alevental/cccp dashboard -r <run-id-prefix> [options]
```

### Required flags

| Flag | Description |
|------|-------------|
| `-r, --run <id-prefix>` | Run ID or prefix (8+ chars) to monitor |

### Optional flags

| Flag | Description |
|------|-------------|
| `-d, --project-dir <path>` | Project directory (defaults to `cwd`) |

### Behavior

The standalone dashboard:
- Reads pipeline state from SQLite
- Tails `.cccp/*.stream.jsonl` files for live agent activity (via `StreamTailer`)
- Polls the database every 300ms for state changes
- Exits automatically when the pipeline completes

### Example

```bash
# In a separate terminal while a pipeline is running
npx @alevental/cccp dashboard -r a1b2c3d4
```

---

## `cccp mcp-server`

Start the CCCP MCP server for Claude Code integration.

```
npx @alevental/cccp mcp-server
```

No flags. The server runs on stdio and is designed to be registered in `.mcp.json`:

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

See [MCP Tools](mcp-tools.md) for the full tool reference.

---

## `cccp init`

Scaffold a minimal `cccp.yaml`, example pipeline, and core agents.

```
npx @alevental/cccp init [options]
```

### Optional flags

| Flag | Description |
|------|-------------|
| `-d, --dir <path>` | Directory to scaffold in (defaults to `cwd`) |

### Generated files

```
<dir>/
  cccp.yaml                          -- project configuration
  pipelines/example.yaml             -- example 3-stage pipeline
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

The generated pipeline includes all three stage types:
- `research` -- `agent` stage
- `review` -- `pge` stage with planner, generator, evaluator, and contract
- `approval` -- `human_gate` stage

### Example

```bash
# Scaffold in current directory
npx @alevental/cccp init

# Scaffold in a specific directory
npx @alevental/cccp init -d ~/projects/new-project

# Run the example (dry run)
npx @alevental/cccp run -f pipelines/example.yaml -p test-project --dry-run
```

---

## `cccp examples`

Scaffold the full set of template agents and example pipelines.

```
npx @alevental/cccp examples [options]
```

### Optional flags

| Flag | Description |
|------|-------------|
| `-d, --dir <path>` | Directory to scaffold in (defaults to `cwd`) |
| `--agents-only` | Only scaffold agent files |
| `--pipelines-only` | Only scaffold pipeline files |

### What it generates

- **44 agent files** across 18 identities (flat agents and directory agents with operations) in `.claude/agents/`
- **11 example pipelines** covering engineering, product, marketing, growth, strategy, design, customer success, and operations in `pipelines/`

Files that already exist are skipped -- running `cccp examples` is safe to repeat without overwriting your customizations.

## Related Documentation

- [Configuration](configuration.md) -- `cccp.yaml` schema
- [Pipeline Authoring](../guides/pipeline-authoring.md) -- YAML pipeline format
- [Project Setup](../guides/project-setup.md) -- getting started guide
