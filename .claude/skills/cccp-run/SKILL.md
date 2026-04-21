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
| `--no-tui` | No | Disable the TUI dashboard (keep interactive gates) |
| `-v, --var <key=value>` | No | Set pipeline variable (repeatable) |
| `--session-id <id>` | No | MCP session ID for gate notification routing (see below) |

**IMPORTANT — always use `--session-id`:** Before launching any pipeline (unless the user explicitly says not to), call the `cccp_session_id` MCP tool to get this session's ID, then pass it via `--session-id`. Without it, gate notifications may be sent to every connected Claude Code session instead of just this one.

```bash
# Step 1: Get session ID (call cccp_session_id MCP tool)
# Step 2: Launch with session affinity
npx @alevental/cccp@latest run -f pipeline.yaml -p myproject --session-id <id>
```

**Recommended workflow:**
1. Get session ID: call `cccp_session_id` MCP tool
2. Dry-run first: `npx @alevental/cccp@latest run -f pipeline.yaml -p myproject --dry-run`
3. Full run: `npx @alevental/cccp@latest run -f pipeline.yaml -p myproject --session-id <id>`
4. Headless (CI): `npx @alevental/cccp@latest run -f pipeline.yaml -p myproject --headless`

**Variables:** Override pipeline defaults from CLI:
```bash
npx @alevental/cccp@latest run -f sprint.yaml -p app -v sprint=3 -v env=staging --session-id <id>
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
| `--headless` | No | Auto-approve all gates, disable TUI |
| `--no-tui` | No | Disable the TUI dashboard (keep interactive gates) |
| `--session-id <id>` | No | MCP session ID for gate notification routing (updates the run's session affinity) |
| `--from <stage>` | No | Clean-reset and resume from this named stage. Supports dotted paths for sub-pipeline stages (e.g., `sprint-0.doc-refresh`) |

Without `--from`: skips completed stages and resumes from the first incomplete stage. For PGE stages, resumes at the correct iteration and sub-step. Sub-pipelines resume from the correct child stage automatically (child state is persisted in the parent's state throughout execution).

With `--from <stage>`: resets the named stage and all subsequent stages to a clean state before resuming. Cleans up stage state (status, iteration, artifacts, outputs), SQLite events/checkpoints, artifact directories, stream logs, and gate feedback files. Stages before `--from` are left untouched.

With `--from <parent.child>`: resets from a specific stage inside a sub-pipeline. Walks the children chain, resets child stages from the target onward, sets ancestor stages to `in_progress` so the runner re-enters them.

```bash
# Resume from where it stopped
npx @alevental/cccp@latest resume -p myproject -r a1b2c3d4

# Clean-reset from a specific stage and re-run
npx @alevental/cccp@latest resume -p myproject -r a1b2c3d4 --from review

# Reset from a child stage within a sub-pipeline
npx @alevental/cccp@latest resume -p myproject -r a1b2c3d4 --from sprint-0.doc-refresh
```

### `dashboard` — Monitor a run

```bash
npx @alevental/cccp@latest dashboard -r <run-id-prefix> [-d <project-dir>]
```

Launches a standalone TUI dashboard. Can run in a separate terminal or cmux pane while the pipeline executes.

### `mcp-server` — Start the MCP server

```bash
npx @alevental/cccp@latest mcp-server
```

Exposes tools over stdio: `cccp_session_id`, `cccp_runs`, `cccp_status`, `cccp_gate_respond`, `cccp_gate_review`, `cccp_handoff_ack`, `cccp_pause`, `cccp_logs`, `cccp_artifacts`.

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

## Pausing a Pipeline

To pause a running pipeline at the next clean breakpoint:

**Via TUI:** Press `p` in the dashboard. Shows "Pause requested — will pause after current stage". The pipeline finishes the current stage and stops with `status: "paused"`.

**Via MCP:** Call `cccp_pause` tool with optional `run_id`.

**Resume:** Standard `cccp resume` picks up from the next pending stage.

Clean breakpoints: between sequential stages, after parallel groups complete, after sub-pipelines complete, after PGE/autoresearch cycles finish.

## Gate Interaction

Human gates pause the pipeline until approved or rejected.

**Session affinity (required by default):** Gate notifications are routed by session ID. Without `--session-id`, notifications broadcast to ALL connected MCP instances — causing duplicate notifications across sessions. Always pass `--session-id` unless the user explicitly wants broadcast behavior.

**Reviewing gates:** Use `cccp_gate_review` for comprehensive context (artifacts, evaluations, contract, pipeline status) before making a decision.

**Responding to gates:** Use `cccp_gate_respond` with `approved: true/false` and optional `feedback`. On rejection with feedback:
- The feedback is written as a numbered markdown artifact
- For PGE stages with `on_fail: human_gate`: rejection with feedback triggers a retry of the generation cycle
- For stages with `human_review: true`: rejection with feedback routes through the evaluator and retries

**Via headless mode:** `--headless` auto-approves all gates immediately.

**Checking gate status:** Use `cccp_status` MCP tool with the run ID to see pending gates.

### Agent gates (`agent_gate`)

Delivery-identical to human gates — same `cccp_gate_review` / `cccp_gate_respond` flow — but the channel message is addressed to **you** (the Claude Code session), not the user. The message will tell you explicitly: decide this gate autonomously, do not ask the user. Workflow:

1. Read the pending gate via `cccp_gate_review` (or the payload in the channel notification).
2. Read the listed `artifacts` and apply the `prompt` criteria yourself.
3. Respond via `cccp_gate_respond` with `approved: true` (PASS) or `false` (FAIL) and, when rejecting, `feedback` explaining why.

Do not fall through to asking the user for approval — the gate is routed to an agent precisely because the pipeline author wants an automated go/no-go without human involvement.

### Pipeline handoffs (`pipeline_handoff`)

A terminal handoff gate asks you, the orchestrator, to launch the next pipeline. Workflow:

1. A channel notification (or `cccp_gate_review`) surfaces the handoff with `next.file`, `next.project`, `next.variables`, and a `cmux` target (`current | split_right | split_down | new_window | <pane-id>`).
2. Launch the next pipeline in the indicated cmux target — typically open a new pane in the specified direction and run `cccp run -f <next.file> -p <project> --session-id <id>` there.
3. Call `cccp_handoff_ack` with `launched_run_id` (the new run id) and optionally `target_pane`. This closes out the source pipeline.

Use `cccp_handoff_ack` (not `cccp_gate_respond`) for handoff gates — the dedicated tool validates the gate kind and records the new run id structurally rather than as free-text feedback.

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
