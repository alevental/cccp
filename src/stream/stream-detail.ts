import { watch, type FSWatcher } from "node:fs";
import { open } from "node:fs/promises";
import { EventEmitter } from "node:events";
import {
  StreamParser,
  type StreamEvent,
  type SystemInitEvent,
  type SystemTaskProgressEvent,
  type AssistantEvent,
  type UserEvent,
  type ResultEvent,
  type ToolUseBlock,
  type ToolResultBlock,
} from "./stream.js";
import {
  incTailerCount,
  decTailerCount,
  registerMonitorAccumulator,
} from "../diagnostics/runtime-registry.js";

// ---------------------------------------------------------------------------
// Monitor entry types — full-fidelity event log for the agent-monitor TUI
// ---------------------------------------------------------------------------

export interface TextEntry {
  type: "text";
  text: string;
  ts: number;
}

export interface ThinkingEntry {
  type: "thinking";
  text: string;
  ts: number;
}

export interface ToolCallEntry {
  type: "tool_call";
  name: string;
  id: string;
  summary?: string;
  input?: Record<string, unknown>;
  ts: number;
}

export interface ToolResultEntry {
  type: "tool_result";
  name: string;
  id: string;
  ts: number;
}

export interface TaskProgressEntry {
  type: "task_progress";
  description: string;
  toolName?: string;
  ts: number;
}

export interface SystemInitEntry {
  type: "system_init";
  model: string;
  tools?: string[];
  ts: number;
}

export interface ResultEntry {
  type: "result";
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  exitCode?: number;
  ts: number;
}

export type MonitorEntry =
  | TextEntry
  | ThinkingEntry
  | ToolCallEntry
  | ToolResultEntry
  | TaskProgressEntry
  | SystemInitEntry
  | ResultEntry;

// ---------------------------------------------------------------------------
// StreamDetailAccumulator — builds chronological entry list from raw events
// ---------------------------------------------------------------------------

/**
 * Cap for in-memory entries kept by the agent-monitor TUI. Agents with
 * verbose thinking / many tool calls can otherwise accumulate unbounded
 * entries over long dispatches. When exceeded, oldest entries are dropped.
 */
const MAX_ENTRIES = 5000;

export class StreamDetailAccumulator {
  readonly entries: MonitorEntry[] = [];
  /** Maps tool_use IDs to tool names. */
  private toolIdToName = new Map<string, string>();
  model = "";
  inputTokens = 0;
  outputTokens = 0;
  totalCostUsd = 0;
  toolCallCount = 0;
  done = false;

  private pushEntry(entry: MonitorEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  processEvent(event: StreamEvent): void {
    const ts = Date.now();

    if (event.type === "system") {
      if (event.subtype === "init") {
        const e = event as SystemInitEvent;
        this.model = e.model ?? "";
        this.pushEntry({
          type: "system_init",
          model: this.model,
          tools: e.tools,
          ts,
        });
      } else if (event.subtype === "task_progress") {
        const e = event as SystemTaskProgressEvent;
        if (e.description) {
          this.pushEntry({
            type: "task_progress",
            description: e.description,
            toolName: e.last_tool_name,
            ts,
          });
        }
      }
      return;
    }

    if (event.type === "assistant") {
      const e = event as AssistantEvent;
      const msg = e.message;
      if (msg?.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            this.pushEntry({ type: "text", text: block.text, ts });
          } else if (block.type === "thinking" && block.thinking) {
            this.pushEntry({ type: "thinking", text: block.thinking, ts });
          } else if (block.type === "tool_use") {
            const tb = block as ToolUseBlock;
            this.toolIdToName.set(tb.id, tb.name);
            this.toolCallCount++;
            this.pushEntry({
              type: "tool_call",
              name: tb.name,
              id: tb.id,
              summary: summarizeInput(tb.input),
              input: tb.input,
              ts,
            });
          }
        }
        if (msg.usage) {
          this.inputTokens = msg.usage.input_tokens ?? this.inputTokens;
          this.outputTokens = msg.usage.output_tokens ?? this.outputTokens;
        }
      }
      // Legacy flat format
      if (e.subtype === "text" && typeof e.text === "string") {
        this.pushEntry({ type: "text", text: e.text, ts });
      } else if (e.subtype === "tool_use" && e.name) {
        const id = e.id ?? "";
        this.toolIdToName.set(id, e.name);
        this.toolCallCount++;
        this.pushEntry({
          type: "tool_call",
          name: e.name,
          id,
          summary: summarizeInput(e.input),
          input: e.input,
          ts,
        });
      }
      return;
    }

