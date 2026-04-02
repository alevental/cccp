import { describe, it, expect, afterAll } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadPipeline } from "../src/pipeline.js";
import { runPipeline } from "../src/runner.js";
import { flattenStageEntries } from "../src/state.js";
import { isParallelGroup } from "../src/types.js";
import { SilentLogger } from "../src/logger.js";
import { TempFileTracker } from "../src/temp-tracker.js";
import type { AgentDispatcher, DispatchOptions } from "../src/dispatcher.js";
import type { AgentResult, RunContext, Pipeline, StageEntry } from "../src/types.js";
import { tmpPath, tmpProjectDir, cleanupAll } from "./helpers.js";

afterAll(async () => {
  await cleanupAll();
});

// ---------------------------------------------------------------------------
// ScriptedDispatcher — returns pre-programmed results in call order
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeTmpYaml(content: string): Promise<string> {
  const dir = tmpPath();
  await mkdir(dir, { recursive: true });
  const file = join(dir, "pipeline.yaml");
  await writeFile(file, content, "utf-8");
  return file;
}

async function writeAgent(dir: string, name: string, content?: string): Promise<string> {
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, name), content ?? `# ${name}\nYou are a test agent.`, "utf-8");
  return `agents/${name}`;
}

async function writePipeline(dir: string, yaml: string): Promise<Pipeline> {
  const pipelineFile = join(dir, "pipeline.yaml");
  await writeFile(pipelineFile, yaml, "utf-8");
  return loadPipeline(pipelineFile);
}

function buildTestContext(opts: {
  projectDir: string;
  pipeline: Pipeline;
  dispatcher: AgentDispatcher;
  dryRun?: boolean;
}): RunContext {
  const artifactDir = join(opts.projectDir, "artifacts");
  return {
    project: "test-project",
    projectDir: opts.projectDir,
    artifactDir,
    pipelineFile: join(opts.projectDir, "pipeline.yaml"),
    pipeline: opts.pipeline,
    dryRun: opts.dryRun ?? false,
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
  };
}

function successHandler(): (opts: DispatchOptions) => Promise<AgentResult> {
  return async (opts) => {
    if (opts.expectedOutput) {
      await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
      await writeFile(opts.expectedOutput, "# Output\nGenerated.", "utf-8");
    }
    return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 10 };
  };
}

function failHandler(): (opts: DispatchOptions) => Promise<AgentResult> {
  return async () => {
    return { exitCode: 1, outputExists: false, durationMs: 10 };
  };
}

// ===========================================================================
// 1. Pipeline parsing — parallel groups
// ===========================================================================

describe("Pipeline parsing: parallel groups", () => {
  it("parses a pipeline with a parallel group", async () => {
    const file = await writeTmpYaml(`
name: parallel-test
stages:
  - name: research
    type: agent
    agent: agents/researcher.md

  - parallel:
      stages:
        - name: blog-post
          type: agent
          agent: agents/writer.md
          output: blog.md
        - name: release-notes
          type: agent
          agent: agents/writer.md
          output: notes.md

  - name: approval
    type: human_gate
    prompt: Approve
`);

    const pipeline = await loadPipeline(file);
    expect(pipeline.stages).toHaveLength(3);

    // First entry is a regular stage
    expect(isParallelGroup(pipeline.stages[0])).toBe(false);
    expect((pipeline.stages[0] as any).name).toBe("research");

    // Second entry is a parallel group
    expect(isParallelGroup(pipeline.stages[1])).toBe(true);
    const group = pipeline.stages[1] as any;
    expect(group.parallel.stages).toHaveLength(2);
    expect(group.parallel.stages[0].name).toBe("blog-post");
    expect(group.parallel.stages[1].name).toBe("release-notes");

    // Third entry is a regular stage
    expect(isParallelGroup(pipeline.stages[2])).toBe(false);
  });

  it("parses on_failure option", async () => {
    const file = await writeTmpYaml(`
name: parallel-on-failure
stages:
  - parallel:
      on_failure: wait_all
      stages:
        - name: a
          type: agent
          agent: agents/a.md
        - name: b
          type: agent
          agent: agents/b.md
`);

    const pipeline = await loadPipeline(file);
    const group = pipeline.stages[0] as any;
    expect(group.parallel.on_failure).toBe("wait_all");
  });

  it("rejects human_gate inside parallel group", async () => {
    const file = await writeTmpYaml(`
name: bad-parallel
stages:
  - parallel:
      stages:
        - name: work
          type: agent
          agent: agents/a.md
        - name: gate
          type: human_gate
          prompt: Approve
`);

    await expect(loadPipeline(file)).rejects.toThrow(/human_gate.*cannot be inside a parallel group/);
  });

  it("rejects pipeline stage inside parallel group", async () => {
    const file = await writeTmpYaml(`
name: bad-parallel-pipeline
stages:
  - parallel:
      stages:
        - name: work
          type: agent
          agent: agents/a.md
        - name: sub
          type: pipeline
          file: other.yaml
`);

    await expect(loadPipeline(file)).rejects.toThrow(/pipeline.*cannot be inside a parallel group/);
  });

  it("rejects duplicate stage names across parallel and regular stages", async () => {
    const file = await writeTmpYaml(`
name: bad-names
stages:
  - name: research
    type: agent
    agent: agents/a.md

  - parallel:
      stages:
        - name: research
          type: agent
          agent: agents/b.md
        - name: other
          type: agent
          agent: agents/c.md
`);

    await expect(loadPipeline(file)).rejects.toThrow(/Duplicate stage name 'research'/);
  });

  it("rejects conflicting output paths within parallel group", async () => {
    const file = await writeTmpYaml(`
name: bad-outputs
stages:
  - parallel:
      stages:
        - name: a
          type: agent
          agent: agents/a.md
          output: same-file.md
        - name: b
          type: agent
          agent: agents/b.md
          output: same-file.md
`);

    await expect(loadPipeline(file)).rejects.toThrow(/both write to 'same-file.md'/);
  });

  it("requires at least 2 stages in a parallel group", async () => {
    const file = await writeTmpYaml(`
name: single-parallel
stages:
  - parallel:
      stages:
        - name: lonely
          type: agent
          agent: agents/a.md
`);

    await expect(loadPipeline(file)).rejects.toThrow(/at least 2 stages/);
  });
});

