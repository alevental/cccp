# MCP Tools

The CCCP MCP server exposes five tools for interacting with pipeline runs from Claude Code. The server runs on stdio and is started via `cccp mcp-server`. It also includes a background gate notifier that proactively elicits approval from the user when a human gate becomes pending.

**Source files:**
- [`src/mcp/mcp-server.ts`](../../src/mcp/mcp-server.ts) -- MCP server and tool definitions
- [`src/mcp/gate-notifier.ts`](../../src/mcp/gate-notifier.ts) -- proactive gate elicitation

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

The MCP server calls `db.reload()` before resolving runs to pick up writes from the runner process.

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

Approve or reject a pending human gate.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `run_id` | `string` | No | Run ID prefix (8+ chars). Omit if only one run exists. |
| `approved` | `boolean` | **Yes** | Whether to approve (`true`) or reject (`false`) the gate. |
| `feedback` | `string` | No | Optional feedback. On rejection, passed to the generator for retry. |

### Behavior

1. Resolves the run
2. Checks that a gate exists with `status === "pending"`
3. Updates `state.gate.status` to `"approved"` or `"rejected"`
4. Sets `state.gate.feedback` and `state.gate.respondedAt`
5. Saves state to the database (the runner's `FilesystemGateStrategy` will pick it up on its next poll)

### Response

```
Gate "approval" approved.
```

Or with feedback:

```
Gate "approval" rejected. Feedback: The introduction section needs more detail.
```

### Error cases

```
No pending gate on this run.
```

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

## Gate Elicitation (Automatic)

In addition to the manual `cccp_gate_respond` tool, the MCP server includes a `GateNotifier` that automatically detects pending gates and prompts the user for approval via MCP elicitation.

### How it works

After the MCP server connects, a background polling loop scans the SQLite database every 2 seconds for pending gates. When a new gate is found, the server calls `elicitInput()` to present a structured approval form to the user. The form includes:

- **Decision**: `approve` or `reject` (required)
- **Feedback**: optional free-text feedback

The user's response is written directly to the database, and the pipeline runner picks it up on its next poll cycle.

### Requirements

- Claude Code v2.1.76+ (elicitation support)
- The CCCP MCP server must be registered in `.mcp.json`

### Fallback

If the connected client does not support elicitation, the notifier disables itself after the first failed attempt. The `cccp_gate_respond` tool remains available as a manual fallback.

See [Gate System](../architecture/gate-system.md) for the full gate architecture.

## Typical MCP Workflow

When the MCP server is registered, the typical flow is:

1. **Automatic:** The gate notifier detects pending gates and prompts the user via elicitation -- no manual action needed
2. **Manual fallback:** If elicitation is unavailable:
   1. **Check status:** `cccp_runs` to see active runs
   2. **Get details:** `cccp_status` with the run ID to see stage progress and pending gates
   3. **Review artifacts:** `cccp_artifacts` to read the deliverable being reviewed
   4. **Respond to gate:** `cccp_gate_respond` with approval/rejection and feedback

## Related Documentation

- [Gate System](../architecture/gate-system.md) -- how gate responses flow back to the runner
- [CLI Commands](cli-commands.md) -- `cccp mcp-server` command
- [Configuration](configuration.md) -- `.mcp.json` setup
