# Agent Dispatch

Agent dispatch is the mechanism by which CCCP executes Claude Code as a subprocess. Every agent stage and every planner/generator/evaluator in a PGE cycle (or contract/generator/evaluator in a GE cycle) goes through the same dispatch path.

**Source files:**
- [`src/agent.ts`](../../src/agent.ts) -- `dispatchAgent()` and `buildArgs()`
- [`src/prompt.ts`](../../src/prompt.ts) -- system prompt file and task context assembly
- [`src/stream/stream.ts`](../../src/stream/stream.ts) -- stdout stream parsing
- [`src/mcp/mcp-config.ts`](../../src/mcp/mcp-config.ts) -- MCP config file generation
- [`src/dispatcher.ts`](../../src/dispatcher.ts) -- AgentDispatcher interface for dependency injection

## Dispatch Flow

```
Pipeline Stage
      |
      v
  resolveAgent()          -- find agent markdown on disk
      |
      v
  loadAgentMarkdown()     -- read + concatenate base + operation
      |
      v
  writeSystemPromptFile() -- write to temp file
      |
      v
  writeMcpConfigFile()    -- resolve MCP profile, write temp JSON
      |
      v
  buildTaskContext()       -- assemble user prompt from stage config
      |
      v
  dispatchAgent()         -- spawn `claude` subprocess
      |
      +---> StreamParser  -- parse stdout for activity tracking
      |
      v
  AgentResult             -- exit code, output check, duration, summary
```

## Claude CLI Arguments

The `buildArgs()` function in `src/agent.ts` constructs the argument list:

```typescript
function buildArgs(opts: DispatchOptions): string[] {
  const args: string[] = [
    "-p", opts.userPrompt,
    "--append-system-prompt-file", opts.systemPromptFile,
    "--output-format", "stream-json",
    "--verbose",
  ];

  if (opts.mcpConfigFile) {
    args.push("--mcp-config", opts.mcpConfigFile);
    args.push("--strict-mcp-config");
  }

  if (opts.allowedTools?.length) {
    args.push("--tools", opts.allowedTools.join(","));
  }

  const mode = opts.permissionMode ?? "bypassPermissions";
  args.push("--permission-mode", mode);

  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.effort) {
    args.push("--effort", opts.effort);
  }

  return args;
}
```

### Key flags explained

| Flag | Value | Purpose |
|------|-------|---------|
| `-p` | User prompt (task context) | The task instructions, contract path, output path, etc. |
| `--append-system-prompt-file` | Temp file path | Agent markdown appended to the project's CLAUDE.md |
| `--output-format` | `stream-json` | Enables real-time JSONL streaming of events |
| `--verbose` | (flag) | Includes additional detail in stream output |
| `--mcp-config` | Temp JSON path | MCP server configuration for this agent |
| `--strict-mcp-config` | (flag) | Agent ONLY gets servers in its MCP config |
| `--tools` | Comma-separated list | Restricts which built-in tools the agent can use (MCP tools are controlled by `--mcp-config`) |
| `--permission-mode` | `bypassPermissions` | Agents run non-interactively (default) |
| `--model` | Model alias or name | Override model for this dispatch (optional) |
| `--effort` | `low`/`medium`/`high`/`xhigh`/`max` | Override effort level for this dispatch (optional) |

### Why `--append-system-prompt-file` (not `--system-prompt-file`)

Using `--append-system-prompt-file` means the project's `CLAUDE.md` is still loaded as the base system prompt. The agent markdown is appended, giving agents access to project-level context, conventions, and rules.

### Why `--strict-mcp-config`

Without `--strict-mcp-config`, the agent would inherit MCP servers from the project's `.mcp.json`. With it, the agent only sees the servers explicitly defined in its profile. This provides isolation between agents with different capabilities.

## DispatchOptions

The full options interface accepted by `dispatchAgent()`:

```typescript
export interface DispatchOptions {
  /** The user prompt (task context) passed via -p. */
  userPrompt: string;
  /** Path to the system prompt file (agent markdown). */
  systemPromptFile: string;
  /** Path to MCP config JSON file, if any. */
  mcpConfigFile?: string;
  /** Explicit list of allowed tools. */
  allowedTools?: string[];
  /** Expected output file path (to check existence after). */
  expectedOutput?: string;
  /** Working directory for the subprocess. */
  cwd: string;
  /** If true, print the command instead of running it. */
  dryRun?: boolean;
  /** Agent name (for stream logging). */
  agentName?: string;
  /** Directory for stream log files (.stream.jsonl). */
  streamLogDir?: string;
  /** Callback for stream activity updates. */
  onActivity?: (activity: AgentActivity) => void;
  /** Claude config directory (CLAUDE_CONFIG_DIR). */
  claudeConfigDir?: string;
  /** Permission mode for the agent subprocess. */
  permissionMode?: string;
  /** Suppress agent stderr (when TUI dashboard is rendering). */
  quiet?: boolean;
  /** Model override for this agent dispatch (--model flag). */
  model?: string;
  /** Effort level override for this agent dispatch (--effort flag). */
  effort?: string;
}
```

## Environment Variables

The subprocess inherits the parent process environment with one optional override:

```typescript
const env = { ...process.env };
if (opts.claudeConfigDir) {
  env.CLAUDE_CONFIG_DIR = opts.claudeConfigDir;
}
```

