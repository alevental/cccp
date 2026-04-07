# Streaming Architecture

CCCP parses the real-time output stream from `claude -p --output-format stream-json` to provide live agent activity tracking. This powers the TUI dashboard, stream logs, and activity bus.

**Source files:**
- [`src/stream/stream.ts`](../../src/stream/stream.ts) -- `StreamParser`, `StreamEvent` discriminated union, and `AgentActivity` types
- [`src/stream/stream-tail.ts`](../../src/stream/stream-tail.ts) -- `StreamTailer` for standalone dashboard
- [`src/activity-bus.ts`](../../src/activity-bus.ts) -- in-process event bus

## AgentActivity Interface

The core data structure representing an agent's current state, defined in `src/stream/stream.ts`:

```typescript
export interface AgentActivity {
  /** Agent name / stage name. */
  agent: string;
  /** Model name (from system/init event). */
  model: string;
  /** Latest text snippet (last ~200 chars). */
  lastText: string;
  /** Latest thinking snippet (last ~200 chars). */
  lastThinking: string;
  /** Tools currently being used. */
  activeTools: string[];
  /** Recent tool call history (last 10). */
  toolHistory: ToolHistoryEntry[];
  /** Cumulative input tokens. */
  inputTokens: number;
  /** Cumulative output tokens. */
  outputTokens: number;
  /** Number of tool calls made. */
  toolCallCount: number;
  /** Cumulative cost in USD. */
  totalCostUsd: number;
  /** Latest task_progress description (narrative step summary from sub-agents). */
  taskProgress: string;
}
```

Each `ToolHistoryEntry` tracks individual tool invocations:

```typescript
export interface ToolHistoryEntry {
  name: string;
  id: string;
  status: "active" | "done";
  /** Short summary of input (e.g., file path for Read). */
  summary?: string;
}
```

## StreamParser

**File:** `src/stream/stream.ts`

The `StreamParser` is an `EventEmitter` that processes the JSONL output from `claude --output-format stream-json`. It handles line buffering, JSON parsing, event classification, and activity state tracking.

### Construction and lifecycle

```typescript
const parser = new StreamParser("stage-name");

// Optional: log raw events to a JSONL file
await parser.startLog("/path/to/.cccp/agent.stream.jsonl");

// Feed stdout chunks as they arrive
child.stdout.on("data", (chunk) => parser.feed(chunk.toString()));

// On process exit, flush remaining buffer
parser.flush();
```

### Events emitted

- `"event"` -- every parsed JSON event from the stream
- `"activity"` -- the current `AgentActivity` snapshot (emitted after every event)

### Stream-JSON format handling

Claude's `stream-json` output uses a nested `message.content[]` format. The parser handles these event types:

#### `system` events

```json
{"type": "system", "subtype": "init", "model": "claude-sonnet-4-20250514"}
{"type": "system", "subtype": "task_progress", "last_tool_name": "Read", "description": "..."}
```

- `init`: Extracts the model name
- `task_progress`: Tracks sub-agent activity. The `description` field is stored in `AgentActivity.taskProgress` (separate from `lastText`, which is overwritten by all text events). At agent completion, `dispatchAgent()` returns this as `AgentResult.summary`, which is attached to `_done` and `stage_complete` events for display in the detail log.

#### `assistant` events (nested content blocks)

```json
{
  "type": "assistant",
  "message": {
    "content": [
      {"type": "text", "text": "Analyzing the code..."},
      {"type": "thinking", "thinking": "I need to check..."},
      {"type": "tool_use", "id": "toolu_01X...", "name": "Read", "input": {"file_path": "/foo.ts"}}
    ],
    "usage": {"input_tokens": 1234, "output_tokens": 567}
  }
}
```

The parser iterates over `message.content[]` blocks:
- `text` blocks update `lastText` (last 200 chars)
- `thinking` blocks update `lastThinking` (last 200 chars)
- `tool_use` blocks add to `activeTools`, increment `toolCallCount`, and add a `ToolHistoryEntry`

#### `user` events (tool results)

```json
{
  "type": "user",
  "message": {
    "content": [
      {"type": "tool_result", "tool_use_id": "toolu_01X..."}
    ]
  }
}
```

When a `tool_result` arrives, the parser:
1. Looks up the tool name from the `tool_use_id` mapping
2. Removes the tool from `activeTools`
3. Marks the `ToolHistoryEntry` as `"done"`

#### `result` events (final stats)

```json
{"type": "result", "usage": {"input_tokens": 5000, "output_tokens": 2000}, "total_cost_usd": 0.0423}
```

Updates final token counts and cost.

### Tool input summarization

The `summarizeToolInput()` helper extracts a short summary from tool input objects, checking for common patterns:

```typescript
// Priority order for summary extraction:
file_path  ->  "/src/agent.ts"
path       ->  "/Users/foo/project"
pattern    ->  "*.test.ts"
command    ->  "npm test" (truncated to 60 chars)
query      ->  "search terms" (truncated to 60 chars)
prompt     ->  "user prompt" (truncated to 60 chars)
```

### Tool tracking internals

The parser uses two data structures to avoid double-counting from streaming:

- `seenToolIds: Set<string>` -- prevents counting the same tool_use twice
- `toolIdToName: Map<string, string>` -- maps tool_use IDs to tool names for matching results

