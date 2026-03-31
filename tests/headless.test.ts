import { describe, it, expect } from "vitest";
import { AutoApproveStrategy } from "../src/gate/auto-approve.js";

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
