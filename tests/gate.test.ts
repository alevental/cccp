import { describe, it, expect, vi } from "vitest";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createState,
  saveState,
  loadState,
  statePath,
  type PipelineState,
  type GateInfo,
} from "../src/state.js";
import type { GateStrategy, GateResponse } from "../src/gate/gate-strategy.js";
import { FilesystemGateStrategy } from "../src/gate/gate-watcher.js";

function tmpPath() {
  return join(tmpdir(), `cccpr-test-${randomUUID()}`);
}

// ---------------------------------------------------------------------------
// Mock gate strategy (for unit testing)
// ---------------------------------------------------------------------------

class MockGateStrategy implements GateStrategy {
  private response: GateResponse;

  constructor(response: GateResponse) {
    this.response = response;
  }

  async waitForGate(_gate: GateInfo): Promise<GateResponse> {
    return this.response;
  }
}

describe("MockGateStrategy", () => {
  it("returns configured response", async () => {
    const strategy = new MockGateStrategy({ approved: true });
    const response = await strategy.waitForGate({
      stageName: "test",
      status: "pending",
    });
    expect(response.approved).toBe(true);
  });

  it("returns rejection with feedback", async () => {
    const strategy = new MockGateStrategy({
      approved: false,
      feedback: "Not ready yet",
    });
    const response = await strategy.waitForGate({
      stageName: "test",
      status: "pending",
    });
    expect(response.approved).toBe(false);
    expect(response.feedback).toBe("Not ready yet");
  });
});

// ---------------------------------------------------------------------------
// FilesystemGateStrategy
// ---------------------------------------------------------------------------

describe("FilesystemGateStrategy", () => {
  it("resolves when state.json gate is approved", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    // Create initial state with a pending gate.
    const state = createState("test", "proj", "t.yaml", [
      { name: "approval", type: "human_gate" },
    ]);
    state.gate = {
      stageName: "approval",
      status: "pending",
      prompt: "Please approve.",
    };
    await saveState(dir, state);

    const strategy = new FilesystemGateStrategy(dir);

    // Start waiting (async).
    const waitPromise = strategy.waitForGate(state.gate);

    // Simulate external approval after a short delay.
    setTimeout(async () => {
      const s = await loadState(dir);
      if (s?.gate) {
        s.gate.status = "approved";
        s.gate.respondedAt = new Date().toISOString();
        await saveState(dir, s);
      }
    }, 100);

    const response = await waitPromise;
    expect(response.approved).toBe(true);
  });

  it("resolves when state.json gate is rejected with feedback", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const state = createState("test", "proj", "t.yaml", [
      { name: "review", type: "human_gate" },
    ]);
    state.gate = {
      stageName: "review",
      status: "pending",
    };
    await saveState(dir, state);

    const strategy = new FilesystemGateStrategy(dir);
    const waitPromise = strategy.waitForGate(state.gate);

    setTimeout(async () => {
      const s = await loadState(dir);
      if (s?.gate) {
        s.gate.status = "rejected";
        s.gate.feedback = "Needs more work";
        await saveState(dir, s);
      }
    }, 100);

    const response = await waitPromise;
    expect(response.approved).toBe(false);
    expect(response.feedback).toBe("Needs more work");
  });
});

// ---------------------------------------------------------------------------
// Gate state management
// ---------------------------------------------------------------------------

describe("Gate state in pipeline state", () => {
  it("writes and reads gate info from state", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const state = createState("test", "proj", "t.yaml", [
      { name: "gate1", type: "human_gate" },
    ]);

    const gateInfo: GateInfo = {
      stageName: "gate1",
      status: "pending",
      prompt: "Approve the design?",
    };
    state.gate = gateInfo;
    await saveState(dir, state);

    const loaded = await loadState(dir);
    expect(loaded?.gate).toBeDefined();
    expect(loaded?.gate?.stageName).toBe("gate1");
    expect(loaded?.gate?.status).toBe("pending");
    expect(loaded?.gate?.prompt).toBe("Approve the design?");
  });

  it("clears gate after response", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const state = createState("test", "proj", "t.yaml", [
      { name: "gate1", type: "human_gate" },
    ]);
    state.gate = {
      stageName: "gate1",
      status: "approved",
      respondedAt: new Date().toISOString(),
    };
    await saveState(dir, state);

    // Clear gate.
    state.gate = undefined;
    await saveState(dir, state);

    const loaded = await loadState(dir);
    expect(loaded?.gate).toBeUndefined();
  });
});
