# Gate System

The gate system provides human-in-the-loop approval checkpoints within a pipeline. Gates block execution until a human approves or rejects, enabling review of intermediate artifacts before the pipeline continues.

**Source files:**
- [`src/gate/gate-strategy.ts`](../../src/gate/gate-strategy.ts) -- strategy interface
- [`src/gate/gate-watcher.ts`](../../src/gate/gate-watcher.ts) -- filesystem polling strategy
- [`src/gate/auto-approve.ts`](../../src/gate/auto-approve.ts) -- headless auto-approve strategy
- [`src/gate/feedback-artifact.ts`](../../src/gate/feedback-artifact.ts) -- numbered feedback markdown writer
- [`src/mcp/mcp-server.ts`](../../src/mcp/mcp-server.ts) -- MCP tools for gate responses and review
- [`src/mcp/gate-notifier.ts`](../../src/mcp/gate-notifier.ts) -- three-tier gate notification (channel, elicitation, manual)
- [`src/runner.ts`](../../src/runner.ts) -- gate orchestration, human_review, and feedback retry

## GateStrategy Interface

All gate implementations conform to a single interface defined in `src/gate/gate-strategy.ts`:

```typescript
export interface GateResponse {
  approved: boolean;
  feedback?: string;
  /** Path to structured feedback markdown artifact. */
  feedbackPath?: string;
}

export interface GateStrategy {
  waitForGate(gate: GateInfo): Promise<GateResponse>;
}
```

The `GateInfo` type (from `src/types.ts`) represents the pending gate:

```typescript
export interface GateInfo {
  stageName: string;
  status: "pending" | "approved" | "rejected";
  prompt?: string;
  feedback?: string;
  /** Path to structured feedback markdown artifact. */
  feedbackPath?: string;
  respondedAt?: string;
}
```

