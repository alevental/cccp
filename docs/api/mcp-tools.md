# MCP Tools

The CCCP MCP server exposes eight tools for interacting with pipeline runs from Claude Code. The server runs on stdio and is started via `cccp mcp-server`. It also includes a background gate notifier that proactively pushes gate notifications via channels (preferred) or elicitation forms (fallback).

**Source files:**
- [`src/mcp/mcp-server.ts`](../../src/mcp/mcp-server.ts) -- MCP server and tool definitions
- [`src/mcp/gate-notifier.ts`](../../src/mcp/gate-notifier.ts) -- three-tier gate notification (channel, elicitation, manual)
- [`src/gate/feedback-artifact.ts`](../../src/gate/feedback-artifact.ts) -- numbered feedback markdown writer

## Server Registration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "cccp": {
      "command": "npx",
      "args": ["tsx", "src/cli.ts", "mcp-server"]
    }
  }
}
```

The server uses `process.cwd()` as the project directory when resolving the SQLite database at `.cccp/cccp.db`.

## Run Resolution

All tools that accept a `run_id` parameter use prefix matching with the following logic:

- If `run_id` is omitted and only one run exists, it is selected automatically
- If `run_id` is omitted and multiple runs exist, the tool returns a listing of all runs
- Prefix matching (8+ characters recommended) selects the matching run
- Ambiguous prefixes return an error with guidance

The MCP server uses a `DbService` in `"reader"` mode which reloads the database from disk before each read and periodically reclaims sql.js WASM memory. The `GateNotifier` shares this service instance.

---

## `cccp_session_id`

Get this MCP server instance's session ID. The server generates a UUID on startup. Pass this value as `--session-id` when running pipelines so gate notifications route only to this session.

### Parameters

None.

### Response

```
a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

### Usage

```bash
# Get the session ID, then start a pipeline affiliated with this session
cccp run -f pipeline.yaml -p my-project --session-id <session-id>
```

When a pipeline is started with `--session-id`, the `GateNotifier` in other MCP sessions will skip its gates (session affinity). **Always pass `--session-id` when launching pipelines.** Without it, gate notifications broadcast to every connected MCP instance, causing duplicate notifications across sessions.

---

## `cccp_runs`

List all pipeline runs (active and completed).

### Parameters

None.

### Response

```
Runs:
  a1b2c3d4  build-docs (my-project)  running  2025-01-15T14:30:00.000Z
  e5f6g7h8  build-docs (my-project)  passed   2025-01-14T10:00:00.000Z
```

Runs with pending gates include a gate indicator:

```
  a1b2c3d4  build-docs (my-project)  running | GATE: approval  2025-01-15T14:30:00.000Z
```

Runs are sorted with running runs first, then by `started_at` descending.

---

## `cccp_status`

Get detailed status for a pipeline run -- stages, iterations, artifacts, and pending gates.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `run_id` | `string` | No | Run ID prefix (8+ chars). Omit if only one run exists. |

### Response

```
Pipeline: build-docs (run a1b2c3d4)
Project: my-project
Status: running
Started: 2025-01-15T14:30:00.000Z

Stages:
  ✓ research: passed 12.3s [output]
  ⚙ review: in_progress (iter 2) [contract, deliverable, evaluation-1]
  ○ approval: pending

Gate: approval -- pending
  Prompt: Please review the document and approve.
```

Stage status icons:
- `✓` passed
- `✗` failed/error
- `⚙` in_progress
- `⏭` skipped
- `○` pending

---

## `cccp_gate_respond`

Approve or reject a pending human gate. On rejection with feedback, the feedback is written as a numbered markdown artifact and passed to the generator/agent for retry.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `run_id` | `string` | No | Run ID prefix (8+ chars). Omit if only one run exists. |
| `approved` | `boolean` | **Yes** | Whether to approve (`true`) or reject (`false`) the gate. |
| `feedback` | `string` | No | Optional inline feedback (markdown). Written as an artifact and passed to the generator on retry. |
| `feedback_file` | `string` | No | Path to a markdown file with detailed feedback. Takes precedence over inline `feedback`. |

### Behavior