    if (event.type === "user") {
      const e = event as UserEvent;
      const msg = e.message;
      if (msg?.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            const tr = block as ToolResultBlock;
            const name = this.toolIdToName.get(tr.tool_use_id) ?? "?";
            this.pushEntry({
              type: "tool_result",
              name,
              id: tr.tool_use_id,
              ts,
            });
            // Free the lookup entry — no longer needed after result arrives.
            this.toolIdToName.delete(tr.tool_use_id);
          }
        }
      }
      return;
    }

    if (event.type === "result") {
      const e = event as ResultEvent;
      if (e.usage) {
        this.inputTokens = e.usage.input_tokens ?? this.inputTokens;
        this.outputTokens = e.usage.output_tokens ?? this.outputTokens;
      }
      this.totalCostUsd = e.total_cost_usd ?? this.totalCostUsd;
      this.pushEntry({
        type: "result",
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        totalCostUsd: this.totalCostUsd,
        exitCode: e.exit_code,
        ts,
      });
      this.done = true;
    }
  }
}

// ---------------------------------------------------------------------------
// SingleFileTailer — watches one .stream.jsonl and emits parsed events
// ---------------------------------------------------------------------------

export class SingleFileTailer extends EventEmitter {
  private parser: StreamParser;
  private accumulator = new StreamDetailAccumulator();
  private watcher: FSWatcher | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private offset = 0;
  private counted = false;
  private unregisterAccumulator: (() => void) | null = null;

  constructor(
    private filePath: string,
    agentName: string,
  ) {
    super();
    this.parser = new StreamParser(agentName);
    this.parser.on("event", (event: StreamEvent) => {
      this.accumulator.processEvent(event);
      this.emit("update", this.accumulator);
      if (this.accumulator.done) {
        this.emit("done");
      }
    });
    incTailerCount();
    this.counted = true;
    this.unregisterAccumulator = registerMonitorAccumulator(
      agentName,
      () => this.accumulator.entries.length,
    );
  }

  get detail(): StreamDetailAccumulator {
    return this.accumulator;
  }

  async start(): Promise<void> {
    // Initial read.
    await this.readNew();

    // Watch for changes.
    try {
      this.watcher = watch(this.filePath, () => {
        this.readNew().catch(() => {});
      });
    } catch {
      // File may not exist yet — poll only.
    }

    // Poll fallback (fs.watch can miss events).
    this.pollInterval = setInterval(() => this.readNew().catch(() => {}), 500);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.parser.flush();
    this.parser.removeAllListeners();
    this.removeAllListeners();
    if (this.counted) {
      decTailerCount();
      this.counted = false;
    }
    if (this.unregisterAccumulator) {
      this.unregisterAccumulator();
      this.unregisterAccumulator = null;
    }
  }

  private async readNew(): Promise<void> {
    let fh;
    try {
      fh = await open(this.filePath, "r");
    } catch {
      return; // File doesn't exist yet.
    }
    try {
      const stat = await fh.stat();
      if (stat.size <= this.offset) return;

      const buf = Buffer.alloc(stat.size - this.offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
      this.offset += bytesRead;

      if (bytesRead > 0) {
        this.parser.feed(buf.toString("utf-8", 0, bytesRead));
      }
    } finally {
      await fh.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  if (typeof obj.file_path === "string") return obj.file_path;
  if (typeof obj.path === "string") return obj.path;
  if (typeof obj.pattern === "string") return obj.pattern;
  if (typeof obj.command === "string") {
    const cmd = obj.command as string;
    return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
  }
  if (typeof obj.query === "string") {
    const q = obj.query as string;
    return q.length > 80 ? q.slice(0, 77) + "..." : q;
  }
  if (typeof obj.prompt === "string") {
    const p = obj.prompt as string;
    return p.length > 80 ? p.slice(0, 77) + "..." : p;
  }
  return undefined;
}
