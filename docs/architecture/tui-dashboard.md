# TUI Dashboard

The CCCP dashboard is an Ink-based (React for the terminal) real-time UI that shows pipeline progress, agent activity, and an event log. It runs in two modes: inline with `cccp run`, or standalone via `cccp dashboard`.

**Source files:**
- [`src/tui/dashboard.tsx`](../../src/tui/dashboard.tsx) -- main Dashboard component and launch functions
- [`src/tui/components.tsx`](../../src/tui/components.tsx) -- Header, StageList, AgentActivityPanel, EventLog
- [`src/tui/cmux.ts`](../../src/tui/cmux.ts) -- cmux CLI wrapper for sidebar status and notifications
- [`src/logger.ts`](../../src/logger.ts) -- Logger interface (ConsoleLogger, QuietLogger, SilentLogger)

## Dashboard Modes

### Inline mode (`cccp run` and `cccp resume`)

When running `cccp run` or `cccp resume` without `--headless` or `--no-tui` (and without `--dry-run` for `run`), the dashboard renders inline. It receives activity updates through the in-process [activity bus](streaming.md#activity-bus):

```typescript
const dashboard = startDashboard(runId, projectDir, initialState);
// ... pipeline runs ...
dashboard.unmount();
```

The `startDashboard()` function sets `useEventBus={true}` on the Dashboard component. Both `run` and `resume` use this inline mode since the pipeline executes in the same process.

### Standalone mode (`cccp dashboard`)

A separate command that monitors an existing run. It reads state from SQLite and tails `.stream.jsonl` files via the [StreamTailer](streaming.md#streamtailer):

```typescript
const { launchDashboard } = await import("./tui/dashboard.js");
await launchDashboard(artifactDir, dashProjectDir, existingState);
```

In standalone mode, `useEventBus` is not set, so the component creates a `StreamTailer` to read activity from disk.

## Layout

The dashboard uses a split-pane layout:

```
+--------------------------------------------------+
| CCCP: pipeline-name (project)   Elapsed: 1m 23s  |  <-- Header
+--------------------------------------------------+
| Stages               | Agent Activity             |
|  ✓ research          | [writer] claude-sonnet-4    |
|  ▸ review (2)        |   ✓ Read /src/foo.ts        |  <-- Split pane
|  ○ approval ⚑        |   ▶ Write /out/doc.md       |
|                       |   Tokens: 5,432 in / 1,234  |
|  ⏸ Gate: approval    |                             |
+--------------------------------------------------+
| Event Log                                         |
|  14:32:01 ▶ Started research                      |  <-- Bottom pane
|  14:32:45 ✓ Completed research (passed)           |
|  14:32:46 ▶ Started review                        |
+--------------------------------------------------+
```

When the pipeline is complete, the right pane shows the final status and total cost instead of agent activity.

## Components

### Header

**File:** `src/tui/components.tsx`

Displays the pipeline name, project name, and elapsed time.

```typescript
interface HeaderProps {
  pipelineName: string;
  project: string;
  elapsed: number;
}
```

Elapsed time formats as `Xm Ys` or just `Ys` for durations under a minute.

### StageList (left pane)

Shows all stages with status icons, iteration counts (for PGE), and duration:

| Status | Icon | Color |
|--------|------|-------|
| `pending` | `○` | default |
| `in_progress` | spinner | yellow |
| `passed` | `✓` | green |
| `failed` / `error` | `✗` | red |
| `skipped` | `⏭` | gray |

Additional indicators:
- PGE stages show iteration count: `review (2)`
- Human gate stages show a flag: `approval ⚑`
- Completed stages show duration: `research 12.3s`
- Pending gates display below the stage list: `⏸ Gate: approval`

The spinner for in-progress stages uses the `ink-spinner` package with `type="dots"`.

### AgentActivityPanel (right pane)

Displays real-time information about the currently active agent:

```typescript
interface AgentActivityPanelProps {
  activity: AgentActivity | null;
}
```

Shows:
1. **Agent name and model:** `[writer] claude-sonnet-4-20250514`
2. **Tool history** (last 8 entries):
   - Active tools in cyan with `▶` prefix
   - Completed tools in gray with `✓` prefix
   - Tool summaries (file paths, commands) truncated to 50 chars
3. **Thinking preview** (if available): first 80 chars of the latest thinking block
4. **Sub-agent activity** (if present): displayed in magenta
5. **Stats:** `Tokens: 5,432 in / 1,234 out | Tools: 12 | $0.0423`

### EventLog (bottom pane)

Shows the last 8 events from the SQLite database's `events` table:

```typescript
interface EventLogProps {
  events: StateEvent[];
}
```

Event types and their display:

| Event Type | Display | Color |
|------------|---------|-------|
| `stage_start` | `▶ Started` | yellow |
| `stage_complete` | `✓ Completed` | green |
| `pge_planner_start` | `↻ PGE planner` | default |
| `pge_planner_done` | `✓ PGE planner done` | default |
| `pge_contract_start` | `↻ PGE contract` | default |
| `pge_contract_done` | `✓ PGE contract done` | default |
| `pge_progress` | `↻ PGE` | default |
| `gate_pending` | `⏸ Gate pending` | blue |
| `gate_responded` | `✓ Gate responded` | green |
| `pipeline_complete` | `✔ Pipeline done` | green |

Each event shows timestamp (HH:MM:SS), formatted type, stage name, and optional data (status, step, iteration).

## Polling and Update Strategy

### Unified polling (500ms interval)

The dashboard uses a single interval for state polling, event fetching, and elapsed timer updates:

```typescript
const interval = setInterval(async () => {
  setElapsed(Date.now() - startTime);
  const updated = await loadState(runId, projectDir);
  // Compare with current state, update if changed
  // Poll events incrementally from DB
}, 500);
```

State comparison checks `status`, `stages` (JSON stringified), and `gate?.status` to avoid unnecessary re-renders.

Events are polled incrementally using `lastEventId` as a cursor, keeping only the last 200 events in memory.

### Activity debouncing (100ms)

Activity updates from the stream parser can arrive very frequently. The dashboard debounces them to at most one update per 100ms:

```typescript
const now = Date.now();
if (now - lastActivityTime.current >= 100) {
  setActivity(a);  // Immediate update
} else {
  pendingActivity.current = a;  // Buffer until next window
  // setTimeout fires after 100ms to flush pending
}
```

### Pipeline completion

When the pipeline reaches a terminal status (`passed`, `failed`, or `error`), the dashboard triggers completion after a 500ms delay:

```typescript
if (updated.status === "passed" || updated.status === "failed" || updated.status === "error") {
  setTimeout(() => onComplete?.(), 500);
}
```

## Memory Optimization

yoga-layout 3.x uses WASM, and WASM linear memory is grow-only -- each `Yoga.Node.create()` / `freeRecursive()` cycle fragments the heap, and freed pages are never returned to V8. Over multi-hour runs this can accumulate to gigabytes. Two mitigations:

### Render throttle (10 FPS)

Both `render()` calls pass `{ maxFps: 10 }` (Ink default is 30). This reduces yoga layout calculations by ~3x, proportionally slowing WASM memory growth.

### Periodic remount (15 minutes)

The inline dashboard (`startDashboard`) unmounts and remounts the Ink app every 15 minutes. Unmounting calls `freeRecursive()` on the root yoga tree and releases the entire React fiber tree. On remount:

- **Elapsed timer** is preserved via the `startTime` prop
- **Stage state** and **event log** repopulate from SQLite on the next poll (~500ms)
- **Agent activity** repopulates from the activity bus within ~100ms

```typescript
const RECYCLE_INTERVAL_MS = 15 * 60 * 1000;

const recycleTimer = setInterval(() => {
  instance.unmount();
  instance = mount();  // fresh React tree + fresh yoga nodes
}, RECYCLE_INTERVAL_MS);
```

This caps memory at whatever accumulates in a 15-minute window (~100-300 MB) regardless of total run duration.

## cmux Integration

**File:** `src/tui/cmux.ts`

When running inside a cmux workspace (detected via `CMUX_WORKSPACE_ID` environment variable), CCCP uses the cmux CLI for sidebar status, progress bars, and desktop notifications.

### Detection

```typescript
export function isCmuxAvailable(): boolean {
  return !!process.env.CMUX_WORKSPACE_ID;
}
```

All cmux commands are no-ops when not in a cmux workspace.

### Available commands

| Function | cmux Command | Purpose |
|----------|-------------|---------|
| `setStatus(label)` | `cmux set-status cccp <label>` | Sidebar status pill |
| `setProgress(fraction)` | `cmux set-progress <0.0-1.0>` | Progress bar |
| `log(message, level)` | `cmux log --level <level> <msg>` | Structured log entry |
| `notify(title, body?)` | `cmux notify --title <t> [--body <b>]` | Desktop notification |
| `newSplit(direction)` | `cmux new-split <right\|below>` | Open a split pane (parses `OK surface:N workspace:M` → returns `surface:N`) |
| `sendText(surfaceId, text)` | `cmux send --surface <id> <text>` | Send text to a split pane |
| `sendKey(surfaceId, key)` | `cmux send-key --surface <id> <key>` | Send a keystroke to a split pane |

### Pipeline-level helpers

| Function | When Called |
|----------|-----------|
| `updatePipelineStatus(name, index, total)` | Each stage start -- updates status pill and progress bar |
| `notifyGateRequired(stageName)` | Gate enters pending state |
| `notifyPipelineComplete(name, status)` | Pipeline finishes |

### Error handling

All cmux commands silently catch errors -- cmux failures are non-critical:

```typescript
async function cmux(...args: string[]): Promise<string> {
  if (!isCmuxAvailable()) return "";
  try {
    const { stdout } = await exec("cmux", args);
    return stdout.trim();
  } catch {
    return "";
  }
}
```

## Related Documentation

- [Streaming Architecture](streaming.md) -- how activity data flows to the dashboard
- [Gate System](gate-system.md) -- gate display and interaction
- [CLI Commands](../api/cli-commands.md) -- `cccp run` and `cccp dashboard` commands
