import { describe, it, expect } from "vitest";
import { AutoApproveStrategy } from "../src/gate/auto-approve.js";
import {
  WebhookNotifier,
  ConsoleNotifier,
  CompositeNotifier,
  type PipelineEvent,
} from "../src/notifier.js";

// ---------------------------------------------------------------------------
// AutoApproveStrategy
// ---------------------------------------------------------------------------

describe("AutoApproveStrategy", () => {
  it("approves any gate immediately", async () => {
    const strategy = new AutoApproveStrategy();
    const response = await strategy.waitForGate({
      stageName: "test-gate",
      status: "pending",
      prompt: "Should we proceed?",
    });
    expect(response.approved).toBe(true);
  });

  it("approves gates without prompt", async () => {
    const strategy = new AutoApproveStrategy();
    const response = await strategy.waitForGate({
      stageName: "minimal",
      status: "pending",
    });
    expect(response.approved).toBe(true);
    expect(response.feedback).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ConsoleNotifier
// ---------------------------------------------------------------------------

describe("ConsoleNotifier", () => {
  it("does not throw on any event type", async () => {
    const notifier = new ConsoleNotifier();
    const events: PipelineEvent[] = [
      { type: "stage_start", pipeline: "test", project: "p", stageName: "s1" },
      { type: "stage_complete", pipeline: "test", project: "p", stageName: "s1", status: "passed" },
      { type: "gate_required", pipeline: "test", project: "p", stageName: "gate1" },
      { type: "pipeline_complete", pipeline: "test", project: "p", status: "passed" },
    ];

    for (const event of events) {
      await expect(notifier.notify(event)).resolves.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// CompositeNotifier
// ---------------------------------------------------------------------------

describe("CompositeNotifier", () => {
  it("sends to all child notifiers", async () => {
    const received: PipelineEvent[][] = [[], []];
    const notifiers = [0, 1].map(
      (i) =>
        ({
          notify: async (event: PipelineEvent) => {
            received[i].push(event);
          },
        }) as import("../src/notifier.js").Notifier,
    );

    const composite = new CompositeNotifier(notifiers);
    const event: PipelineEvent = {
      type: "pipeline_complete",
      pipeline: "test",
      project: "proj",
      status: "passed",
    };

    await composite.notify(event);

    expect(received[0]).toHaveLength(1);
    expect(received[1]).toHaveLength(1);
    expect(received[0][0].type).toBe("pipeline_complete");
  });
});

// ---------------------------------------------------------------------------
// WebhookNotifier (with mock fetch)
// ---------------------------------------------------------------------------

describe("WebhookNotifier", () => {
  it("does not throw when fetch fails", async () => {
    // Use a URL that will fail (no server listening).
    const notifier = new WebhookNotifier("http://localhost:1/nonexistent");
    const event: PipelineEvent = {
      type: "pipeline_complete",
      pipeline: "test",
      project: "proj",
      status: "passed",
    };

    // Should not throw — webhook failures are non-fatal.
    await expect(notifier.notify(event)).resolves.toBeUndefined();
  });
});
