import { describe, it, expect, vi } from "vitest";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { StreamParser, type StreamEvent, type AgentActivity } from "../src/stream.js";

function tmpPath() {
  return join(tmpdir(), `cccpr-test-${randomUUID()}`);
}

// ---------------------------------------------------------------------------
// StreamParser — event parsing
// ---------------------------------------------------------------------------

describe("StreamParser", () => {
  it("parses a text event", () => {
    const parser = new StreamParser("test-agent");
    const events: StreamEvent[] = [];
    parser.on("event", (e: StreamEvent) => events.push(e));

    parser.feed('{"type":"assistant","subtype":"text","text":"Hello world"}\n');
    parser.flush();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
    expect((events[0] as any).text).toBe("Hello world");
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

    // Split a JSON line in the middle.
    parser.feed('{"type":"assistant","subtype":');
    parser.feed('"text","text":"split"}\n');
    parser.flush();

    expect(events).toHaveLength(1);
    expect((events[0] as any).text).toBe("split");
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

    // Give the write stream a moment to flush.
    await new Promise((r) => setTimeout(r, 50));

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("assistant");
    expect(first.text).toBe("logged");
  });
});
