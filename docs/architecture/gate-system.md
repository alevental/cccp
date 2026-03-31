# Gate System

The gate system provides human-in-the-loop approval checkpoints within a pipeline. Gates block execution until a human approves or rejects, enabling review of intermediate artifacts before the pipeline continues.

**Source files:**
- [`src/gate/gate-strategy.ts`](../../src/gate/gate-strategy.ts) -- strategy interface
- [`src/gate/gate-watcher.ts`](../../src/gate/gate-watcher.ts) -- filesystem polling strategy
- [`src/gate/auto-approve.ts`](../../src/gate/auto-approve.ts) -- headless auto-approve strategy
- [`src/mcp/mcp-server.ts`](../../src/mcp/mcp-server.ts) -- MCP tool for gate responses
- [`src/mcp/gate-notifier.ts`](../../src/mcp/gate-notifier.ts) -- proactive gate elicitation via MCP
- [`src/runner.ts`](../../src/runner.ts) -- gate orchestration in the pipeline runner

## GateStrategy Interface

All gate implementations conform to a single interface defined in `src/gate/gate-strategy.ts`:

```typescript
export interface GateResponse {
  approved: boolean;
  feedback?: string;
}

export interface GateStrategy {
  waitForGate(gate: GateInfo): Promise<GateResponse>;
}
```

The `GateInfo` type (from `src/state.ts`) represents the pending gate:

```typescript
export interface GateInfo {
  stageName: string;
  status: "pending" | "approved" | "rejected";
  prompt?: string;
  feedback?: string;
  respondedAt?: string;
}
```

A strategy is responsible for three things:

1. Signaling that a gate is pending (e.g., writing to the database)
2. Waiting for a response
3. Returning the `GateResponse`

## FilesystemGateStrategy

**File:** `src/gate/gate-watcher.ts`

The default strategy used in interactive (non-headless) mode. It writes `gate_pending` state to the database, then polls for a response.

### Constructor

```typescript
constructor(
  private runId: string,
  private projectDir?: string,
  private quiet?: boolean,
)
```

- `runId` -- run ID for the current pipeline execution (used to poll state via `loadState(runId)`)
- `projectDir` -- project root directory (used to locate the SQLite database)
- `quiet` -- when `true`, suppresses console output (set when the TUI dashboard is active)

The gate strategy is created lazily by the runner after `createState()` produces a `runId`, since the run ID doesn't exist at context-construction time.

### Polling behavior

The strategy polls the SQLite database via `loadState()` every 2 seconds (`POLL_INTERVAL_MS = 2000`). On each tick:

1. Reload state from disk (`reloadFromDisk: true` to pick up external writes)
2. Check if the gate's `stageName` matches the one being waited on
3. If `status === "approved"` or `status === "rejected"`, resolve the promise

The `reloadFromDisk` flag is critical: it causes the database layer to re-read the SQLite file from disk, which is necessary because the MCP server (running in a separate process) may have written a gate response.

### Gate notification

Before polling begins, the strategy sends a desktop notification via cmux:

```typescript
await notifyGateRequired(gate.stageName);
```

This calls `cmux notify --title "Gate Required" --body "Pipeline waiting for approval: <stageName>"`, ensuring the operator sees the gate even if they are not watching the terminal.

### Error resilience

The polling loop catches and ignores all errors during state reads:

```typescript
} catch {
  // State file may be mid-write -- ignore and retry.
}
```

This handles the case where the database is being written to by the runner or MCP server concurrently.

## AutoApproveStrategy

**File:** `src/gate/auto-approve.ts`

Used in `--headless` / CI mode. Immediately approves every gate with no human interaction:

```typescript
export class AutoApproveStrategy implements GateStrategy {
  async waitForGate(gate: GateInfo): Promise<GateResponse> {
    console.log(`    ⏭ Auto-approving gate: ${gate.stageName}`);
    return { approved: true };
  }
}
```

Selected by the runner after state is created (headless mode is set via `--headless` CLI flag):

```typescript
// In runner.ts, after createState() produces a runId:
if (!ctx.gateStrategy && !ctx.headless) {
  ctx.gateStrategy = new FilesystemGateStrategy(state.runId, ctx.projectDir, ctx.quiet);
}
```

## Gate Lifecycle

The full lifecycle of a gate, from creation to resolution:

### 1. Gate created (runner writes pending state)

In `src/runner.ts`, when the runner reaches a `human_gate` stage:

```typescript
const gateInfo: GateInfo = {
  stageName: stage.name,
  status: "pending",
  prompt: stage.prompt,
};
state.gate = gateInfo;
await saveState(ctx.artifactDir, state);
```

The database now contains a run with `gate_json` set to the pending gate info.

### 2. Gate displayed

The TUI dashboard (`src/tui/components.tsx`) renders the pending gate:

