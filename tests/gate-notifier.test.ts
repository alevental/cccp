import { describe, it, expect, vi, afterAll, afterEach, beforeEach } from "vitest";
import { closeDatabase } from "../src/db.js";
import { createState, saveState } from "../src/state.js";
import { GateNotifier } from "../src/mcp/gate-notifier.js";
import { tmpProjectDir, cleanupAll } from "./helpers.js";
import type { PipelineState } from "../src/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  await cleanupAll();
});

// ---------------------------------------------------------------------------
// Mock McpServer factory
// ---------------------------------------------------------------------------

interface MockElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

function createMockServer(elicitResult?: MockElicitResult | Error) {
  const elicitInput = vi.fn<[], Promise<MockElicitResult>>();

  if (elicitResult instanceof Error) {
    elicitInput.mockRejectedValue(elicitResult);
  } else if (elicitResult) {
    elicitInput.mockResolvedValue(elicitResult);
  } else {
    // Default: accept with approve
    elicitInput.mockResolvedValue({
      action: "accept",
      content: { decision: "approve" },
    });
  }

  return {
    mock: { server: { elicitInput } } as unknown as McpServer,
    elicitInput,
  };
}

// ---------------------------------------------------------------------------
// Helper: create a run with a pending gate
// ---------------------------------------------------------------------------

