# TUI Dashboard

The CCCP dashboard is an Ink-based (React for the terminal) real-time UI that shows pipeline progress, agent activity, and an event log. It runs in two modes: inline with `cccp run`, or standalone via `cccp dashboard`.

**Source files:**
- [`src/tui/dashboard.tsx`](../../src/tui/dashboard.tsx) -- main Dashboard component and launch functions
- [`src/tui/components.tsx`](../../src/tui/components.tsx) -- Header, StageList, AgentActivityPanel
- [`src/git.ts`](../../src/git.ts) -- GitInfo type and one-shot git metadata query
- [`src/tui/detail-log.tsx`](../../src/tui/detail-log.tsx) -- DetailLog with scrollable event visualization
- [`src/tui/agent-monitor.tsx`](../../src/tui/agent-monitor.tsx) -- per-agent detail monitor (full-fidelity stream view)
- [`src/tui/agent-panes.ts`](../../src/tui/agent-panes.ts) -- AgentPaneManager for cmux pane lifecycle
- [`src/tui/cmux.ts`](../../src/tui/cmux.ts) -- cmux CLI wrapper for sidebar status, notifications, and pane management
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
+──────────────────────────────────────────────────────────+
│ CCCP: pipeline-name (project)  a1b2c3d4  Elapsed: 5m 3s │
│   main  7a3e1f2  ✗ dirty  ↑2  [my-repo]                 │
+──────────────────────────────────────────────────────────+
│ Stages              │ Agent Activity (2 active)          │
│  ✓ research  12.3s  │ [design-gen] sonnet · 2m  │ [eval]│
│  ▸ build-pipeline e5f6g7h8                       │  ▶ Rea│
│    ├─ ✓ design      │   ✓ Read /src/foo.ts      │  2,100│
│    ├─ ▸ implement   │   ✓ Grep "pattern"        │  $0.01│
│    ├─ ○ review      │   12.4k/3.2k tok · $0.04  │       │
│  ○ approval ⚑       │                           │       │
+──────────────────────────────────────────────────────────+
│ Detail Log [↑↓ scroll]                                   │
│ 14:32:01  ▶ Started: research (agent)                    │
│              agent: researcher · sonnet · high            │
│ 14:32:45  ✓ Completed: research passed (45.2s)           │
│ 14:32:46  ┌─ PGE: implement                              │
│           │  ▶ Planner [architect] opus · high            │
│           │  ✓ Task plan → /artifacts/plan.md             │
│           │  ▶ Generator [impl] sonnet · high iter 1/3   │
+──────────────────────────────────────────────────────────+
```

When the pipeline is complete, the right pane shows the final status and total cost instead of agent activity.

## Components

### Header

**File:** `src/tui/components.tsx`

Two-line header. Line 1 displays the pipeline name, project name, run ID (8-char prefix), elapsed time, and heap/RSS memory. Line 2 displays git repository details fetched once on dashboard mount from `projectDir`.

```typescript
interface HeaderProps {
  pipelineName: string;
  project: string;
  runId: string;
  elapsed: number;
  memUsage?: NodeJS.MemoryUsage;
  gitInfo?: GitInfo | null;
}
```

Elapsed time formats as `Xm Ys` or just `Ys` for durations under a minute.

**Git info line** (`src/git.ts`):

```
  main  7a3e1f2  ✗ dirty  ↑2 ↓0  [worktree]  [my-repo]