```typescript
{state.gate?.status === "pending" && (
  <Box marginTop={1}>
    <Text color="blue" bold>
      {" "}⏸ Gate: {state.gate.stageName}
    </Text>
  </Box>
)}
```

### 3. Gate responded (via MCP or direct state edit)

The MCP server's `cccp_gate_respond` tool updates the database directly:

```typescript
state.gate.status = approved ? "approved" : "rejected";
state.gate.feedback = feedback;
state.gate.respondedAt = new Date().toISOString();
await saveState(state);
```

### 4. Gate resolved (strategy returns)

The `FilesystemGateStrategy` picks up the change on its next poll cycle and returns the `GateResponse` to the runner.

### 5. Gate cleared

The runner clears the gate from state after receiving the response:

```typescript
state.gate = undefined;
await saveState(ctx.artifactDir, state);
```

### 6. Pipeline continues or stops

- **Approved:** The stage result is `passed`, pipeline continues.
- **Rejected:** Behavior depends on `on_reject`:
  - `"stop"` (default): Stage fails, pipeline stops.
  - `"retry"`: Reserved for future implementation; currently treated as `stop`.

## PGE Escalation Gates

Gates can also be triggered as an escalation strategy for PGE stages. When a PGE stage exhausts its `max_iterations` with a FAIL result and `on_fail: human_gate` is set, the runner creates a gate with a descriptive prompt:

```typescript
const gateInfo: GateInfo = {
  stageName: stage.name,
  status: "pending",
  prompt: `PGE stage "${stage.name}" failed after ${pgeResult.iterations} iterations. Approve to continue or reject to stop.`,
};
```

If approved, the pipeline continues (stage is marked `skipped`). If rejected, the stage is marked `failed`.

## MCP Gate Elicitation

**File:** `src/mcp/gate-notifier.ts`

The `GateNotifier` class provides proactive gate notifications to connected Claude Code sessions via MCP elicitation. Instead of waiting for the user to check `cccp_status`, the MCP server automatically prompts for approval when a gate becomes pending.

### How it works

1. A background polling loop (2-second interval) scans all pipeline runs for pending gates
2. When a new pending gate is detected, the notifier calls `server.elicitInput()` with a structured form
3. Claude Code displays the form to the user with an approve/reject decision and optional feedback field
4. The user's response is written directly to the SQLite database
5. The runner's `FilesystemGateStrategy` picks up the response on its next poll cycle

### Elicitation form

The form presents two fields:
- **Decision** (required): An enum with values `"approve"` or `"reject"`
- **Feedback** (optional): Free-text feedback passed to the generator on rejection

The elicitation `action` (accept/decline/cancel) is also respected:
- **accept**: The form's `decision` field determines approval or rejection
- **decline**: Treated as rejection (no feedback)
- **cancel**: The gate remains pending and will be re-prompted on the next poll cycle

### Graceful degradation

If the connected MCP client does not support elicitation (e.g., older Claude Code versions), the first `elicitInput()` call throws an error. The notifier catches this, sets an internal flag, and stops attempting elicitation for the remainder of the session. Gate approval falls back to the existing `cccp_gate_respond` tool.

### Duplicate prevention

The notifier tracks seen gates by `{runId}:{stageName}`. A gate is only elicited once. If the gate is resolved externally (via `cccp_gate_respond` or direct database write) while an elicitation is pending, the notifier detects this by reloading state before writing and discards the stale response.

### Startup

The notifier is started automatically by `startMcpServer()` after the MCP server connects to its transport.

## Interacting with Gates

### Via MCP Elicitation (automatic)

When the CCCP MCP server is registered with Claude Code, pending gates are automatically detected and presented as elicitation forms. This is the recommended flow -- no manual action is needed to discover pending gates.

### Via MCP Tools (manual)

If elicitation is unavailable or the user prefers explicit control, use the `cccp_gate_respond` tool. See [MCP Tools](../api/mcp-tools.md).

```
Use cccp_status to see pending gates, then cccp_gate_respond to approve/reject.
```

### Via the `cccp dashboard` TUI

The dashboard shows pending gates in the stage list. The actual response must come through the MCP server or programmatic state update.

### Via cmux notification

When running inside a cmux workspace, a desktop notification is sent when a gate becomes pending. The response must still come through MCP or direct state update.

### Programmatically

Any process that can write to the SQLite database (at `.cccp/cccp.db` in the project directory) can respond to a gate by updating the run's `gate_json` column.

## Related Documentation

- [Pipeline Authoring](../guides/pipeline-authoring.md) -- `human_gate` stage type and `on_fail` escalation
- [MCP Tools](../api/mcp-tools.md) -- `cccp_gate_respond` tool reference
- [TUI Dashboard](tui-dashboard.md) -- gate display in the dashboard