`CLAUDE_CONFIG_DIR` controls which Claude profile directory the agent uses. This determines authentication, settings, and permissions. Configured via `claude_config_dir` in `cccp.yaml`.

## Subprocess I/O

```typescript
const child = spawn("claude", args, {
  cwd: opts.cwd,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
```

| Stream | Handling |
|--------|----------|
| **stdin** | Ignored (agents are non-interactive) |
| **stdout** | Piped to `StreamParser.feed()` for real-time event processing |
| **stderr** | Piped to `process.stderr` (unless `quiet: true` for TUI mode) |

## Stream Parsing

Stdout from the `claude` subprocess produces JSONL (one JSON object per line) in the `stream-json` format. The `StreamParser` processes this to:

1. **Track activity:** Model name, token counts, active tools, cost
2. **Log raw events:** Write to `.stream.jsonl` files for later tailing
3. **Emit updates:** Via `onActivity` callback to the activity bus

See [Streaming Architecture](../architecture/streaming.md) for full details.

## Output Verification

After the subprocess exits, CCCP checks if the expected output file exists:

```typescript
let outputExists = false;
if (opts.expectedOutput) {
  try {
    await access(opts.expectedOutput);
    outputExists = true;
  } catch {
    outputExists = false;
  }
}
```

The caller (runner or PGE cycle) decides what to do with the result. For stages with a required `output`, a missing file throws `MissingOutputError`.

## AgentResult

```typescript
export interface AgentResult {
  /** Process exit code (0 = success). */
  exitCode: number;
  /** Path to the output file, if the agent was expected to produce one. */
  outputPath?: string;
  /** Whether the output file exists on disk after the agent finished. */
  outputExists: boolean;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Last task_progress description from the agent (narrative step summary). */
  summary?: string;
}
```

The `summary` field captures the last `task_progress` description from Claude Code's stream output. It is extracted from `AgentActivity.taskProgress` after the subprocess exits. The runner, PGE engine, and autoresearch cycle attach this to `_done` and `stage_complete` events, where the TUI detail log renders it as a dimmed line under completion entries.

## Dry Run Mode

When `dryRun: true`, the function prints the command without executing:

```
[dry-run] Would execute:
  claude -p "# Task\n\nResearch..." --append-system-prompt-file /tmp/cccp-agent-xxx.md --output-format stream-json --verbose --permission-mode bypassPermissions
  cwd: /Users/me/project
  CLAUDE_CONFIG_DIR: /Users/me/.claude-profile
  expected output: /Users/me/project/docs/research.md
```

Returns a synthetic success result with `exitCode: 0`.

## Stream Log Files

When `streamLogDir` is set (always set by the runner to `<artifact-dir>/.cccp/`), the parser writes raw events to a JSONL log file:

```
.cccp/
  researcher.stream.jsonl
  write-generator.stream.jsonl
  write-evaluator.stream.jsonl
```

The `agentName` determines the file name. For PGE stages, the runner sets names like `documentation-planner`, `documentation-contract`, `documentation-generator`, and `documentation-evaluator`. For GE stages (no planner), names are `documentation-contract`, `documentation-generator`, and `documentation-evaluator`.

## Activity Propagation

The dispatch function wires the `StreamParser`'s activity updates to the activity bus:

```typescript
// In src/runner.ts and src/pge.ts:
onActivity: (activity) => activityBus.emit("activity", activity),
```

This enables the TUI dashboard to show real-time tool usage, token counts, and thinking snippets.

## Error Handling

| Error | Condition | Thrown By |
|-------|-----------|-----------|
| `AgentCrashError` | Non-zero exit code | Runner/PGE after dispatch |
| `MissingOutputError` | Expected output file missing | Runner/PGE after dispatch |
| Spawn error | `claude` binary not found or not executable | `dispatchAgent()` |

## Dispatcher Interface

**File:** `src/dispatcher.ts`

The `AgentDispatcher` interface is the injection point for dispatch behavior. The `DefaultAgentDispatcher` calls `dispatchAgent()` directly. The `PaneAwareDispatcher` is a decorator that wraps any inner dispatcher with cmux pane management — opening a per-agent monitor pane before dispatch and closing it after.

```typescript
export interface AgentDispatcher {
  dispatch(opts: DispatchOptions): Promise<AgentResult>;
}
```

| Dispatcher | Purpose |
|-----------|---------|
| `DefaultAgentDispatcher` | Calls `dispatchAgent()` directly |
| `PaneAwareDispatcher` | Wraps inner dispatcher with cmux pane open/close lifecycle |

The `PaneAwareDispatcher` is wired in `runPipeline()` when cmux is available, not headless, and not dry-run. It delegates to `AgentPaneManager` for layout logic. Pane creation is serialised via a promise queue so parallel dispatches stack vertically instead of all splitting right. The pane command is resolved via `getCccpCliPrefix()` to work in both dev mode and published package contexts (see [TUI Dashboard — Per-agent monitor panes](../architecture/tui-dashboard.md#per-agent-monitor-panes)).

## Related Documentation

- [Agent Authoring](../guides/agent-authoring.md) -- writing agent markdown definitions
- [Streaming Architecture](../architecture/streaming.md) -- stream parsing details
- [Configuration](../api/configuration.md) -- `claude_config_dir`, `permission_mode`, MCP profiles
- [PGE Cycle](pge-cycle.md) -- how generators and evaluators are dispatched