1. Resolves the run
2. Checks that a gate exists with `status === "pending"`
3. Resolves feedback content: reads `feedback_file` if provided (takes precedence), otherwise uses inline `feedback`
4. Updates `state.gate.status` to `"approved"` or `"rejected"`
5. If feedback is present, calls `writeFeedbackArtifact()` to write `{stageName}-gate-feedback-{N}.md` into `.cccp/`, sets `state.gate.feedbackPath`, and records it as a stage artifact under key `gate-feedback`
6. Saves state to the database (the runner's `FilesystemGateStrategy` will pick it up on its next poll)

### Response

```
Gate "approval" approved.
```

With feedback artifact:

```
Gate "approval" rejected. Feedback artifact: /path/to/.cccp/approval-gate-feedback-1.md
```

### Error cases

```
No pending gate on this run.
```

```
Could not read feedback file: ENOENT: no such file or directory
```

---

## `cccp_gate_review`

Get comprehensive gate review context before responding to a gate. Returns the pending gate info, stage artifacts, key artifact contents (contract, deliverable, task-plan), latest evaluation, iteration history, and overall pipeline status.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `run_id` | `string` | No | Run ID prefix (8+ chars). Omit if only one run exists. |

### Behavior

1. Resolves the run
2. Checks that a gate exists with `status === "pending"`
3. Assembles a markdown report with:
   - Gate metadata (run, stage, prompt)
   - Stage artifact listing
   - Inline content for key artifacts (`contract`, `deliverable`, `task-plan`) -- truncated to 2000 chars with a note to use `cccp_artifacts` for full content
   - Latest evaluation content (the most recent `evaluation-*` artifact)
   - Iteration history (current iteration, last PGE step)
   - Pipeline-wide stage status overview

### Response

```
# Gate Review: review

**Run**: a1b2c3d4 (build-docs)
**Stage**: review (type: pge)
**Prompt**: PGE stage "review" passed evaluation. Review the deliverable.

## Artifacts

- **contract**: /path/to/review/contract.md
- **deliverable**: /path/to/document.md
- **evaluation-1**: /path/to/review/evaluation-1.md

## contract
...

## Latest Evaluation (evaluation-1)
...

## Pipeline Status
  ✓ research: passed
  ⚙ review: in_progress
  ○ approval: pending
```

### Error cases

```
No pending gate on this run.
```

---

## `cccp_handoff_ack`

Acknowledge a pending `pipeline_handoff` gate after launching the next pipeline. Use this instead of `cccp_gate_respond` for handoff gates — it validates the gate kind and records the new run id / target pane structurally on the handoff payload (rather than as free-text feedback).

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `run_id` | `string` | No | Run ID prefix (8+ chars) of the pipeline with the pending handoff. Omit if only one run exists. |
| `launched_run_id` | `string` | No | Run id of the pipeline you just launched (if known). |
| `target_pane` | `string` | No | cmux pane/surface where the new pipeline is running. |
| `note` | `string` | No | Optional note — recorded as a gate feedback artifact. |

### Behavior

1. Resolves the run and validates that `state.gate` exists with `status === "pending"`
2. Validates that `state.gate.kind === "pipeline_handoff"` — returns an error otherwise pointing callers to `cccp_gate_respond`
3. Writes `launched_run_id` and `target_pane` onto `state.gate.handoff`, transitions the gate to `"approved"`, and sets `respondedAt`
4. Records `handoff-launched-run` and `handoff-target-pane` as stage artifacts
5. If `note` was provided, writes it as a numbered feedback artifact

### Typical workflow

1. Discover the handoff via a channel notification (or `cccp_gate_review`)
2. Launch the next pipeline in the indicated cmux target (e.g., `cccp run -f <next.file> -p <project>` in the target pane/workspace)
3. Call `cccp_handoff_ack` with the new run id

### Response

```
Handoff "handoff-to-next" acknowledged.
  launched_run_id: 7c9f1b2a
  target_pane: surface:42
```

---

## `cccp_pause`

Request a running pipeline to pause at the next clean breakpoint (between stages). The pipeline finishes its current stage and stops with `status: "paused"`. Resume later with `cccp resume`.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `run_id` | `string` | No | Run ID prefix (8+ chars). Omit if only one run exists. |

### Behavior

1. Resolves the run
2. Validates the pipeline is currently `"running"`
3. Sets the `pause_requested` flag in the database (a dedicated column, separate from the state JSON to avoid write races with the runner)
4. The runner checks this flag before each execution step and pauses at the next clean breakpoint

### Clean breakpoints

- **Between sequential stages**: pause checked before each stage
- **After parallel groups**: all stages in the group complete, then pause is checked
- **After sub-pipelines**: the entire sub-pipeline completes before pause is checked
- **After PGE/autoresearch cycles**: the full cycle finishes (not mid-iteration)

### Response

```
Pause requested for run a1b2c3d4. The pipeline will pause after the current stage completes.
```

### Error cases

```
Cannot pause: pipeline is "passed", not running.
```

### Resume

```bash
cccp resume -p my-project -r a1b2c3d4
```

Standard resume picks up from the first pending stage after the pause point.

---

## `cccp_logs`

View recent agent activity logs for a pipeline run.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `run_id` | `string` | No | -- | Run ID prefix (8+ chars). |
| `lines` | `number` | No | `50` | Number of recent log lines to return. |

### Behavior

Reads `.stream.jsonl` files from the `.cccp/` directory under the run's artifact dir. Returns the most recent `lines` from the latest log file (sorted alphabetically, reversed to get the most recent).

### Response

```
Log: review-generator.stream.jsonl (342 total lines)

{"type":"system","subtype":"init","model":"claude-sonnet-4-20250514"}
{"type":"assistant","message":{"content":[...]}}
...
```

---

## `cccp_artifacts`

List or read artifacts produced by a pipeline run.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `run_id` | `string` | No | Run ID prefix (8+ chars). |
| `read` | `string` | No | Artifact key, file path, or path suffix to read. Omit to list all artifacts. |

### List mode (no `read` parameter)

Collects all artifacts across all stages from `state.stages[name].artifacts`:

```
Artifacts for run a1b2c3d4:

  [research] output: /path/to/docs/projects/my-project/build-docs/research.md
  [review] contract: /path/to/docs/projects/my-project/build-docs/review/contract.md
  [review] deliverable: /path/to/docs/projects/my-project/build-docs/document.md
  [review] evaluation-1: /path/to/docs/projects/my-project/build-docs/review/evaluation-1.md
```

### Read mode (with `read` parameter)

Matches the `read` value against:

1. Artifact key (e.g., `"contract"`)
2. Full file path
3. Path suffix (e.g., `"contract.md"`)

If no artifact matches, tries reading `read` as a path relative to the artifact directory.

### Response (read mode)

```
contract (review):

## Contract: review

### Deliverable
docs/projects/my-project/build-docs/document.md
...
```

## Gate Notification (Automatic)

In addition to the manual `cccp_gate_respond` and `cccp_gate_review` tools, the MCP server includes a `GateNotifier` that automatically detects pending gates and notifies the user. It uses a three-tier strategy:

### Tier 1: Channel notification (push)

The MCP server declares `experimental: { "claude/channel": {} }` in its capabilities. When a gate is detected, the notifier sends a `notifications/claude/channel` message with severity `high`. This is a non-blocking push that surfaces in the Claude Code conversation without requiring a form interaction.

**Requirement:** Claude Code must be launched with `--dangerously-load-development-channels server:cccp` for channel notifications to work.

### Tier 2: Elicitation form (interactive)

If channels are unsupported, the notifier falls back to `elicitInput()` with a structured approve/reject form. Feedback provided on rejection is written as a numbered artifact.

### Tier 3: Manual tools

If both channels and elicitation are unavailable, the user discovers gates via `cccp_status`, reviews via `cccp_gate_review`, and responds via `cccp_gate_respond`.

### Session affinity

The MCP server generates a UUID session ID on startup (exposed via `cccp_session_id`). Pipeline runs started with `--session-id` are only notified by the matching MCP session. **Runs without a session ID are notified by all sessions**, causing duplicate notifications. Always pass `--session-id`.

### Feedback artifacts

Both the elicitation and channel response paths write feedback as numbered markdown artifacts via `writeFeedbackArtifact()` and record them as stage artifacts. The feedback path is what enables the runner to retry with structured feedback.

See [Gate System](../architecture/gate-system.md) for the full gate architecture.

## Typical MCP Workflow

When the MCP server is registered, the typical flow is:

1. **Get session ID:** `cccp_session_id` -- **always** pass this as `--session-id` when starting pipelines to prevent duplicate gate notifications
2. **Automatic:** The gate notifier detects pending gates and pushes via channel notification (or elicitation form) -- no manual action needed
3. **Pause:** `cccp_pause` to pause a running pipeline at the next clean breakpoint
4. **Manual fallback:** If automatic notification is unavailable:
   1. **Check status:** `cccp_runs` to see active runs
   2. **Get details:** `cccp_status` with the run ID to see stage progress and pending gates
   3. **Review gate context:** `cccp_gate_review` to see artifacts, evaluations, contract, and pipeline status
   4. **Read specific artifacts:** `cccp_artifacts` to read full content of any artifact
   5. **Respond to gate:** `cccp_gate_respond` with approval/rejection, inline feedback or `feedback_file`

## Related Documentation

- [Gate System](../architecture/gate-system.md) -- how gate responses flow back to the runner
- [CLI Commands](cli-commands.md) -- `cccp mcp-server` command
- [Configuration](configuration.md) -- `.mcp.json` setup
