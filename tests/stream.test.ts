import { describe, it, expect, vi } from "vitest";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { StreamParser, type StreamEvent, type AgentActivity } from "../src/stream.js";

function tmpPath() {
  return join(tmpdir(), `cccp-test-${randomUUID()}`);
}

// ---------------------------------------------------------------------------
// StreamParser — legacy flat format (backward compat)
// ---------------------------------------------------------------------------

describe("StreamParser — legacy flat format", () => {
  it("parses a text event", () => {
    const parser = new StreamParser("test-agent");
    const events: StreamEvent[] = [];
    parser.on("event", (e: StreamEvent) => events.push(e));

    parser.feed('{"type":"assistant","subtype":"text","text":"Hello world"}\n');
    parser.flush();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
  });

  it("parses a tool_use event and updates activity", () => {
    const parser = new StreamParser("test-agent");
    const activities: AgentActivity[] = [];
    parser.on("activity", (a: AgentActivity) => activities.push(a));

    parser.feed(
      '{"type":"assistant","subtype":"tool_use","name":"Read","id":"t1"}\n',
    );
    parser.flush();

    expect(activities.length).toBeGreaterThan(0);
    const last = activities[activities.length - 1];
    expect(last.activeTools).toContain("Read");
    expect(last.toolCallCount).toBe(1);
  });

  it("removes tool from activeTools on tool_result", () => {
    const parser = new StreamParser("test-agent");

    parser.feed(
      '{"type":"assistant","subtype":"tool_use","name":"Read","id":"t1"}\n',
    );
    parser.feed('{"type":"tool_result","name":"Read","id":"t1"}\n');
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.activeTools).not.toContain("Read");
    expect(activity.toolCallCount).toBe(1);
  });

  it("tracks token usage from result event", () => {
    const parser = new StreamParser("test-agent");

    parser.feed(
      '{"type":"result","exit_code":0,"usage":{"input_tokens":1234,"output_tokens":567}}\n',
    );
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.inputTokens).toBe(1234);
    expect(activity.outputTokens).toBe(567);
  });

  it("handles multiple events in one chunk", () => {
    const parser = new StreamParser("test-agent");
    const events: StreamEvent[] = [];
    parser.on("event", (e: StreamEvent) => events.push(e));

    parser.feed(
      '{"type":"assistant","subtype":"text","text":"a"}\n' +
        '{"type":"assistant","subtype":"text","text":"b"}\n',
    );
    parser.flush();

    expect(events).toHaveLength(2);
  });

  it("handles chunked input (line split across feeds)", () => {
    const parser = new StreamParser("test-agent");
    const events: StreamEvent[] = [];
    parser.on("event", (e: StreamEvent) => events.push(e));

    parser.feed('{"type":"assistant","subtype":');
    parser.feed('"text","text":"split"}\n');
    parser.flush();

    expect(events).toHaveLength(1);
  });

  it("skips non-JSON lines", () => {
    const parser = new StreamParser("test-agent");
    const events: StreamEvent[] = [];
    parser.on("event", (e: StreamEvent) => events.push(e));

    parser.feed("not json\n");
    parser.feed('{"type":"result"}\n');
    parser.flush();

    expect(events).toHaveLength(1);
  });

  it("updates lastText with latest content", () => {
    const parser = new StreamParser("test-agent");

    parser.feed('{"type":"assistant","subtype":"text","text":"first"}\n');
    parser.feed('{"type":"assistant","subtype":"text","text":"second"}\n');
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.lastText).toBe("second");
  });

  it("sets agent name on activity", () => {
    const parser = new StreamParser("my-writer");
    const activity = parser.getActivity();
    expect(activity.agent).toBe("my-writer");
  });
});

// ---------------------------------------------------------------------------
// StreamParser — real nested format (from claude stream-json)
// ---------------------------------------------------------------------------

