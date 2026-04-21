import { describe, it, expect, vi } from "vitest";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { closeDatabase } from "../src/db.js";
import { createState, saveState, loadState } from "../src/state.js";
import type { AgentResult, PipelineState, GateInfo, Pipeline, RunContext } from "../src/types.js";
import type { AgentDispatcher, DispatchOptions } from "../src/dispatcher.js";
import type { GateResponse, GateStrategy } from "../src/gate/gate-strategy.js";
import { FilesystemGateStrategy } from "../src/gate/gate-watcher.js";
import { SilentLogger } from "../src/logger.js";
import { TempFileTracker } from "../src/temp-tracker.js";
import { loadPipeline } from "../src/pipeline.js";
import { runPipeline } from "../src/runner.js";
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

// ---------------------------------------------------------------------------
// Runner-level tests for agent_gate and pipeline_handoff
// ---------------------------------------------------------------------------

/** Gate strategy that polls state at 50ms intervals — faster than Filesystem. */
class FastPollGateStrategy implements GateStrategy {
  constructor(private runId: string, private projectDir: string) {}
  async waitForGate(_gate: GateInfo): Promise<GateResponse> {
    return new Promise((res, rej) => {
      const timeout = setTimeout(() => {
        clearInterval(interval);
        rej(new Error("FastPollGateStrategy timeout"));
      }, 10_000);
      const interval = setInterval(async () => {
        const s = await loadState(this.runId, this.projectDir, true);
        if (s?.gate && s.gate.status !== "pending") {
          clearTimeout(timeout);
          clearInterval(interval);
          res({
            approved: s.gate.status === "approved",
            feedback: s.gate.feedback,
            feedbackPath: s.gate.feedbackPath,
          });
        }
      }, 50);
    });
  }
}

/** Gate strategy that captures the GateInfo it was called with (so the test
 *  can assert on kind/prompt/etc.) and returns a pre-configured response. */
class CapturingGateStrategy implements GateStrategy {
  captured?: GateInfo;
  constructor(private response: GateResponse) {}
  async waitForGate(gate: GateInfo): Promise<GateResponse> {
    this.captured = gate;
    return this.response;
  }
}

class ScriptedDispatcher implements AgentDispatcher {
  private handlers: Array<(opts: DispatchOptions) => Promise<AgentResult>>;
  private callIndex = 0;
  calls: DispatchOptions[] = [];

  constructor(handlers: Array<(opts: DispatchOptions) => Promise<AgentResult>>) {
    this.handlers = handlers;
  }

  async dispatch(opts: DispatchOptions): Promise<AgentResult> {
    this.calls.push(opts);
    const handler = this.handlers[this.callIndex++];
    if (!handler) throw new Error(`Unexpected dispatch call #${this.callIndex}`);
    return handler(opts);
  }
}

async function writeAgent(dir: string, name: string): Promise<string> {
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, name), `# ${name}\nTest agent.`, "utf-8");
  return `agents/${name}`;
}

async function writePipelineFile(dir: string, yaml: string): Promise<Pipeline> {
  const file = join(dir, "pipeline.yaml");
  await writeFile(file, yaml, "utf-8");
  return loadPipeline(file);
}

function buildCtx(opts: {
  projectDir: string;
  pipeline: Pipeline;
  dispatcher?: AgentDispatcher;
  headless?: boolean;
  gateStrategy?: GateStrategy;
}): RunContext {
  const artifactDir = join(opts.projectDir, "artifacts");
  return {
    project: "test-project",
    projectDir: opts.projectDir,
    artifactDir,
    pipelineFile: join(opts.projectDir, "pipeline.yaml"),
    pipeline: opts.pipeline,
    dryRun: false,
    variables: {
      project: "test-project",
      project_dir: opts.projectDir,
      artifact_dir: artifactDir,
      pipeline_name: opts.pipeline.name,
    },
    agentSearchPaths: [join(opts.projectDir, "agents")],
    quiet: true,
    logger: new SilentLogger(),
    dispatcher: opts.dispatcher,
    tempTracker: new TempFileTracker(),
    headless: opts.headless,
    gateStrategy: opts.gateStrategy,
  };
}

