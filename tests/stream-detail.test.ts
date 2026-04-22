import { describe, it, expect } from "vitest";
import { StreamDetailAccumulator } from "../src/stream/stream-detail.js";
import type {
  StreamEvent,
  SystemInitEvent,
  SystemTaskProgressEvent,
  AssistantEvent,
  UserEvent,
  ResultEvent,
} from "../src/stream/stream.js";

describe("StreamDetailAccumulator", () => {
  it("accumulates one entry per event (no recursion)", () => {
    const acc = new StreamDetailAccumulator();

    const systemInit: SystemInitEvent = {
      type: "system",
      subtype: "init",
      model: "claude-opus-4-7",
      tools: ["Read"],
    } as SystemInitEvent;
    acc.processEvent(systemInit);

    const progress: SystemTaskProgressEvent = {
      type: "system",
      subtype: "task_progress",
      description: "doing work",
    } as SystemTaskProgressEvent;
    acc.processEvent(progress);

    for (let i = 0; i < 5; i++) {
      const assistant: AssistantEvent = {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", id: `t${i}`, input: { file_path: `/x/${i}` } },
          ],
        },
      } as AssistantEvent;
      acc.processEvent(assistant);
    }

    for (let i = 0; i < 5; i++) {
      const user: UserEvent = {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: `t${i}`, content: "ok" },
          ],
        },
      } as UserEvent;
      acc.processEvent(user);
    }

    const result: ResultEvent = {
      type: "result",
      exit_code: 0,
      usage: { input_tokens: 10, output_tokens: 20 },
      total_cost_usd: 0.01,
    } as ResultEvent;
    acc.processEvent(result);

    // 1 init + 1 progress + 5 tool_call + 5 tool_result + 1 result = 13
    expect(acc.entries).toHaveLength(13);
    expect(acc.toolCallCount).toBe(5);
    expect(acc.done).toBe(true);
  });

  it("caps entries at MAX_ENTRIES", () => {
    const acc = new StreamDetailAccumulator();
    // Push 6000 text events via legacy assistant path.
    for (let i = 0; i < 6000; i++) {
      const e: AssistantEvent = {
        type: "assistant",
        subtype: "text",
        text: `msg ${i}`,
      } as unknown as AssistantEvent;
      acc.processEvent(e);
    }
    // Cap is 5000 — allow the implementation to drop oldest entries.
    expect(acc.entries.length).toBeLessThanOrEqual(5000);
    expect(acc.entries.length).toBeGreaterThan(4000);
  });
});
