import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Stream-JSON event types (from claude -p --output-format stream-json)
// ---------------------------------------------------------------------------

export interface StreamEventBase {
  type: string;
  [key: string]: unknown;
}

export interface TextEvent extends StreamEventBase {
  type: "assistant";
  subtype: "text";
  text: string;
}

export interface ToolUseEvent extends StreamEventBase {
  type: "assistant";
  subtype: "tool_use";
  name: string;
  id: string;
  input?: unknown;
}

export interface ToolResultEvent extends StreamEventBase {
  type: "tool_result";
  name: string;
  id: string;
}

export interface ResultEvent extends StreamEventBase {
  type: "result";
  exit_code?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export type StreamEvent =
  | TextEvent
  | ToolUseEvent
  | ToolResultEvent
  | ResultEvent
  | StreamEventBase;

// ---------------------------------------------------------------------------
// Parsed activity for display
// ---------------------------------------------------------------------------

export interface AgentActivity {
  /** Agent name / stage name. */
  agent: string;
  /** Latest text snippet (last ~200 chars). */
  lastText: string;
  /** Tools currently being used. */
  activeTools: string[];
  /** Cumulative input tokens. */
  inputTokens: number;
  /** Cumulative output tokens. */
  outputTokens: number;
  /** Number of tool calls made. */
  toolCallCount: number;
}

// ---------------------------------------------------------------------------
// Stream event emitter
// ---------------------------------------------------------------------------

export class StreamParser extends EventEmitter {
  private logStream: WriteStream | null = null;
  private activity: AgentActivity;
  private buffer: string = "";

  constructor(agentName: string) {
    super();
    this.activity = {
      agent: agentName,
      lastText: "",
      activeTools: [],
      inputTokens: 0,
      outputTokens: 0,
      toolCallCount: 0,
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
    return { ...this.activity };
  }

  private parseLine(line: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      // Not JSON — skip silently.
      return;
    }

    // Log raw event.
    this.logStream?.write(line + "\n");

    // Update activity based on event type.
    if (event.type === "assistant" && (event as any).subtype === "text") {
      const text = (event as TextEvent).text;
      this.activity.lastText = text.slice(-200);
    } else if (
      event.type === "assistant" &&
      (event as any).subtype === "tool_use"
    ) {
      const tool = event as ToolUseEvent;
      this.activity.activeTools.push(tool.name);
      this.activity.toolCallCount++;
    } else if (event.type === "tool_result") {
      const result = event as ToolResultEvent;
      this.activity.activeTools = this.activity.activeTools.filter(
        (t) => t !== result.name,
      );
    } else if (event.type === "result") {
      const result = event as ResultEvent;
      if (result.usage) {
        this.activity.inputTokens += result.usage.input_tokens ?? 0;
        this.activity.outputTokens += result.usage.output_tokens ?? 0;
      }
    }

    this.emit("event", event);
    this.emit("activity", this.getActivity());
  }
}