```

| Field | Color | When shown |
|-------|-------|------------|
| Branch name | cyan | Always (`(detached)` for detached HEAD) |
| Short commit hash (7 chars) | dim | Always |
| Dirty/clean indicator | yellow (`✗ dirty`) / green (`✓ clean`) | Always |
| Ahead/behind counts | dim | Only when non-zero and tracking branch exists |
| `[worktree]` tag | dim | Only in a linked worktree |
| `[repoName]` | dim | Always (basename of git root) |

Git info is fetched once asynchronously via `getGitInfo(projectDir)` on Dashboard mount — no polling. Returns `null` gracefully for non-git directories, detached HEAD, or if `git` is not in PATH. When unavailable, the header renders as a single line (no git row).

### StageList (left pane)

Shows all stages with status icons, iteration counts (for PGE), and duration:

| Status | Icon | Color |
|--------|------|-------|
| `pending` | `○` | default |
| `in_progress` | spinner (static `⏸` for gates) | yellow (blue for gates) |
| `passed` | `✓` | green |
| `failed` / `error` | `✗` | red |
| `skipped` | `⏭` | gray |

Additional indicators:
- PGE stages show iteration count: `review (2)`
- Human gate stages show a flag: `approval ⚑`
- Completed stages show duration: `research 12.3s`
- Pending gates display below the stage list: `⏸ Gate: approval`
- Sub-pipeline stages show nested children inline with `├─` indent, with the child run ID (8-char prefix, dimmed) next to the parent stage name:
  ```
  ▸ build-pipeline e5f6g7h8
      ├─ ✓ design 12.3s
      ├─ ▸ implement
      ├─ ○ review
  ```

The spinner for in-progress stages uses the `ink-spinner` package with `type="dots"`. Human gate stages use a static `⏸` icon instead of an animated spinner to avoid continuous re-renders during long gate waits.

### AgentActivityPanel (right pane)

Shows only agents whose corresponding stage is `in_progress`, with per-agent elapsed timers:

```typescript
interface AgentActivityPanelProps {
  activities: Map<string, AgentActivity>;
  stages: Record<string, StageState>;
  dispatchStartTimes: Map<string, number>;
  now: number;
}
```

Two layout modes:

**Horizontal columns (1-3 active agents):** Each agent gets an equal-width column showing:
1. **Agent name + model + elapsed timer:** `[design-gen] sonnet · 2m 14s`
2. **Tool history** (last 5 entries): active tools in cyan `▶`, completed in gray `✓`, summaries truncated to 40 chars
3. **Stats:** `12.4k/3.2k tok · $0.04`

Columns are separated by `│` dividers.

**Compact rows (4+ active agents):** Each agent on one line:
```
[design-gen] sonnet · high · 2m 14s  ▶ Write  12k/3k tok  $0.04
```

Agents are cleaned up per-stage: when a stage leaves `in_progress`, its agent key (matched by prefix) is removed from the activities Map and dispatch start times.

### DetailLog (bottom pane)

Keyboard-scrollable event log showing rich PGE visualization. Uses Up/Down arrows, PageUp/PageDown, Home/End for navigation. Keeps up to 500 events in React state.

When scrolled up, shows `[scrolled — press End to resume]` indicator. When at the bottom with overflow, shows `[↑↓ scroll]` hint.

Stage start events include metadata: agent name, model, effort, inputs, and output. PGE phase starts show model/effort badges: `▶ Generator [architect] sonnet · high iter 1/3`.

Agent completion events (`stage_complete`, `pge_*_done`) include an optional `summary` field — the last `task_progress` description from Claude Code's stream output. When present, the detail log renders it as a dimmed line under the completion entry, giving a narrative snapshot of what the agent was doing when it finished.

Sub-pipeline child events render as `↳ [child-pipeline] stage: started/completed`. Child PGE/GE/autoresearch phase events also render inline with `↳` prefix showing planner/generator/evaluator starts and PASS/FAIL results.

| Event Type | Display | Color |
|------------|---------|-------|
| `stage_start` | `▶ Started: name (type)` + metadata lines | yellow |
| `stage_complete` | `✓ Completed: name status (Xs)` + optional summary | green/red |
| `pge_planner_start` | `┌─ PGE: name` + `▶ Planner [agent] model · effort` | cyan/yellow |
| `pge_planner_done` | `✓ Task plan → path` + optional summary | dim |
| `pge_contract_done` | `✓ Contract → path` + optional summary + artifact preview | dim |
| `pge_generator_start` | `▶ Generator [agent] model · effort iter X/Y` | yellow |
| `pge_generator_done` | `✓ Deliverable → path` + optional summary | dim |
| `pge_evaluator_start` | `▶ Evaluator [agent] model · effort iter X/Y` | yellow |
| `pge_evaluator_done` | `✓ Evaluation → path` + optional summary | dim |
| `pge_evaluation` | `✔ PASS` or `✗ FAIL` with artifact preview | green/red |
| `child_stage_start` | `↳ [pipeline] stage: started` | yellow |
| `child_stage_complete` | `↳ [pipeline] stage: status` | green/red |
| `child_pge_*` | `↳ [pipeline] stage: ▶ Phase [agent]` / `✔ PASS` / `✗ FAIL` | cyan/green/red |
| `loop_start` | `┌─ Loop: name` | cyan |
| `loop_body_start` | `▶ Body [agent] model · effort iter X/Y` | yellow |
| `loop_body_done` | `✓ Body stage → path` + optional summary | dim |
| `loop_evaluator_start` | `▶ Evaluator [agent] model · effort iter X/Y` | yellow |
| `loop_evaluator_done` | `✓ Evaluation → path` + optional summary | dim |
| `loop_evaluation` | `✔ PASS` or `✗ FAIL` | green/red |
| `child_loop_body_start` | `↳ [pipeline] stage: ▶ Body [agent]` | yellow |
| `child_loop_evaluator_start` | `↳ [pipeline] stage: ▶ Evaluator [agent]` | yellow |
| `child_loop_evaluation` | `↳ [pipeline] stage: ✔ PASS` / `✗ FAIL` | green/red |
| `child_loop_start` | _(suppressed verbose event)_ | -- |
| `child_loop_body_done` | _(suppressed verbose event)_ | -- |
| `child_loop_evaluator_done` | _(suppressed verbose event)_ | -- |
| `ge_contract_start` | `┌─ GE: name` + `▶ Contract [agent] model · effort` | cyan/yellow |
| `ge_contract_done` | `✓ Contract → path` + optional summary + artifact preview | dim |
| `ge_start` | Generator + Evaluator agent names, max iters | cyan |
| `ge_generator_start` | `▶ Generator [agent] model · effort iter X/Y` | yellow |
| `ge_generator_done` | `✓ Deliverable → path` + optional summary | dim |
| `ge_evaluator_start` | `▶ Evaluator [agent] model · effort iter X/Y` | yellow |
| `ge_evaluator_done` | `✓ Evaluation → path` + optional summary | dim |
| `ge_evaluation` | `✔ PASS` or `✗ FAIL` with artifact preview | green/red |
| `child_ge_contract_start` | `↳ [pipeline] stage: ▶ Contract [agent]` | yellow |
| `child_ge_generator_start` | `↳ [pipeline] stage: ▶ Generator [agent]` | yellow |
| `child_ge_evaluator_start` | `↳ [pipeline] stage: ▶ Evaluator [agent]` | yellow |
| `child_ge_evaluation` | `↳ [pipeline] stage: ✔ PASS` / `✗ FAIL` | green/red |
| `child_ge_start` | _(suppressed verbose event)_ | -- |
| `child_ge_contract_done` | _(suppressed verbose event)_ | -- |
| `child_ge_generator_done` | _(suppressed verbose event)_ | -- |
| `child_ge_evaluator_done` | _(suppressed verbose event)_ | -- |
| `gate_pending` | `⏸ Gate pending: name` | blue |
| `pipeline_paused` | `⏸ Pipeline paused (next: stage)` | blue |
| `pipeline_complete` | `═ Pipeline status` | green/red |

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll detail log |
| `PgUp` / `PgDn` | Page scroll detail log |
| `Home` / `g` | Jump to top |
| `End` / `G` | Jump to bottom (auto-scroll) |
| `p` | Request pipeline pause at next clean breakpoint |

## Polling and Update Strategy

### Adaptive polling (setTimeout chain)

The dashboard uses a `setTimeout` chain (not `setInterval`) for state polling, event fetching, and elapsed timer updates. The interval adapts based on pipeline state:

- **Active (500ms):** When stages are running and the pipeline is doing work.
- **Gate idle (5s):** When a gate is pending and nothing is changing. This 10x reduction in poll frequency dramatically reduces memory pressure during long gate waits.

An overlap guard prevents async callbacks from piling up if a poll takes longer than the interval.

```typescript
const poll = async () => {
  if (polling || cancelled) return;
  polling = true;
  // ... state poll, event fetch, elapsed update ...
  polling = false;
  const delay = lastGateStatus.current === "pending" ? 5000 : 500;
  timer = setTimeout(poll, delay);
};
```

State comparison checks `status`, `stages` (JSON stringified), and `gate?.status` to avoid unnecessary re-renders.

Events are polled incrementally using `lastEventId` as a cursor, keeping only the last 500 events in memory.

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

Two WASM modules contribute to memory growth during long runs: **yoga-layout** (Ink's layout engine) and **sql.js** (SQLite compiled to WASM). Both suffer from the same fundamental constraint: WASM linear memory (`WebAssembly.Memory`) can grow but never shrink. Freed allocations are reusable within the WASM heap, but the backing `ArrayBuffer` pages are never returned to V8. Over multi-hour runs this can accumulate to gigabytes.

### Render throttle (10 FPS)

Both `render()` calls pass `{ maxFps: 10 }` (Ink default is 30). This reduces yoga layout calculations by ~3x, proportionally slowing WASM memory growth.

### Static icon for gate stages

Human gate stages render a static `⏸` icon instead of an animated `<Spinner>`. The spinner's internal interval (~80ms) drives continuous Ink re-renders even when nothing is changing, accumulating yoga WASM memory. Eliminating the spinner during gate waits drops renders from ~12.5/sec to near zero (only when state actually changes).

### Adaptive poll interval (gate idle)

During gate waits the dashboard slows its poll interval from 500ms to 5s (see [Polling and Update Strategy](#polling-and-update-strategy)). This reduces DB operations, object allocations, and React re-renders by ~10x during the idle period.

### Periodic remount (15 minutes, yoga)

The inline dashboard (`startDashboard`) unmounts and remounts the Ink app every 15 minutes. Unmounting calls `freeRecursive()` on the root yoga tree and releases the entire React fiber tree. On remount:

- **Elapsed timer** is preserved via the `startTime` prop
- **Stage state** and **event log** repopulate from SQLite on the next poll
- **Agent activity** repopulates from the activity bus within ~100ms

```typescript
const RECYCLE_INTERVAL_MS = 15 * 60 * 1000;

