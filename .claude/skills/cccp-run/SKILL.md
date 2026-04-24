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

### `diag memory` — Post-mortem analyze a memory log

```bash
npx @alevental/cccp@latest diag memory [-f <path>] [-r <run-prefix>] [--since 30m] [--field rss] [--top 10]
```

Reads `{artifactDir}/.cccp/memory.jsonl` (written automatically by every run) and prints an ASCII sparkline plus a top-N table of counters ranked by growth — activity map size, dispatch map size, `activityBus` listeners, sql.js instances, stream tailers, state.json bytes, event count, RSS/heap/arrayBuffers. Run this after an OOM to see *which* counter grew monotonically and therefore which code path leaked.

| Flag | Default | Description |
|------|---------|-------------|
| `-f, --file <path>` | `./.cccp/memory.jsonl` | Override the JSONL path |
| `-p, --project <name>` + `--pipeline <name>` | — | Alternative to `-f`: resolve the path from project + pipeline names |
| `-r, --run <id-prefix>` | — | Filter to one run (prefix match) |
| `--since <dur>` | all | `10m`, `2h`, `1d` — only samples within the window ending at the latest sample |
| `--field <name>` | `rss` | Sparkline field: `rss | heapUsed | arrayBuffers | external` |
| `--top <n>` | `10` | Top-N counters by delta |
| `--width <cols>` | `60` | Sparkline width |

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

## Debugging memory / investigating OOM crashes

Long runs can leak or OOM. Five layered tools, each with zero cost when disabled.

### 1. Memory JSONL (always on)

Every run writes `{artifactDir}/.cccp/memory.jsonl` — one sample per poll tick (500ms in TUI, 5s headless) with memory, V8 heap spaces, growth rates, and runtime counters (activity map, dispatch map, eventHistory size + bytes, max event bytes, state bytes, activityBus listeners + emit count, stream tailers, monitor entries, active-handle counts, event loop utilization, `state.json` size, event count). Uses `appendFileSync` so samples land on disk even if the process OOM-crashes.

After a crash, analyse with `cccp diag memory` (see CLI section). Whichever counter grew monotonically identifies the leaking code path.

Disable with `CCCP_MEM_LOG=0`. Sample frequency for headless runs: `CCCP_MEM_SAMPLE_MS=5000`.

### 2. Heap snapshots (opt-in + on-demand keybind)

On-demand from the TUI: press **`[h]`** while the dashboard is visible to write `.cccp/heap-<runId>-<ts>-keybind.heapsnapshot`. Load in Chrome DevTools → Memory panel and compare two snapshots to find retainers.

Signal-driven: `kill -USR2 <pid>` from a shell writes the same snapshot (works even on headless runs; requires at least one of the env vars below to be set to enable the handler).

Automatic triggers (all default OFF):

| Env var | Effect |
|---------|--------|
| `CCCP_HEAP_SNAPSHOT_ON_RSS_MB=1800` | Auto-snapshot when RSS crosses 1.8GB (5-min rate limit) |
| `CCCP_HEAP_SNAPSHOT_ON_HEAP_MB=1200` | Same, for `heapUsed` |
| `CCCP_HEAP_SNAPSHOT_EVERY_MIN=60` | Periodic baseline for diff comparison |
| `CCCP_HEAP_SNAPSHOT_ON_CRASH=1` | Snapshot on `uncaughtException` / `unhandledRejection` |

Output path: `.cccp/heap-<runId>-<timestamp>-<reason>.heapsnapshot`.

### 3. Sampled profilers — CPU & heap allocation (opt-in)

Env-gated `node:inspector` profilers that run for the full lifetime of the pipeline. The **heap sampling profile** is the gold-standard tool for localising leaks: it captures the call stack at every sampled allocation, so the resulting flame graph shows *which code path produced the retained bytes* — useful when no single counter grows.

