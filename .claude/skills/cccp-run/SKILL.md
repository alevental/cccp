---
name: cccp-run
description: Run, resume, and monitor CCCP pipelines. Use when the user asks to execute a pipeline, check run status, manage gates, or work with cmux panes.
allowed-tools: Bash(npx:*), mcp__cccp__*
---

# Running CCCP Pipelines

All commands use `npx @alevental/cccp@latest` — no global install required.

## CLI Commands

### `run` — Execute a pipeline

```bash
npx @alevental/cccp@latest run -f <pipeline.yaml> -p <project> [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `-f, --file <path>` | Yes | Pipeline YAML file |
| `-p, --project <name>` | Yes | Project name (used in artifact paths and state) |
| `-d, --project-dir <path>` | No | Project directory (default: cwd) |
| `-a, --artifact-dir <path>` | No | Override artifact output directory |
| `--dry-run` | No | Show prompts without executing agents |
| `--headless` | No | Auto-approve all gates, disable TUI |
| `-v, --var <key=value>` | No | Set pipeline variable (repeatable) |
| `--session-id <id>` | No | MCP session ID for gate notification routing (see below) |

**Recommended workflow:**
1. Dry-run first: `npx @alevental/cccp@latest run -f pipeline.yaml -p myproject --dry-run`
2. Full run: `npx @alevental/cccp@latest run -f pipeline.yaml -p myproject`
3. Headless (CI): `npx @alevental/cccp@latest run -f pipeline.yaml -p myproject --headless`

**Variables:** Override pipeline defaults from CLI:
```bash
npx @alevental/cccp@latest run -f sprint.yaml -p app -v sprint=3 -v env=staging
```

### `resume` — Resume an interrupted run

```bash
npx @alevental/cccp@latest resume -p <project> -r <run-id-prefix> [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `-p, --project <name>` | Yes | Project name |
| `-r, --run <id-prefix>` | Yes | Run ID or prefix (8+ characters) |
| `-d, --project-dir <path>` | No | Project directory (default: cwd) |
| `--headless` | No | Auto-approve all gates |

Skips completed stages and resumes from the first incomplete stage. For PGE stages, resumes at the correct iteration and sub-step.

### `dashboard` — Monitor a run

```bash
npx @alevental/cccp@latest dashboard -r <run-id-prefix> [-d <project-dir>]
```

Launches a standalone TUI dashboard. Can run in a separate terminal or cmux pane while the pipeline executes.

### `mcp-server` — Start the MCP server

```bash
npx @alevental/cccp@latest mcp-server
```

Exposes tools over stdio: `cccp_session_id`, `cccp_runs`, `cccp_status`, `cccp_gate_respond`, `cccp_gate_review`, `cccp_logs`, `cccp_artifacts`.

Register in `.mcp.json`:
```json
{
  "mcpServers": {
    "cccp": {
      "command": "npx",
      "args": ["@alevental/cccp@latest", "mcp-server"]
    }
  }
}
```

**Channel notifications (research preview):** To enable push notifications for pending gates, start Claude Code with the channel flag:
```bash
claude --dangerously-load-development-channels server:cccp
```
This allows the MCP server to push `<channel>` events directly into your session when a gate becomes pending, instead of relying on elicitation popups. Without this flag, notifications fall back to elicitation → manual tool calls.

### `init` — Scaffold a new project

```bash
npx @alevental/cccp@latest init [-d <dir>]
```

### `update-skills` — Update skills to latest version

```bash
npx @alevental/cccp@latest update-skills [-d <dir>]
```

Updates `/cccp-run` and `/cccp-pipeline` skills to the version shipped with the installed package. Does not touch agents, pipelines, `cccp.yaml`, or any other files.

### `examples` — Scaffold all agents and example pipelines

```bash
npx @alevental/cccp@latest examples [-d <dir>] [--agents-only] [--pipelines-only]
```

## Gate Interaction

Human gates pause the pipeline until approved or rejected.

**Session-routed notifications:** To ensure gate notifications arrive in YOUR Claude Code session (not a random one), pass `--session-id` when starting the pipeline. Get the session ID from the `cccp_session_id` MCP tool first:

```bash
# Get session ID, then pass it to the run command:
npx @alevental/cccp@latest run -f pipeline.yaml -p myproject --session-id <id>
```

When launching pipelines from Claude Code, always call `cccp_session_id` first, then include `--session-id` in the command.

**Reviewing gates:** Use `cccp_gate_review` for comprehensive context (artifacts, evaluations, contract, pipeline status) before making a decision.

**Responding to gates:** Use `cccp_gate_respond` with `approved: true/false` and optional `feedback`. On rejection with feedback:
- The feedback is written as a numbered markdown artifact
- For PGE stages with `on_fail: human_gate`: rejection with feedback triggers a retry of the generation cycle
- For stages with `human_review: true`: rejection with feedback routes through the evaluator and retries

**Via headless mode:** `--headless` auto-approves all gates immediately.

**Checking gate status:** Use `cccp_status` MCP tool with the run ID to see pending gates.

## cmux Integration

When running inside a cmux workspace (`CMUX_WORKSPACE_ID` is set), CCCP automatically:
- Updates the sidebar status pill with the current stage
- Shows a progress bar based on stage completion
- Sends desktop notifications for gate requests and pipeline completion

**Manual pane management:**
```bash
# Create a split pane for monitoring
cmux new-split right          # Returns surface:N

# Send a dashboard command to the new pane
cmux send --surface surface:1 "npx @alevental/cccp@latest dashboard -r abc12345"
cmux send-key --surface surface:1 Enter

# Check status from sidebar
cmux set-status cccp "Stage 3/5"
cmux set-progress 0.6
```

All cmux commands are no-ops when not in a cmux workspace.