`feedbackPath` is set when feedback is written as a numbered artifact via `writeFeedbackArtifact()`. The `FilesystemGateStrategy` passes it through from `state.gate.feedbackPath` when returning the `GateResponse`.

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
  private dbService?: DbService,
)
```

- `runId` -- run ID for the current pipeline execution (used to poll state via `loadState(runId)`)
- `projectDir` -- project root directory (used to locate the SQLite database)
- `quiet` -- when `true`, suppresses console output (set when the TUI dashboard is active)
- `dbService` -- optional `DbService` instance. When provided, the gate-watcher delegates WASM reclaim to the service timer instead of managing it inline.

The gate strategy is created lazily by the runner after `createState()` produces a `runId`, since the run ID doesn't exist at context-construction time.

### Polling behavior

The strategy polls the SQLite database via `loadState()` every 5 seconds (`POLL_INTERVAL_MS = 5000`). On each tick:

1. Reload state from disk (`reloadFromDisk: true` to pick up external writes)
2. Check if the gate's `stageName` matches the one being waited on
3. If `status === "approved"` or `status === "rejected"`, resolve the promise

The `reloadFromDisk` flag is critical: it causes the database layer to re-read the SQLite file from disk, which is necessary because the MCP server (running in a separate process) may have written a gate response.

When no `DbService` is provided, the gate-watcher calls `reclaimWasmMemory()` every ~15 minutes (180 polls) to destroy the sql.js WASM module and allow V8 to GC its backing `ArrayBuffer`. When a `DbService` is provided, the service's timer handles reclaim automatically. See [TUI Dashboard — Memory Optimization](tui-dashboard.md#memory-optimization) for details.

A safety timeout (`MAX_POLL_COUNT = 8640`, ~12 hours at 5s) prevents the polling interval from running indefinitely if the gate state is corrupted or never resolved.

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

## Feedback Artifacts

**File:** `src/gate/feedback-artifact.ts`

When a gate response includes feedback (inline or via `feedback_file`), the feedback is persisted as a numbered markdown file in the run's `.cccp/` directory:

```
{artifactDir}/.cccp/{stageName}-gate-feedback-{N}.md
```

Sequence number `N` increments based on existing feedback files for the stage. The file contains a header with decision, timestamp, and the feedback body. Both `cccp_gate_respond` and `GateNotifier.writeGateResponse()` call `writeFeedbackArtifact()` and store the resulting path on `state.gate.feedbackPath`. The path is also recorded as a stage artifact under the key `gate-feedback`.

The feedback artifact path is the mechanism by which the runner decides whether to retry: the runner checks `gateResponse.feedbackPath` (not just `gateResponse.feedback`) to determine if structured feedback was provided. This distinction matters because the feedback path is passed into agent prompts as a file reference.

## PGE/GE Escalation Gates

Gates can also be triggered as an escalation strategy for PGE and GE stages. When a PGE or GE stage exhausts its `max_iterations` with a FAIL result and `on_fail: human_gate` is set, the runner creates a gate with a descriptive prompt:

```typescript
const gateInfo: GateInfo = {
  stageName: stage.name,
  status: "pending",
  prompt: `PGE stage "${stage.name}" failed after ${pgeResult.iterations} iterations. Approve to skip and continue, reject to stop, or reject with feedback to retry the generation cycle.`,
};
```

Three outcomes are possible:

- **Approved:** Pipeline continues (stage marked `skipped`).
- **Rejected with feedback artifact:** The PGE cycle retries using `PgeCycleOptions`. The planner and contract writer are skipped (reuse `existingContractPath` and `existingTaskPlanPath`), and `gateFeedbackPath` injects the feedback into the generator prompt. Max 3 gate retries (`MAX_GATE_RETRIES`).
- **Rejected without feedback (or max retries reached):** Stage marked `failed`, pipeline stops.

### Autoresearch escalation retry

The same pattern applies to autoresearch stages with `on_fail: human_gate`. On rejection with feedback, the cycle retries with `AutoresearchCycleOptions.gateFeedbackPath` injecting the feedback into the adjuster prompt. Max 3 gate retries.

## Human Review Gates

The `human_review: true` flag on `agent`, `pge`, and `ge` stages fires a gate after successful completion, giving a human reviewer a chance to inspect and reject output before the pipeline continues.

### PGE stages with `human_review: true`

After the PGE cycle passes evaluation, the runner creates a review gate. On rejection with feedback:

1. The runner calls `dispatchEvaluatorWithFeedback()` -- dispatches the evaluator agent with the human feedback file to produce a structured FAIL evaluation incorporating the reviewer's concerns.
2. The PGE cycle re-enters the GE loop with `PgeCycleOptions` (skipping planner/contract, using the human-mediated evaluation as `gateFeedbackPath`).
3. Max 3 gate retries.

On approval, the stage passes normally.

### GE stages with `human_review: true`

Same pattern as PGE. After the GE cycle passes, the runner creates a review gate. On rejection with feedback:

1. The runner calls `dispatchGeEvaluatorWithFeedback()` -- dispatches the evaluator with human feedback to produce a structured FAIL evaluation.
2. The GE cycle re-enters with `GeCycleOptions` (reusing `existingContractPath`, injecting feedback as `gateFeedbackPath`).
3. Max 3 gate retries.

On approval, the stage passes normally.

### Agent stages with `human_review: true`

After the agent completes, the runner creates a review gate. On rejection with feedback:

1. The agent is re-run with `gateFeedback` injected into the prompt (pointing to the feedback artifact path).
2. Max 3 gate retries.

On approval, the stage passes normally. On rejection without feedback or after max retries, the stage fails.

## MCP Gate Notification

**File:** `src/mcp/gate-notifier.ts`

The `GateNotifier` class provides proactive gate notifications to connected Claude Code sessions. It uses a three-tier notification strategy, tried in order:

1. **Channel notification** (push-based, experimental) -- non-blocking push via `notifications/claude/channel`
2. **Elicitation form** (interactive) -- blocking MCP form with approve/reject + feedback fields
3. **Manual fallback** -- user discovers gates via `cccp_status` / `cccp_gate_respond` / `cccp_gate_review` tools

### Channel notifications (Tier 1)

The MCP server declares `experimental: { "claude/channel": {} }` in its capabilities. When a pending gate is detected, the notifier sends a `notifications/claude/channel` message with severity `high`, including the gate stage name, prompt, and instructions to use `cccp_gate_review`.

Launching the MCP server with channel support requires the `--dangerously-load-development-channels server:cccp` flag on the Claude Code side (since channels are experimental).

If the channel notification succeeds, elicitation is skipped. If it fails (client doesn't support channels), the notifier sets `channelSupported = false` and falls through to elicitation.

### Elicitation form (Tier 2)

When channels are unavailable, the notifier calls `server.elicitInput()` with a structured form:

- **Decision** (required): An enum with values `"approve"` or `"reject"`
- **Feedback** (optional): Free-text feedback (on rejection, triggers retry with feedback)

The elicitation `action` (accept/decline/cancel) is also respected:
- **accept**: The form's `decision` field determines approval or rejection
- **decline**: Treated as rejection (no feedback)
- **cancel**: The gate remains pending and will be re-prompted on the next poll cycle

### Graceful degradation

Each tier degrades independently. If channels fail on first attempt, `channelSupported` is set to `false`. If elicitation fails on first attempt, `elicitationSupported` is set to `false`. When both are disabled, the poll loop exits early and the user must use MCP tools manually.

### Session affinity

The MCP server generates a UUID session ID on startup (`randomUUID()`). Pipeline runs accept a `--session-id` flag, which is stored on `PipelineState.sessionId`.

The notifier filters gates by session affinity:

- If the run has a `sessionId` that does not match the notifier's `sessionId`, the gate is skipped (it belongs to a different MCP session).
- If the run has no `sessionId` (unaffiliated), the gate is notified by **every** connected MCP instance — this causes duplicate notifications (e.g., both a channel push and an elicitation popup in different sessions).
- The `cccp_session_id` tool exposes the session ID so callers can pass it to `cccp run --session-id`.

**Always pass `--session-id` when launching pipelines** to ensure gate notifications are routed to a single session. The `/cccp-run` skill instructs Claude to call `cccp_session_id` and include `--session-id` by default.

### Feedback artifact writing

Both the elicitation and channel paths call `writeGateResponse()`, which writes feedback as a numbered artifact (via `writeFeedbackArtifact`) and records it as a stage artifact before saving state.

### Duplicate prevention

The notifier tracks seen gates by `{runId}:{stageName}`. A gate is only notified once. Seen gates are cleaned up when the run no longer has a pending gate. If the gate is resolved externally while a notification is pending, the notifier reloads state before writing and discards the stale response.

### Startup

The notifier is started automatically by `startMcpServer()` after the MCP server connects to its transport. It receives the server instance, project directory, and session ID.

## Interacting with Gates

### Via channel notification or elicitation (automatic)

When the CCCP MCP server is registered with Claude Code, pending gates are automatically detected and pushed via channel notification (preferred) or presented as elicitation forms (fallback). This is the recommended flow -- no manual action is needed to discover pending gates. Channel notifications require the `--dangerously-load-development-channels server:cccp` flag.

### Via MCP Tools (manual)

If automatic notification is unavailable or the user prefers explicit control:

```
1. cccp_gate_review — get full context (artifacts, evaluations, contract, pipeline status)
2. cccp_gate_respond — approve/reject with inline feedback or feedback_file
```

See [MCP Tools](../api/mcp-tools.md) for full parameter reference.

### Via the `cccp dashboard` TUI

The dashboard shows pending gates in the stage list. The actual response must come through the MCP server or programmatic state update.

### Via cmux notification

When running inside a cmux workspace, a desktop notification is sent when a gate becomes pending. The response must still come through MCP or direct state update.

### Programmatically

Any process that can write to the SQLite database (at `.cccp/cccp.db` in the project directory) can respond to a gate by updating the run's `gate_json` column.

## Related Documentation

- [Pipeline Authoring](../guides/pipeline-authoring.md) -- `human_gate` stage type, `on_fail` escalation, `human_review`
- [MCP Tools](../api/mcp-tools.md) -- `cccp_gate_respond`, `cccp_gate_review`, `cccp_session_id` tool references
- [TUI Dashboard](tui-dashboard.md) -- gate display in the dashboard
