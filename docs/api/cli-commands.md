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
| `--no-tui` | Disable the TUI dashboard (keep interactive gates) |
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
- Disabled when `--headless`, `--dry-run`, or `--no-tui` is set
- When TUI is active, console output from agents is suppressed (`quiet: true`)
- Detail log is keyboard-scrollable: Up/Down, PageUp/PageDown, Home/End
- Press `p` to request a pause — the pipeline finishes the current stage and stops
- Active agents panel shows only in-progress agents with elapsed timers
- Sub-pipeline stages are shown inline with `├─` indentation; in cmux, depth-1 sub-pipelines also get their own split-pane dashboard
- Stage/phase start events include model, effort, inputs, and output metadata
- Dashboard remounts every 15 minutes and renders at 10 FPS to cap memory

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

- `0` -- pipeline passed or paused
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
| `--headless` | Auto-approve all gates; disables TUI |
| `--no-tui` | Disable the TUI dashboard (keep interactive gates) |
| `--session-id <id>` | MCP session ID for gate notification routing (updates the run's session affinity) |
| `--from <stage>` | Clean-reset and resume from this named stage. Supports dotted paths for sub-pipeline stages (e.g., `sprint-0.doc-refresh`) |

### Resume behavior

Works for both interrupted/crashed runs and paused runs (via `p` key or `cccp_pause` MCP tool):

1. Looks up the run by ID prefix from the SQLite database
2. Finds the resume point (first non-passed, non-skipped stage)
3. Re-loads the original pipeline YAML from the path recorded in state
4. Skips already-completed stages
5. Continues from the interrupted/paused stage

For PGE stages, resume includes the iteration number and sub-step, so a crashed generator or evaluator can be retried without restarting the entire PGE cycle.

### Clean reset with `--from`

When `--from <stage>` is specified, the named stage and all subsequent stages are reset to a clean state before resuming. This is useful when you want to re-run part of a pipeline from scratch without re-running earlier stages.

**Dotted paths** target stages inside sub-pipelines: `--from sprint-0.doc-refresh` resets `doc-refresh` and all subsequent stages within the `sprint-0` sub-pipeline, sets `sprint-0` back to `in_progress`, and resumes from there. Arbitrary nesting depth is supported.

What gets cleaned:
- **Stage state**: status reset to `pending`, iteration/pgeStep/artifacts/outputs/duration/error cleared
- **Pipeline state**: status set to `running`, `completedAt` and `gate` cleared
- **Ancestor stages** (dotted paths only): set to `in_progress` so the runner re-enters them
- **SQLite**: events and checkpoints deleted for the reset stages
- **Artifact directories**: `{artifactDir}/{stageName}/` removed (task plans, contracts, evaluations)
- **Stream logs**: `{artifactDir}/.cccp/{stageName}-*.stream.jsonl` deleted
- **Gate feedback**: `{artifactDir}/.cccp/{stageName}-gate-feedback-*.md` deleted

Stages before the `--from` stage are left untouched (still passed/skipped).

```bash
# Re-run from the "review" stage onward
npx @alevental/cccp resume -p my-project -r a1b2c3d4 --from review

# Re-run from a child stage within a sub-pipeline
npx @alevental/cccp resume -p my-project -r a1b2c3d4 --from sprint-0.doc-refresh
```

### TUI behavior

- TUI dashboard is shown by default (identical to `cccp run` — see TUI behavior above)
- Disabled when `--headless` or `--no-tui` is set

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
| `--scope <stage>` | Scope to a sub-pipeline stage's children (stage must be `type: pipeline`) |

### Behavior

The standalone dashboard:
- Reads pipeline state from SQLite (reloads from disk on each poll for cross-process visibility)
- Tails `.cccp/*.stream.jsonl` files for live agent activity (via `StreamTailer`)
- Polls the database every 500ms for state changes (5s when gate-idle)
- Exits automatically when the pipeline completes
- Reclaims sql.js WASM memory every ~15 minutes to prevent unbounded heap growth

When `--scope` is used, the dashboard loads the parent run's state but displays only the child pipeline's stages, activity, and events. The `child_*` event prefixes are stripped so the scoped dashboard looks like a standalone pipeline view.

### Automatic cmux integration

When a `type: pipeline` stage starts inside a cmux workspace, the runner automatically opens a split pane below and launches `cccp dashboard --scope <stage>`. The pane auto-closes when the sub-pipeline completes. This only applies to depth-1 sub-pipelines (immediate children of the top-level pipeline) to avoid pane explosion on deep nesting. Skipped when `--headless` is set.

### Examples

```bash
# In a separate terminal while a pipeline is running
npx @alevental/cccp dashboard -r a1b2c3d4

# Monitor only a sub-pipeline stage
npx @alevental/cccp dashboard -r a1b2c3d4 --scope build-pipeline
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