// ===========================================================================
// 2. State flattening
// ===========================================================================

describe("flattenStageEntries", () => {
  it("flattens a mix of stages and parallel groups", async () => {
    const file = await writeTmpYaml(`
name: flatten-test
stages:
  - name: first
    type: agent
    agent: agents/a.md

  - parallel:
      stages:
        - name: par-a
          type: agent
          agent: agents/a.md
        - name: par-b
          type: agent
          agent: agents/b.md

  - name: last
    type: agent
    agent: agents/c.md
`);

    const pipeline = await loadPipeline(file);
    const flat = flattenStageEntries(pipeline.stages);

    expect(flat).toEqual([
      { name: "first", type: "agent" },
      { name: "par-a", type: "agent", groupId: "parallel-0" },
      { name: "par-b", type: "agent", groupId: "parallel-0" },
      { name: "last", type: "agent" },
    ]);
  });

  it("assigns different groupIds to different parallel groups", async () => {
    const file = await writeTmpYaml(`
name: multi-group
stages:
  - parallel:
      stages:
        - name: a1
          type: agent
          agent: agents/a.md
        - name: a2
          type: agent
          agent: agents/b.md

  - name: middle
    type: agent
    agent: agents/c.md

  - parallel:
      stages:
        - name: b1
          type: agent
          agent: agents/d.md
        - name: b2
          type: agent
          agent: agents/e.md
`);

    const pipeline = await loadPipeline(file);
    const flat = flattenStageEntries(pipeline.stages);

    expect(flat[0].groupId).toBe("parallel-0");
    expect(flat[1].groupId).toBe("parallel-0");
    expect(flat[2].groupId).toBeUndefined();
    expect(flat[3].groupId).toBe("parallel-1");
    expect(flat[4].groupId).toBe("parallel-1");
  });
});

// ===========================================================================
// 3. Integration: parallel execution
// ===========================================================================

