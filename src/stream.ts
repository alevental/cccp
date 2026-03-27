import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Stream-JSON event types (from claude -p --output-format stream-json)
//
// Real format uses nested message.content[] arrays, not flat events.
// ---------------------------------------------------------------------------

export interface StreamEventBase {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

export type StreamEvent = StreamEventBase;

// ---------------------------------------------------------------------------
// Tool history entry
// ---------------------------------------------------------------------------

export interface ToolHistoryEntry {
  name: string;
  id: string;
  status: "active" | "done";
  /** Short summary of input (e.g., file path for Read). */
  summary?: string;
}

// ---------------------------------------------------------------------------
// Parsed activity for display
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// Stream event emitter
// ---------------------------------------------------------------------------

const MAX_TOOL_HISTORY = 10;

export class StreamParser extends EventEmitter {
  private logStream: WriteStream | null = null;
  private activity: AgentActivity;
  private buffer: string = "";
  /** Maps tool_use IDs to tool names (for matching tool_result events). */
  private toolIdToName: Map<string, string> = new Map();
  /** Tracks seen tool_use IDs to avoid double-counting from streaming. */
  private seenToolIds: Set<string> = new Set();

  constructor(agentName: string) {
    super();
    this.activity = {
      agent: agentName,
      model: "",
      lastText: "",
      lastThinking: "",
      activeTools: [],
      toolHistory: [],
      inputTokens: 0,
      outputTokens: 0,
      toolCallCount: 0,
      totalCostUsd: 0,
    };
  }

  /**
   * Start logging raw events to a JSONL file.
   */
  async startLog(logPath: string): Promise<void> {
    await mkdir(dirname(logPath), { recursive: true });
    this.logStream = createWriteStream(logPath, { flags: "a" });
  }

  /**
   * Feed a chunk of stdout data. Handles line buffering.
   */
  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer.
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.parseLine(trimmed);
    }
  }

  /**
   * Flush any remaining buffer content.
   */
  flush(): void {
    if (this.buffer.trim()) {
      this.parseLine(this.buffer.trim());
      this.buffer = "";
    }
    this.logStream?.end();
  }

  /**
   * Get current activity snapshot.
   */
  getActivity(): AgentActivity {
    return {
      ...this.activity,
      activeTools: [...this.activity.activeTools],
      toolHistory: [...this.activity.toolHistory],
    };
  }

  private parseLine(line: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      return;
    }

    // Log raw event.
    this.logStream?.write(line + "\n");

    this.processEvent(event);

    this.emit("event", event);
    this.emit("activity", this.getActivity());
  }

  private processEvent(event: StreamEvent): void {
    const type = event.type;
    const subtype = event.subtype as string | undefined;

    // --- system events ---
    if (type === "system") {
      if (subtype === "init") {
        this.activity.model = (event as any).model ?? "";
      } else if (subtype === "task_progress") {
        // Sub-agent activity
        const toolName = (event as any).last_tool_name;
        const desc = (event as any).description;
        if (toolName) {
          this.activity.lastText = `[sub-agent] ${toolName}: ${desc ?? ""}`.slice(-200);
        }
      }
      return;
    }

    // --- assistant events (nested message.content[] format) ---
    if (type === "assistant") {
      const message = (event as any).message;
      if (message?.content && Array.isArray(message.content)) {
        this.processContentBlocks(message.content);
        // Per-message usage (partial, during streaming)
        if (message.usage) {
          this.activity.inputTokens = message.usage.input_tokens ?? this.activity.inputTokens;
          this.activity.outputTokens = message.usage.output_tokens ?? this.activity.outputTokens;
        }
        return;
      }
      // Legacy flat format (for backward compat with tests)
      if (subtype === "text" && typeof (event as any).text === "string") {
        this.activity.lastText = ((event as any).text as string).slice(-200);
      } else if (subtype === "tool_use" && (event as any).name) {
        const name = (event as any).name as string;
        const id = (event as any).id as string;
        if (id && !this.seenToolIds.has(id)) {
          this.seenToolIds.add(id);
          this.toolIdToName.set(id, name);
          this.activity.activeTools.push(name);
          this.activity.toolCallCount++;
          this.addToolHistory(name, id, summarizeToolInput((event as any).input));
        }
      }
      return;
    }

    // --- user events (tool_result in message.content[]) ---
    if (type === "user") {
      const message = (event as any).message;
      if (message?.content && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const name = this.toolIdToName.get(block.tool_use_id);
            if (name) {
              this.activity.activeTools = this.activity.activeTools.filter(
                (t) => t !== name,
              );
              this.markToolDone(block.tool_use_id);
            }
          }
        }
      }
      // Legacy flat format
      if ((event as any).subtype === "tool_result" || type === "tool_result") {
        const name = (event as any).name as string | undefined;
        if (name) {
          this.activity.activeTools = this.activity.activeTools.filter(
            (t) => t !== name,
          );
        }
      }
      return;
    }

    // --- Legacy flat tool_result (backward compat) ---
    if (type === "tool_result") {
      const name = (event as any).name as string | undefined;
      if (name) {
        this.activity.activeTools = this.activity.activeTools.filter(
          (t) => t !== name,
        );
      }
      return;
    }

    // --- result event (final stats) ---
    if (type === "result") {
      const usage = (event as any).usage;
      if (usage) {
        if (usage.input_tokens != null) this.activity.inputTokens = usage.input_tokens;
        if (usage.output_tokens != null) this.activity.outputTokens = usage.output_tokens;
      }
      if ((event as any).total_cost_usd != null) {
        this.activity.totalCostUsd = (event as any).total_cost_usd;
      }
      return;
    }
  }

  private processContentBlocks(blocks: any[]): void {
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        this.activity.lastText = block.text.slice(-200);
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        this.activity.lastThinking = block.thinking.slice(-200);
      } else if (block.type === "tool_use" && block.name && block.id) {
        if (!this.seenToolIds.has(block.id)) {
          this.seenToolIds.add(block.id);
          this.toolIdToName.set(block.id, block.name);
          this.activity.activeTools.push(block.name);
          this.activity.toolCallCount++;
          this.addToolHistory(block.name, block.id, summarizeToolInput(block.input));
        }
      }
    }
  }

  private addToolHistory(name: string, id: string, summary?: string): void {
    this.activity.toolHistory.push({ name, id, status: "active", summary });
    if (this.activity.toolHistory.length > MAX_TOOL_HISTORY) {
      this.activity.toolHistory.shift();
    }
  }

  private markToolDone(id: string): void {
    const entry = this.activity.toolHistory.find((t) => t.id === id);
    if (entry) entry.status = "done";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a short summary from tool input (file path, pattern, etc.). */
function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;

  // Common patterns: file_path, path, pattern, command, query
  if (typeof obj.file_path === "string") return obj.file_path;
  if (typeof obj.path === "string") return obj.path;
  if (typeof obj.pattern === "string") return obj.pattern;
  if (typeof obj.command === "string") {
    const cmd = obj.command as string;
    return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  }
  if (typeof obj.query === "string") {
    const q = obj.query as string;
    return q.length > 60 ? q.slice(0, 57) + "..." : q;
  }
  if (typeof obj.prompt === "string") {
    const p = obj.prompt as string;
    return p.length > 60 ? p.slice(0, 57) + "..." : p;
  }
  return undefined;
}