const recycleTimer = setInterval(() => {
  instance.unmount();
  instance = mount();  // fresh React tree + fresh yoga nodes
}, RECYCLE_INTERVAL_MS);
```

### Centralized WASM reclaim (DbService, sql.js)

Cross-process readers (standalone dashboard, gate-notifier, MCP server) call `db.reload()` on every poll cycle, which creates a new `sql.Database` from disk. Each allocation grows the sql.js WASM heap. The `DbService` (`src/db-service.ts`) centralises this: in `"reader"` mode it reloads on every `.db()` call and runs a periodic `reclaimWasmMemory()` timer (default 15 minutes). This closes all cached `CccpDatabase` instances, clears the singleton cache, and sets the sql.js WASM module reference to `null`, dropping all references so V8 can GC the backing `ArrayBuffer`. The next `openDatabase()` call lazily re-initialises a fresh module with minimal memory.

```typescript
// db-service.ts
export class DbService {
  start(): void {
    // reader mode: periodic reclaimWasmMemory() on unref'd timer
  }
  async db(): Promise<CccpDatabase> {
    // reader mode: reload from disk before returning handle
  }
  stop(): void {
    // clear timer + final reclaimWasmMemory()
  }
}
```

The standalone dashboard creates a `DbService` at launch and stops it on completion. The MCP server creates one at startup and passes it to the `GateNotifier`. The inline dashboard (used by `cccp run` and `cccp resume`) does not need a `DbService` — it reads from the in-process singleton without reloading.

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
| `newSplit(direction, fromSurface?)` | `cmux new-split <right\|down> [--surface <ref>]` | Open a split pane (parses `OK surface:N workspace:M` → returns `surface:N`). Optional `fromSurface` splits from a specific pane instead of the current one. |
| `closeSurface(surfaceRef)` | `cmux close-surface --surface <ref>` | Close a split pane |
| `sendText(surfaceId, text)` | `cmux send --surface <id> <text>` | Send text to a split pane |
| `sendKey(surfaceId, key)` | `cmux send-key --surface <id> <key>` | Send a keystroke to a split pane |

### CLI command resolution

The `getCccpCliPrefix()` helper (`src/tui/cmux.ts`) resolves the correct CLI command for spawning cccp subcommands in external shells (cmux panes). When running in dev mode (entry point is `src/cli.ts` via tsx), it returns `npx --yes tsx <project-root>/src/cli.ts`; otherwise `npx --yes @alevental/cccp@latest`. This ensures pane commands work both in development and when running the published package.

Used by `launchScopedDashboard()` and `AgentPaneManager.openPane()`.

### Pipeline-level helpers

| Function | When Called |
|----------|-----------|
| `updatePipelineStatus(name, index, total)` | Each stage start -- updates status pill and progress bar |
| `notifyGateRequired(stageName)` | Gate enters pending state |
| `notifyPipelineComplete(name, status)` | Pipeline finishes |
| `launchScopedDashboard(runId, projectDir, scopeStage)` | Sub-pipeline stage start (depth-1 only) -- opens a split pane below with a scoped dashboard |

### Sub-pipeline split pane dashboard

When a `type: pipeline` stage starts inside a cmux workspace, the runner automatically opens a split pane below and launches a scoped dashboard (`cccp dashboard --scope <stage>`). This gives the sub-pipeline its own full dashboard experience (stages, agent activity, detail log) instead of just the inline `├─` rendering in the parent.

**How it works:**

1. `launchScopedDashboard()` calls `newSplit("down")` to create a pane, returns `surface:N`
2. Sends `cccp dashboard -r <prefix> --scope <stage> ; cmux close-surface --surface surface:N` to the pane
3. The scoped dashboard loads the parent state, extracts `state.stages[scope].children` as the display state
4. When the sub-pipeline completes, the dashboard exits and the chained `close-surface` auto-closes the pane

**Constraints:**
- Only depth-1 sub-pipelines get splits (avoids pane explosion on deep nesting)
- Skipped when `--headless` is set or cmux is not available
- Fire-and-forget -- failures don't block pipeline execution

### Per-agent monitor panes

**Source files:**
- [`src/tui/agent-panes.ts`](../../src/tui/agent-panes.ts) -- `AgentPaneManager`
- [`src/tui/agent-monitor.tsx`](../../src/tui/agent-monitor.tsx) -- Ink TUI component
- [`src/dispatcher.ts`](../../src/dispatcher.ts) -- `PaneAwareDispatcher`

When running inside a cmux workspace (not `--headless`, not `--dry-run`), the runner wraps the default dispatcher with `PaneAwareDispatcher`. This decorator opens a cmux pane before each agent dispatch and closes it after the agent completes.

**Layout:** Panes stack vertically in a column to the right of the primary TUI:

```
Primary TUI                           │  Agent 1 monitor
                                      │─────────────────
                                      │  Agent 2 monitor
                                      │─────────────────
                                      │  Agent 3 monitor
```

**How it works:**

1. `AgentPaneManager` tracks active surface refs per agent and the most recently opened surface
2. Pane creation is serialised via a promise queue (`openQueue`) so parallel dispatches stack correctly instead of all splitting right
3. First active agent: `newSplit("right")` from the primary pane
4. Subsequent agents: `newSplit("down", lastSurface)` to stack below the previous agent
5. Each pane runs the CLI via `getCccpCliPrefix()` (resolves to dev-mode tsx or published package) + `agent-monitor --stream-log <path> ; cmux close-surface --surface <ref>`
6. When the agent completes, `PaneAwareDispatcher` also calls `closeSurface()` as a safety net
7. When all panes close, the next agent creates a fresh split-right

**PaneAwareDispatcher:**

```typescript
class PaneAwareDispatcher implements AgentDispatcher {
  async dispatch(opts: DispatchOptions): Promise<AgentResult> {
    await this.panes.openPane(agentName, logPath);
    try {
      return await this.inner.dispatch(opts);
    } finally {
      this.panes.closePane(agentName);
    }
  }
}
```

Wired in `runPipeline()` — zero changes at individual dispatch call sites across runner.ts, pge.ts, ge.ts, loop.ts, and autoresearch.ts.

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