| Env var | Effect |
|---------|--------|
| `CCCP_PROFILE=heap` | Run `HeapProfiler.startSampling`; write `.cccp/heap-<ts>.heapprofile` on shutdown |
| `CCCP_PROFILE=cpu`  | Run `Profiler.start`; write `.cccp/cpu-<ts>.cpuprofile` on shutdown |
| `CCCP_PROFILE=cpu,heap` (or `all`) | Both |
| `CCCP_PROFILE_HEAP_INTERVAL_BYTES=32768` | Sampling interval (default 32KB). Smaller = more detail, more overhead. |

Load `.heapprofile` in Chrome DevTools → Memory → **Load profile**. Load `.cpuprofile` in DevTools → Performance → **Load profile**.

### 4. Force-GC keybind (in the TUI)

Press **`[g]`** to call `global.gc()` and see the reclaim delta. Only works when node was started with `--expose-gc` (e.g. `NODE_OPTIONS='--expose-gc' npx @alevental/cccp run ...`). Useful to distinguish **retention** (heap stays high after forced GC) from **GC lag** (heap drops sharply). When `--expose-gc` is missing, the keybind prints a hint.

### 5. Tag-gated debug logger (opt-in)

`CCCP_DEBUG=wasm,leak,stream` enables structured debug lines to `.cccp/debug.log` (10 MB rotation; `*` = all tags). Zero overhead when unset (single `Set.has()` check).

| Tag | Logs |
|-----|------|
| `wasm` | (legacy sql.js reclaim cycles — now a no-op after the v0.17 node:sqlite migration) |
| `leak` | Dashboard activity-map / dispatch-map cleanup — lists orphaned keys when prefix-match fails |
| `stream` | StreamTailer open/close |

Override rotation size with `CCCP_DEBUG_MAX_MB=10`.

### TUI memory view (`[m]`)

Press `m` in a running dashboard for the live memory view. Panels (all read from the runtime registry):

- **Header**: current + delta RSS/heap/external/arrayBuffers; 1-minute growth rates.
- **Sparklines**: RSS, heapUsed, arrayBuffers across the `MemorySampleRing` (600 samples).
- **V8 heap spaces**: per-space used/committed, sorted largest first.
- **In-process state**: events, activities, dispatches, samples.
- **Tracked leak suspects**: activityMap, dispatchMap, eventHistory, busListeners, streamTailers, monitorEntries — red when delta exceeds 2× or +500.
- **Data sizes**: eventHistoryBytes, maxEventBytes, stateBytes, V8 code/bytecode/external script source — red >500MB, yellow >50MB. *The fastest way to confirm that the leak lives inside event payloads or state snapshots.*
- **Object tracker**: WeakRef-based `live / created` counts per kind (`PipelineState`, `StateEvent`, `AgentActivity`, plus anything else registered via `trackObject`). A rising `live` number that doesn't plateau points directly at retention of that class.
- **Active handles**: counts by type (`Timeout`, `FSReqCallback`, `TCPSocketWrap`, …). Growing `Timeout` count means zombie `setInterval`s.
- **Runtime**: event loop utilization, `maxRSS` (kernel high-water), page faults (minor/major), context switches (vol/invol), `activityBus` monotonic emit count.

Keybind footer: `[p] pause · [m] events/memory · [g] force-gc · [h] heap snapshot`.

### Leak hunt workflow

1. Start the suspect run with `CCCP_PROFILE=heap NODE_OPTIONS='--expose-gc' npx @alevental/cccp@latest run ...`.
2. Periodically check the TUI memory view (`m`). Watch the **Data sizes** and **Object tracker** panels — they usually localise the leak within a few minutes.
3. If a specific kind's `live` is climbing: search for where that kind is stashed (a Map, Set, closure capture, listener) and cap / clear it.
4. If no tracked counter matches the heap growth: press **`[h]`** twice about five minutes apart. Open both `.heapsnapshot` files in DevTools → Memory and use **Comparison** mode to see which class grew most — that points at the retaining allocation.
5. Stop the run cleanly so the `.heapprofile` writes; load it in DevTools Memory → **Sampling profile**. The flame graph pins the allocation site.
6. For live tracing across runs: `CCCP_DEBUG=leak npx @alevental/cccp@latest run ...` → tail `.cccp/debug.log`.