describe("agent_gate runner execution", { timeout: 10_000 }, () => {
  it("publishes gate with kind: agent_eval and passes on approval", async () => {
    const dir = tmpProjectDir();

    const pipeline = await writePipelineFile(dir, `
name: agent-gate-pass
stages:
  - name: review-gate
    type: agent_gate
    prompt: Is the draft ready?
    artifacts: [artifacts/draft.md]
`);

    const state = createState(pipeline.name, "test-project", join(dir, "pipeline.yaml"), [
      { name: "review-gate", type: "agent_gate" },
    ], join(dir, "artifacts"), dir);
    await saveState(state);

    const strategy = new CapturingGateStrategy({ approved: true });
    const ctx = buildCtx({ projectDir: dir, pipeline, gateStrategy: strategy });
    const result = await runPipeline(ctx, { existingState: state });

    expect(result.status).toBe("passed");
    expect(result.stages[0].status).toBe("passed");
    // The runner must publish the gate with kind=agent_eval so the
    // notifier knows to instruct the session to decide autonomously.
    expect(strategy.captured?.kind).toBe("agent_eval");
    expect(strategy.captured?.prompt).toBe("Is the draft ready?");
    expect(strategy.captured?.stageName).toBe("review-gate");
    closeDatabase(dir);
  });

  it("fails on rejection with feedback", async () => {
    const dir = tmpProjectDir();

    const pipeline = await writePipelineFile(dir, `
name: agent-gate-fail
stages:
  - name: review-gate
    type: agent_gate
`);

    const state = createState(pipeline.name, "test-project", join(dir, "pipeline.yaml"), [
      { name: "review-gate", type: "agent_gate" },
    ], join(dir, "artifacts"), dir);
    await saveState(state);

    const strategy = new CapturingGateStrategy({
      approved: false,
      feedback: "Coverage is insufficient",
    });
    const ctx = buildCtx({ projectDir: dir, pipeline, gateStrategy: strategy });
    const result = await runPipeline(ctx, { existingState: state });

    expect(result.status).toBe("failed");
    const stage = result.stages[0];
    expect(stage.status).toBe("failed");
    expect(stage.error).toContain("Coverage is insufficient");
    closeDatabase(dir);
  });

  it("headless mode auto-approves", async () => {
    const dir = tmpProjectDir();

    const pipeline = await writePipelineFile(dir, `
name: agent-gate-headless
stages:
  - name: review-gate
    type: agent_gate
`);

    const state = createState(pipeline.name, "test-project", join(dir, "pipeline.yaml"), [
      { name: "review-gate", type: "agent_gate" },
    ], join(dir, "artifacts"), dir);
    await saveState(state);

    const { AutoApproveStrategy } = await import("../src/gate/auto-approve.js");
    const ctx = buildCtx({
      projectDir: dir,
      pipeline,
      headless: true,
      gateStrategy: new AutoApproveStrategy(),
    });
    const result = await runPipeline(ctx, { existingState: state });

    expect(result.status).toBe("passed");
    closeDatabase(dir);
  });
});