async function createRunWithGate(
  projectDir: string,
  stageName = "review",
  prompt = "Please approve this output.",
): Promise<PipelineState> {
  const state = createState("test-pipeline", "test-project", "test.yaml", [
    { name: "build", type: "agent" },
    { name: stageName, type: "human_gate" },
  ], `${projectDir}/artifacts`, projectDir);

  state.gate = {
    stageName,
    status: "pending",
    prompt,
  };

  await saveState(state);
  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GateNotifier", () => {
  let notifier: GateNotifier | undefined;

  afterEach(() => {
    notifier?.stop();
    notifier = undefined;
  });

  it("detects a pending gate and calls elicitInput", async () => {
    const projectDir = tmpProjectDir();
    await createRunWithGate(projectDir);

    const { mock, elicitInput } = createMockServer({
      action: "accept",
      content: { decision: "approve" },
    });

    notifier = new GateNotifier({
      server: mock,
      projectDir,
      pollIntervalMs: 50,
    });
    notifier.start();

    // Wait for the poll cycle + elicitation to complete.
    await vi.waitFor(() => {
      expect(elicitInput).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    // Verify the elicitation message includes the stage name.
    const call = elicitInput.mock.calls[0][0] as { message: string };
    expect(call.message).toContain("review");
    expect(call.message).toContain("Please approve this output.");

    closeDatabase(projectDir);
  });

  it("writes approval to state on accept with approve", async () => {
    const projectDir = tmpProjectDir();
    const state = await createRunWithGate(projectDir);

    const { mock, elicitInput } = createMockServer({
      action: "accept",
      content: { decision: "approve", feedback: "Looks great" },
    });

    notifier = new GateNotifier({
      server: mock,
      projectDir,
      pollIntervalMs: 50,
    });
    notifier.start();

    await vi.waitFor(() => {
      expect(elicitInput).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    // Wait a bit for the state write to complete.
    await new Promise((r) => setTimeout(r, 100));

    // Reload state and verify gate was approved.
    const { loadState } = await import("../src/state.js");
    const updated = await loadState(state.runId, projectDir, true);
    expect(updated?.gate?.status).toBe("approved");
    expect(updated?.gate?.feedback).toBe("Looks great");
    expect(updated?.gate?.respondedAt).toBeDefined();

    closeDatabase(projectDir);
  });

  it("writes rejection to state on accept with reject decision", async () => {
    const projectDir = tmpProjectDir();
    const state = await createRunWithGate(projectDir);

    const { mock, elicitInput } = createMockServer({
      action: "accept",
      content: { decision: "reject", feedback: "Needs more tests" },
    });

    notifier = new GateNotifier({
      server: mock,
      projectDir,
      pollIntervalMs: 50,
    });
    notifier.start();

    await vi.waitFor(() => {
      expect(elicitInput).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    await new Promise((r) => setTimeout(r, 100));

    const { loadState } = await import("../src/state.js");
    const updated = await loadState(state.runId, projectDir, true);
    expect(updated?.gate?.status).toBe("rejected");
    expect(updated?.gate?.feedback).toBe("Needs more tests");

    closeDatabase(projectDir);
  });

  it("writes rejection on decline action", async () => {
    const projectDir = tmpProjectDir();
    const state = await createRunWithGate(projectDir);

    const { mock, elicitInput } = createMockServer({
      action: "decline",
    });

    notifier = new GateNotifier({
      server: mock,
      projectDir,
      pollIntervalMs: 50,
    });
    notifier.start();

    await vi.waitFor(() => {
      expect(elicitInput).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    await new Promise((r) => setTimeout(r, 100));

    const { loadState } = await import("../src/state.js");
    const updated = await loadState(state.runId, projectDir, true);
    expect(updated?.gate?.status).toBe("rejected");

    closeDatabase(projectDir);
  });

  it("leaves gate pending on cancel and allows re-prompt", async () => {
    const projectDir = tmpProjectDir();
    const state = await createRunWithGate(projectDir);

    let callCount = 0;
    const elicitInput = vi.fn<[], Promise<MockElicitResult>>().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { action: "cancel" };
      return { action: "accept", content: { decision: "approve" } };
    });

    const mock = { server: { elicitInput } } as unknown as McpServer;

    notifier = new GateNotifier({
      server: mock,
      projectDir,
      pollIntervalMs: 50,
    });
    notifier.start();

    // Should be called twice: first cancel, then re-prompted.
    await vi.waitFor(() => {
      expect(elicitInput).toHaveBeenCalledTimes(2);
    }, { timeout: 3000 });

    await new Promise((r) => setTimeout(r, 100));

    const { loadState } = await import("../src/state.js");
    const updated = await loadState(state.runId, projectDir, true);
    expect(updated?.gate?.status).toBe("approved");

    closeDatabase(projectDir);
  });

  it("does not re-prompt for the same gate", async () => {
    const projectDir = tmpProjectDir();
    await createRunWithGate(projectDir);

    // Return accept but simulate the state already being resolved
    // by not writing to state (we'll verify only 1 elicitation call).
    const { mock, elicitInput } = createMockServer({
      action: "accept",
      content: { decision: "approve" },
    });

    notifier = new GateNotifier({
      server: mock,
      projectDir,
      pollIntervalMs: 50,
    });
    notifier.start();

    await vi.waitFor(() => {
      expect(elicitInput).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    // Wait for additional poll cycles — should not re-prompt.
    await new Promise((r) => setTimeout(r, 300));
    expect(elicitInput).toHaveBeenCalledTimes(1);

    closeDatabase(projectDir);
  });

  it("disables elicitation on error and falls back silently", async () => {
    const projectDir = tmpProjectDir();
    await createRunWithGate(projectDir);

    const { mock, elicitInput } = createMockServer(
      new Error("Client does not support elicitation"),
    );

    notifier = new GateNotifier({
      server: mock,
      projectDir,
      pollIntervalMs: 50,
    });
    notifier.start();

    await vi.waitFor(() => {
      expect(elicitInput).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    // Create another gate — should NOT trigger elicitation (disabled).
    const state2 = createState("pipeline-2", "proj-2", "p2.yaml", [
      { name: "gate2", type: "human_gate" },
    ], `${projectDir}/artifacts2`, projectDir);
    state2.gate = { stageName: "gate2", status: "pending" };
    await saveState(state2);

    // Wait for poll cycles — no new elicitation.
    await new Promise((r) => setTimeout(r, 300));
    expect(elicitInput).toHaveBeenCalledTimes(1);

    closeDatabase(projectDir);
  });

  it("handles gate resolved externally before elicitation response", async () => {
    const projectDir = tmpProjectDir();
    const state = await createRunWithGate(projectDir);

    // Simulate slow elicitation — resolve gate externally while waiting.
    const elicitInput = vi.fn<[], Promise<MockElicitResult>>().mockImplementation(async () => {
      // Simulate the gate being resolved externally while we wait.
      const { loadState: ls, saveState: ss } = await import("../src/state.js");
      const fresh = await ls(state.runId, projectDir, true);
      if (fresh?.gate) {
        fresh.gate.status = "approved";
        fresh.gate.respondedAt = new Date().toISOString();
        await ss(fresh);
      }

      // Then return elicitation result (should be discarded).
      return { action: "accept", content: { decision: "reject" } };
    });

    const mock = { server: { elicitInput } } as unknown as McpServer;

    notifier = new GateNotifier({
      server: mock,
      projectDir,
      pollIntervalMs: 50,
    });
    notifier.start();

    await vi.waitFor(() => {
      expect(elicitInput).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    await new Promise((r) => setTimeout(r, 100));

    // Gate should remain approved (not overwritten by the reject).
    const { loadState } = await import("../src/state.js");
    const updated = await loadState(state.runId, projectDir, true);
    expect(updated?.gate?.status).toBe("approved");

    closeDatabase(projectDir);
  });
});