Tool history is capped at 10 entries (`MAX_TOOL_HISTORY = 10`), with the oldest entry shifted out when full.

### Stream logging

When `startLog()` is called, the parser writes every raw JSON line to a JSONL file:

```
.cccp/
  stage-name.stream.jsonl    # Raw stream events
```

These files are used by `StreamTailer` for standalone dashboard mode.

## Activity Bus

**File:** `src/activity-bus.ts`

A module-level singleton `EventEmitter` for passing agent activity updates from the runner to the TUI dashboard within the same process:

```typescript
export const activityBus = new EventEmitter();
```

**Publisher (agent dispatch in `src/agent.ts` and `src/pge.ts`):**
```typescript
onActivity: (activity) => activityBus.emit("activity", activity),
```

**Subscriber (dashboard in `src/tui/dashboard.tsx`):**
```typescript
activityBus.on("activity", handler);
```

The activity bus is only used when the dashboard is running inline (i.e., `cccp run` without `--headless`). In standalone dashboard mode (`cccp dashboard`), the `StreamTailer` is used instead.

## StreamTailer

**File:** `src/stream-tail.ts`

Used by the standalone `cccp dashboard` command to tail `.stream.jsonl` files written by a separate runner process.

### Architecture

```
Runner process                    Dashboard process
--------------                    -----------------
StreamParser ---> .stream.jsonl   StreamTailer ---> StreamParser ---> Dashboard
```

The `StreamTailer` extends `EventEmitter` and emits `"activity"` events.

### How it works

1. **Initial scan:** Reads all `.stream.jsonl` files in the `.cccp/` directory
2. **File watching:** Uses `fs.watch()` on the `.cccp/` directory
3. **Polling fallback:** Polls every 500ms (since `fs.watch` can miss events)
4. **Incremental reads:** Tracks byte offset per file, only reads new data

```typescript
const tailer = new StreamTailer(resolve(artifactDir, ".cccp"));
tailer.on("activity", (a: AgentActivity) => { /* update UI */ });
await tailer.start();
// Later:
tailer.stop();
```

### Per-file state

Each `.stream.jsonl` file gets its own `StreamParser` instance and byte offset:

```typescript
private parsers: Map<string, { parser: StreamParser; offset: number }> = new Map();
```

The agent name is derived from the filename: `stage-name.stream.jsonl` yields agent name `"stage-name"`.

### Incremental read strategy

On each poll/watch event:

1. Open the file for reading
2. `stat()` to get current size
3. If `size > offset`, read the delta: `Buffer.alloc(size - offset)`
4. Feed the new bytes to the file's `StreamParser`
5. Update the offset

This approach avoids re-reading the entire file on each tick.

## Data flow summary

```
claude subprocess stdout
         |
    StreamParser.feed()          -- line buffer, JSON parse
         |
    processEvent()               -- update AgentActivity state
         |
    +--- emit("event")           -- raw event
    +--- emit("activity")        -- AgentActivity snapshot
         |
    +--- activityBus.emit()      -- in-process (inline dashboard)
    +--- .stream.jsonl file      -- on-disk log
              |
         StreamTailer            -- cross-process (standalone dashboard)
              |
         emit("activity")        -- to Dashboard component
```

## Agent Monitor (per-agent detail view)

**Source files:**
- [`src/stream/stream-detail.ts`](../../src/stream/stream-detail.ts) -- `StreamDetailAccumulator` and `SingleFileTailer`
- [`src/tui/agent-monitor.tsx`](../../src/tui/agent-monitor.tsx) -- Ink TUI component

While `AgentActivity` provides a summarized snapshot (truncated text, capped tool history), the `StreamDetailAccumulator` builds a full-fidelity chronological list of `MonitorEntry` items with no truncation. This powers the `cccp agent-monitor` command and the automatic per-agent cmux panes.

### MonitorEntry types

```typescript
export type MonitorEntry =
  | TextEntry           // Full text block content
  | ThinkingEntry       // Full thinking block content
  | ToolCallEntry       // Tool name, ID, summary, full input object
  | ToolResultEntry     // Tool name, ID (completion marker)
  | TaskProgressEntry   // Sub-agent narrative description
  | SystemInitEntry     // Model name, available tools
  | ResultEntry         // Final tokens, cost, exit code
```

### SingleFileTailer

Unlike `StreamTailer` (which watches a directory of `.stream.jsonl` files), `SingleFileTailer` watches a single file. It uses the same strategy: `fs.watch()` + 500ms poll fallback, incremental byte-offset reads. It creates a `StreamParser` internally and listens to `"event"` emissions (raw `StreamEvent`, not just `AgentActivity`), feeding each event to a `StreamDetailAccumulator`.

Emits:
- `"update"` -- after each event is processed (passes the accumulator)
- `"done"` -- when a `result` event is received

### Data flow

```
.stream.jsonl file
       |
  SingleFileTailer (fs.watch + poll)
       |
  StreamParser.feed() → emit("event")
       |
  StreamDetailAccumulator.processEvent()
       |
  emit("update") → AgentMonitor component
```

## Related Documentation

- [TUI Dashboard](tui-dashboard.md) -- how the dashboard consumes activity updates
- [Agent Dispatch](../patterns/agent-dispatch.md) -- how `--output-format stream-json` is configured
