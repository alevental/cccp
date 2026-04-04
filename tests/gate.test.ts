import { describe, it, expect, vi } from "vitest";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { closeDatabase } from "../src/db.js";
import { createState, saveState, loadState } from "../src/state.js";
import type { PipelineState, GateInfo } from "../src/types.js";
import { FilesystemGateStrategy } from "../src/gate/gate-watcher.js";
import { tmpProjectDir, MockGateStrategy, mockRejectedGate } from "./helpers.js";

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

  it("returns rejection with feedbackPath", async () => {
    const strategy = new MockGateStrategy({
      approved: false,
      feedback: "Needs work",
      feedbackPath: "/tmp/feedback-1.md",
    });
    const response = await strategy.waitForGate({
      stageName: "test",
      status: "pending",
    });
    expect(response.approved).toBe(false);
    expect(response.feedback).toBe("Needs work");
    expect(response.feedbackPath).toBe("/tmp/feedback-1.md");
  });

  it("mockRejectedGate helper returns rejection with feedbackPath", async () => {
    const strategy = mockRejectedGate("Fix the intro", "/tmp/gate1-gate-feedback-1.md");
    const response = await strategy.waitForGate({
      stageName: "test",
      status: "pending",
    });
    expect(response.approved).toBe(false);
    expect(response.feedback).toBe("Fix the intro");
    expect(response.feedbackPath).toBe("/tmp/gate1-gate-feedback-1.md");
  });
});

// ---------------------------------------------------------------------------
// FilesystemGateStrategy
// ---------------------------------------------------------------------------

describe("FilesystemGateStrategy", { timeout: 10_000 }, () => {
  it("resolves when gate is approved", async () => {
    const projectDir = tmpProjectDir();
    const artifactDir = join(projectDir, "artifacts");

    const state = createState("test", "proj", "t.yaml", [
      { name: "approval", type: "human_gate" },
    ], artifactDir, projectDir);
    state.gate = {
      stageName: "approval",
      status: "pending",
      prompt: "Please approve.",
    };
    await saveState(state);

    const strategy = new FilesystemGateStrategy(state.runId, projectDir);
    const waitPromise = strategy.waitForGate(state.gate);

    setTimeout(async () => {
      const s = await loadState(state.runId, projectDir);
      if (s?.gate) {
        s.gate.status = "approved";
        s.gate.respondedAt = new Date().toISOString();
        await saveState(s);
      }
    }, 100);

    const response = await waitPromise;
    expect(response.approved).toBe(true);
    closeDatabase(projectDir);
  });

  it("resolves when gate is rejected with feedback", async () => {
    const projectDir = tmpProjectDir();
    const artifactDir = join(projectDir, "artifacts");

    const state = createState("test", "proj", "t.yaml", [
      { name: "review", type: "human_gate" },
    ], artifactDir, projectDir);
    state.gate = {
      stageName: "review",
      status: "pending",
    };
    await saveState(state);

    const strategy = new FilesystemGateStrategy(state.runId, projectDir);
    const waitPromise = strategy.waitForGate(state.gate);

    setTimeout(async () => {
      const s = await loadState(state.runId, projectDir);
      if (s?.gate) {
        s.gate.status = "rejected";
        s.gate.feedback = "Needs more work";
        await saveState(s);
      }
    }, 100);

    const response = await waitPromise;
    expect(response.approved).toBe(false);
    expect(response.feedback).toBe("Needs more work");
    closeDatabase(projectDir);
  });

  it("returns feedbackPath when present in gate state", async () => {
    const projectDir = tmpProjectDir();
    const artifactDir = join(projectDir, "artifacts");

    const state = createState("test", "proj", "t.yaml", [
      { name: "review", type: "human_gate" },
    ], artifactDir, projectDir);
    state.gate = { stageName: "review", status: "pending" };
    await saveState(state);

    const strategy = new FilesystemGateStrategy(state.runId, projectDir);
    const waitPromise = strategy.waitForGate(state.gate);

    setTimeout(async () => {
      const s = await loadState(state.runId, projectDir);
      if (s?.gate) {
        s.gate.status = "rejected";
        s.gate.feedback = "Fix the intro";
        s.gate.feedbackPath = "/tmp/feedback.md";
        await saveState(s);
      }
    }, 100);

    const response = await waitPromise;
    expect(response.approved).toBe(false);
    expect(response.feedback).toBe("Fix the intro");
    expect(response.feedbackPath).toBe("/tmp/feedback.md");
    closeDatabase(projectDir);
  });

  it("returns feedbackPath on approved gate", async () => {
    const projectDir = tmpProjectDir();
    const artifactDir = join(projectDir, "artifacts");

    const state = createState("test", "proj", "t.yaml", [
      { name: "check", type: "human_gate" },
    ], artifactDir, projectDir);
    state.gate = { stageName: "check", status: "pending" };
    await saveState(state);

    const strategy = new FilesystemGateStrategy(state.runId, projectDir);
    const waitPromise = strategy.waitForGate(state.gate);

    setTimeout(async () => {
      const s = await loadState(state.runId, projectDir);
      if (s?.gate) {
        s.gate.status = "approved";
        s.gate.feedback = "Minor nits only";
        s.gate.feedbackPath = "/tmp/approved-feedback.md";
        await saveState(s);
      }
    }, 100);

    const response = await waitPromise;
    expect(response.approved).toBe(true);
    expect(response.feedbackPath).toBe("/tmp/approved-feedback.md");
    closeDatabase(projectDir);
  });
});