describe("StreamParser — real nested format", () => {
  it("parses assistant text from message.content[]", () => {
    const parser = new StreamParser("test-agent");

    parser.feed(JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [{ type: "text", text: "Hello from nested format" }],
      },
    }) + "\n");
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.lastText).toBe("Hello from nested format");
  });

  it("parses thinking blocks", () => {
    const parser = new StreamParser("test-agent");

    parser.feed(JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [{ type: "thinking", thinking: "Let me consider this carefully..." }],
      },
    }) + "\n");
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.lastThinking).toBe("Let me consider this carefully...");
  });

  it("parses tool_use from message.content[] and tracks in history", () => {
    const parser = new StreamParser("test-agent");

    parser.feed(JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [{
          type: "tool_use",
          name: "Read",
          id: "toolu_abc123",
          input: { file_path: "src/runner.ts" },
        }],
      },
    }) + "\n");
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.activeTools).toContain("Read");
    expect(activity.toolCallCount).toBe(1);
    expect(activity.toolHistory).toHaveLength(1);
    expect(activity.toolHistory[0].name).toBe("Read");
    expect(activity.toolHistory[0].id).toBe("toolu_abc123");
    expect(activity.toolHistory[0].status).toBe("active");
    expect(activity.toolHistory[0].summary).toBe("src/runner.ts");
  });

  it("clears tool on user/tool_result via ID lookup", () => {
    const parser = new StreamParser("test-agent");

    // Tool use
    parser.feed(JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [{ type: "tool_use", name: "Grep", id: "toolu_xyz", input: { pattern: "TODO" } }],
      },
    }) + "\n");

    // Tool result (no name, only tool_use_id)
    parser.feed(JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_xyz", content: "found 3 matches" }],
      },
    }) + "\n");
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.activeTools).not.toContain("Grep");
    expect(activity.toolHistory[0].status).toBe("done");
  });

  it("deduplicates tool_use IDs from streaming (same message repeated)", () => {
    const parser = new StreamParser("test-agent");

    const event = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [{ type: "tool_use", name: "Read", id: "toolu_dup", input: {} }],
      },
    }) + "\n";

    // Same event arrives twice (streaming duplicate)
    parser.feed(event);
    parser.feed(event);
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.toolCallCount).toBe(1);
    expect(activity.toolHistory).toHaveLength(1);
  });

  it("handles multiple content blocks in one message", () => {
    const parser = new StreamParser("test-agent");

    parser.feed(JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [
          { type: "thinking", thinking: "I should read the file first" },
          { type: "tool_use", name: "Read", id: "toolu_multi", input: { file_path: "package.json" } },
        ],
      },
    }) + "\n");
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.lastThinking).toContain("read the file first");
    expect(activity.activeTools).toContain("Read");
    expect(activity.toolHistory[0].summary).toBe("package.json");
  });

  it("captures model from system/init", () => {
    const parser = new StreamParser("test-agent");

    parser.feed(JSON.stringify({
      type: "system",
      subtype: "init",
      model: "claude-opus-4-6",
      tools: ["Read", "Write"],
    }) + "\n");
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.model).toBe("claude-opus-4-6");
  });

  it("captures cost from result event", () => {
    const parser = new StreamParser("test-agent");

    parser.feed(JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.0542,
      usage: { input_tokens: 5000, output_tokens: 1200 },
    }) + "\n");
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.totalCostUsd).toBe(0.0542);
    expect(activity.inputTokens).toBe(5000);
    expect(activity.outputTokens).toBe(1200);
  });

  it("tracks sub-agent progress from system/task_progress", () => {
    const parser = new StreamParser("test-agent");

    parser.feed(JSON.stringify({
      type: "system",
      subtype: "task_progress",
      last_tool_name: "Read",
      description: "Reading src/types.ts",
    }) + "\n");
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.lastText).toContain("[sub-agent]");
    expect(activity.lastText).toContain("Read");
  });

  it("captures per-message usage from assistant events", () => {
    const parser = new StreamParser("test-agent");

    parser.feed(JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }) + "\n");
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.inputTokens).toBe(100);
    expect(activity.outputTokens).toBe(50);
  });

  it("summarizes tool inputs for common patterns", () => {
    const parser = new StreamParser("test-agent");

    // Bash with command
    parser.feed(JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [{
          type: "tool_use", name: "Bash", id: "t1",
          input: { command: "npm test" },
        }],
      },
    }) + "\n");

    // Grep with pattern
    parser.feed(JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_2",
        content: [{
          type: "tool_use", name: "Grep", id: "t2",
          input: { pattern: "TODO" },
        }],
      },
    }) + "\n");
    parser.flush();

    const activity = parser.getActivity();
    expect(activity.toolHistory[0].summary).toBe("npm test");
    expect(activity.toolHistory[1].summary).toBe("TODO");
  });
});

// ---------------------------------------------------------------------------
// StreamParser — file logging
// ---------------------------------------------------------------------------

describe("StreamParser logging", () => {
  it("writes events to a JSONL log file", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const logPath = join(dir, "test.stream.jsonl");

    const parser = new StreamParser("test-agent");
    await parser.startLog(logPath);

    parser.feed('{"type":"assistant","subtype":"text","text":"logged"}\n');
    parser.feed('{"type":"result","exit_code":0}\n');
    parser.flush();

    await new Promise((r) => setTimeout(r, 50));

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("assistant");
    expect(first.text).toBe("logged");
  });
});