describe("Integration: parallel execution", () => {
  it("executes parallel stages concurrently and passes", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "writer.md");

    const pipeline = await writePipeline(dir, `
name: parallel-happy
stages:
  - name: setup
    type: agent
    agent: agents/writer.md
    task: Setup work

  - parallel:
      stages:
        - name: task-a
          type: agent
          agent: agents/writer.md
          output: "{artifact_dir}/a.md"
          task: Write file A
        - name: task-b
          type: agent
          agent: agents/writer.md
          output: "{artifact_dir}/b.md"
          task: Write file B

  - name: finish
    type: agent
    agent: agents/writer.md
    task: Finish up
`);

    const callOrder: string[] = [];
    const dispatcher = new ScriptedDispatcher([
      // setup
      async () => {
        callOrder.push("setup");
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
      // task-a (parallel)
      async (opts) => {
        callOrder.push("task-a");
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "A", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 10 };
      },
      // task-b (parallel)
      async (opts) => {
        callOrder.push("task-b");
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "B", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 10 };
      },
      // finish
      async () => {
        callOrder.push("finish");
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    expect(result.stages).toHaveLength(4);
    expect(result.stages.every(s => s.status === "passed")).toBe(true);
    expect(dispatcher.calls).toHaveLength(4);
    // Setup must come before parallel stages, finish must come after.
    expect(callOrder[0]).toBe("setup");
    expect(callOrder[3]).toBe("finish");
    // Parallel stages can be in either order (both should be called).
    expect(callOrder.slice(1, 3).sort()).toEqual(["task-a", "task-b"]);
  });

  it("fail_fast: marks unstarted siblings as skipped when one fails", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "writer.md");

    const pipeline = await writePipeline(dir, `
name: parallel-fail-fast
stages:
  - parallel:
      on_failure: fail_fast
      stages:
        - name: fast-fail
          type: agent
          agent: agents/writer.md
          task: Will fail
        - name: slow-success
          type: agent
          agent: agents/writer.md
          task: Will succeed
`);

    // Use content-based dispatch since parallel order is non-deterministic.
    const dispatcher: AgentDispatcher & { calls: DispatchOptions[] } = {
      calls: [],
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        this.calls.push(opts);
        if (opts.userPrompt.includes("Will fail")) {
          return { exitCode: 1, outputExists: false, durationMs: 10 };
        }
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
    };

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    // Agent crash (exit code 1) results in "error" status.
    expect(result.status).toBe("error");
    // At least the failing stage should be present.
    const failStage = result.stages.find(s => s.stageName === "fast-fail");
    expect(failStage).toBeDefined();
    expect(failStage!.status).toBe("error");
  });

  it("wait_all: all stages complete even when one fails", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "writer.md");

    const pipeline = await writePipeline(dir, `
name: parallel-wait-all
stages:
  - parallel:
      on_failure: wait_all
      stages:
        - name: will-fail
          type: agent
          agent: agents/writer.md
          task: Will fail
        - name: will-succeed
          type: agent
          agent: agents/writer.md
          task: Will succeed
`);

    // Use content-based dispatch since parallel order is non-deterministic.
    const dispatcher: AgentDispatcher & { calls: DispatchOptions[] } = {
      calls: [],
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        this.calls.push(opts);
        if (opts.userPrompt.includes("Will fail")) {
          return { exitCode: 1, outputExists: false, durationMs: 10 };
        }
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
    };

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("error");
    expect(result.stages).toHaveLength(2);

    const failStage = result.stages.find(s => s.stageName === "will-fail");
    const passStage = result.stages.find(s => s.stageName === "will-succeed");
    expect(failStage).toBeDefined();
    expect(passStage).toBeDefined();
    expect(failStage!.status).toBe("error");
    expect(passStage!.status).toBe("passed");
  });

  it("pipeline fails after parallel group failure and does not continue to next stage", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "writer.md");

    const pipeline = await writePipeline(dir, `
name: parallel-stops-pipeline
stages:
  - parallel:
      stages:
        - name: a
          type: agent
          agent: agents/writer.md
          task: Fails
        - name: b
          type: agent
          agent: agents/writer.md
          task: Succeeds

  - name: should-not-run
    type: agent
    agent: agents/writer.md
    task: Should not run
`);

    let thirdCalled = false;
    const dispatcher: AgentDispatcher & { calls: DispatchOptions[] } = {
      calls: [],
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        this.calls.push(opts);
        if (opts.userPrompt.includes("Fails")) {
          return { exitCode: 1, outputExists: false, durationMs: 10 };
        }
        if (opts.userPrompt.includes("Should not run")) {
          thirdCalled = true;
        }
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
    };

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("error");
    expect(thirdCalled).toBe(false);
    // should-not-run should not be in results.
    expect(result.stages.find(s => s.stageName === "should-not-run")).toBeUndefined();
  });

  it("dry-run works with parallel groups", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "writer.md");

    const pipeline = await writePipeline(dir, `
name: parallel-dry-run
stages:
  - parallel:
      stages:
        - name: a
          type: agent
          agent: agents/writer.md
          task: Task A
        - name: b
          type: agent
          agent: agents/writer.md
          task: Task B
`);

    const dispatcher = new ScriptedDispatcher([]);
    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher, dryRun: true });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    // Dry-run should process all stages without dispatching.
    expect(dispatcher.calls).toHaveLength(0);
  });
});