describe("pipeline_handoff runner execution", { timeout: 10_000 }, () => {
  it("publishes handoff payload and passes on orchestrator ack", async () => {
    const dir = tmpProjectDir();

    const pipeline = await writePipelineFile(dir, `
name: handoff-happy
stages:
  - name: chain
    type: pipeline_handoff
    prompt: Kick off phase 2
    next:
      file: pipelines/phase-2.yaml
      project: phase-2-project
    cmux:
      target: split_right
`);

    const state = createState(pipeline.name, "test-project", join(dir, "pipeline.yaml"), [
      { name: "chain", type: "pipeline_handoff" },
    ], join(dir, "artifacts"), dir);
    await saveState(state);

    // Orchestrator ack simulator: poll until the handoff gate appears, then
    // write the ack.
    const ackInterval = setInterval(async () => {
      const s = await loadState(state.runId, dir, true);
      if (!s?.gate || s.gate.kind !== "pipeline_handoff" || !s.gate.handoff) return;
      if (s.gate.status !== "pending") {
        clearInterval(ackInterval);
        return;
      }
      clearInterval(ackInterval);
      s.gate.handoff.launchedRunId = "child-run-abc";
      s.gate.handoff.targetPane = "surface:42";
      s.gate.status = "approved";
      s.gate.respondedAt = new Date().toISOString();
      await saveState(s);
    }, 50);

    const ctx = buildCtx({
      projectDir: dir,
      pipeline,
      gateStrategy: new FastPollGateStrategy(state.runId, dir),
    });
    const result = await runPipeline(ctx, { existingState: state });

    expect(result.status).toBe("passed");
    const stage = result.stages.find((s) => s.stageName === "chain");
    expect(stage?.status).toBe("passed");

    const loaded = await loadState(state.runId, dir);
    const artifacts = loaded?.stages["chain"]?.artifacts ?? {};
    expect(artifacts["handoff-launched-run"]).toBe("child-run-abc");
    expect(artifacts["handoff-target-pane"]).toBe("surface:42");
    closeDatabase(dir);
  });

  it("headless mode skips handoff as a no-op", async () => {
    const dir = tmpProjectDir();

    const pipeline = await writePipelineFile(dir, `
name: handoff-headless
stages:
  - name: chain
    type: pipeline_handoff
    next:
      file: pipelines/next.yaml
`);

    const state = createState(pipeline.name, "test-project", join(dir, "pipeline.yaml"), [
      { name: "chain", type: "pipeline_handoff" },
    ], join(dir, "artifacts"), dir);
    await saveState(state);

    const { AutoApproveStrategy } = await import("../src/gate/auto-approve.js");
    const ctx = buildCtx({
      projectDir: dir,
      pipeline,
      headless: true,
      gateStrategy: new AutoApproveStrategy(),
    });
    const result = await runPipeline(ctx, { existingState: state });

    expect(result.status).toBe("passed");
    // State.gate should never have been set — the stage returned before any
    // gate work. Confirm by checking status and that no gate is pending.
    const loaded = await loadState(state.runId, dir);
    expect(loaded?.gate).toBeUndefined();
    closeDatabase(dir);
  });

  it("on_timeout: skip marks stage as skipped when no ack arrives", async () => {
    const dir = tmpProjectDir();

    const pipeline = await writePipelineFile(dir, `
name: handoff-timeout-skip
stages:
  - name: chain
    type: pipeline_handoff
    next:
      file: pipelines/next.yaml
    on_timeout: skip
    timeout_ms: 300
`);

    const state = createState(pipeline.name, "test-project", join(dir, "pipeline.yaml"), [
      { name: "chain", type: "pipeline_handoff" },
    ], join(dir, "artifacts"), dir);
    await saveState(state);

    // No ack simulator — the gate will time out.
    const ctx = buildCtx({
      projectDir: dir,
      pipeline,
      gateStrategy: new FastPollGateStrategy(state.runId, dir),
    });
    const result = await runPipeline(ctx, { existingState: state });

    // Pipeline passes overall because the only stage was "skipped" (non-fatal).
    const stage = result.stages.find((s) => s.stageName === "chain");
    expect(stage?.status).toBe("skipped");
    closeDatabase(dir);
  });

  it("on_timeout: stop fails the stage when no ack arrives", async () => {
    const dir = tmpProjectDir();

    const pipeline = await writePipelineFile(dir, `
name: handoff-timeout-stop
stages:
  - name: chain
    type: pipeline_handoff
    next:
      file: pipelines/next.yaml
    on_timeout: stop
    timeout_ms: 300
`);

    const state = createState(pipeline.name, "test-project", join(dir, "pipeline.yaml"), [
      { name: "chain", type: "pipeline_handoff" },
    ], join(dir, "artifacts"), dir);
    await saveState(state);

    const ctx = buildCtx({
      projectDir: dir,
      pipeline,
      gateStrategy: new FastPollGateStrategy(state.runId, dir),
    });
    const result = await runPipeline(ctx, { existingState: state });

    const stage = result.stages.find((s) => s.stageName === "chain");
    expect(stage?.status).toBe("failed");
    expect(stage?.error).toContain("timed out");
    closeDatabase(dir);
  });
});