// ---------------------------------------------------------------------------
// Gate state management
// ---------------------------------------------------------------------------

describe("Gate state in pipeline state", () => {
  it("writes and reads gate info from state", async () => {
    const projectDir = tmpProjectDir();
    const artifactDir = join(projectDir, "artifacts");

    const state = createState("test", "proj", "t.yaml", [
      { name: "gate1", type: "human_gate" },
    ], artifactDir, projectDir);

    const gateInfo: GateInfo = {
      stageName: "gate1",
      status: "pending",
      prompt: "Approve the design?",
    };
    state.gate = gateInfo;
    await saveState(state);

    const loaded = await loadState(state.runId, projectDir);
    expect(loaded?.gate).toBeDefined();
    expect(loaded?.gate?.stageName).toBe("gate1");
    expect(loaded?.gate?.status).toBe("pending");
    expect(loaded?.gate?.prompt).toBe("Approve the design?");
    closeDatabase(projectDir);
  });

  it("clears gate after response", async () => {
    const projectDir = tmpProjectDir();
    const artifactDir = join(projectDir, "artifacts");

    const state = createState("test", "proj", "t.yaml", [
      { name: "gate1", type: "human_gate" },
    ], artifactDir, projectDir);
    state.gate = {
      stageName: "gate1",
      status: "approved",
      respondedAt: new Date().toISOString(),
    };
    await saveState(state);

    state.gate = undefined;
    await saveState(state);

    const loaded = await loadState(state.runId, projectDir);
    expect(loaded?.gate).toBeUndefined();
    closeDatabase(projectDir);
  });

  it("persists feedbackPath through state save/load", async () => {
    const projectDir = tmpProjectDir();
    const artifactDir = join(projectDir, "artifacts");

    const state = createState("test", "proj", "t.yaml", [
      { name: "gate1", type: "human_gate" },
    ], artifactDir, projectDir);

    state.gate = {
      stageName: "gate1",
      status: "rejected",
      feedback: "Needs work",
      feedbackPath: "/tmp/gate1-gate-feedback-1.md",
      respondedAt: new Date().toISOString(),
    };
    await saveState(state);

    const loaded = await loadState(state.runId, projectDir);
    expect(loaded?.gate?.feedbackPath).toBe("/tmp/gate1-gate-feedback-1.md");
    expect(loaded?.gate?.feedback).toBe("Needs work");
    expect(loaded?.gate?.status).toBe("rejected");
    expect(loaded?.gate?.respondedAt).toBeDefined();
    closeDatabase(projectDir);
  });

  it("persists feedbackPath as undefined when not set", async () => {
    const projectDir = tmpProjectDir();
    const artifactDir = join(projectDir, "artifacts");

    const state = createState("test", "proj", "t.yaml", [
      { name: "gate1", type: "human_gate" },
    ], artifactDir, projectDir);

    state.gate = {
      stageName: "gate1",
      status: "rejected",
      feedback: "Rejected without artifact",
      respondedAt: new Date().toISOString(),
    };
    await saveState(state);

    const loaded = await loadState(state.runId, projectDir);
    expect(loaded?.gate?.feedback).toBe("Rejected without artifact");
    expect(loaded?.gate?.feedbackPath).toBeUndefined();
    closeDatabase(projectDir);
  });
});
