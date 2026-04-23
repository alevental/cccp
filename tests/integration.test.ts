import { describe, it, expect, afterAll } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadPipeline } from "../src/pipeline.js";
import { runPipeline } from "../src/runner.js";
import { SilentLogger } from "../src/logger.js";
import { TempFileTracker } from "../src/temp-tracker.js";
import type { AgentDispatcher, DispatchOptions } from "../src/dispatcher.js";
import type { AgentResult, RunContext, Pipeline } from "../src/types.js";
import { tmpProjectDir, cleanupAll } from "./helpers.js";

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

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

/**
 * Write a minimal agent markdown file into the agents/ subdirectory.
 * Returns the relative path from the project dir (e.g. "agents/writer.md").
 */
async function writeAgent(dir: string, name: string, content?: string): Promise<string> {
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, name), content ?? `# ${name}\nYou are a test agent.`, "utf-8");
  return `agents/${name}`;
}

/** Write a pipeline YAML file and load it. */
async function writePipeline(dir: string, yaml: string): Promise<Pipeline> {
  const pipelineFile = join(dir, "pipeline.yaml");
  await writeFile(pipelineFile, yaml, "utf-8");
  return loadPipeline(pipelineFile);
}

/** Build a RunContext suitable for integration tests. */
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

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

describe("Integration: full pipeline execution", () => {
  // -------------------------------------------------------------------------
  // 1. Happy path: agent stage passes
  // -------------------------------------------------------------------------

  it("happy path — single agent stage passes", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "writer.md", "# Writer\nYou write files.");

    const pipeline = await writePipeline(dir, `
name: happy-path
stages:
  - name: write-output
    type: agent
    agent: agents/writer.md
    output: artifacts/result.md
    task: Write the result file
`);

    const dispatcher = new ScriptedDispatcher([
      async (opts) => {
        // Simulate agent writing the expected output file.
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "# Result\nGenerated content.", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    expect(result.pipeline).toBe("happy-path");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].status).toBe("passed");
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0].userPrompt).toContain("Write the result file");
  });

  // -------------------------------------------------------------------------
  // 2. PGE passes on first try
  // -------------------------------------------------------------------------

  it("PGE passes on first try", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "planner.md", "# Planner\nPlan the work.");
    await writeAgent(dir, "gen.md", "# Generator\nGenerate deliverables.");
    await writeAgent(dir, "eval.md", "# Evaluator\nEvaluate deliverables.");

    const pipeline = await writePipeline(dir, `
name: pge-first-pass
stages:
  - name: design
    type: pge
    task: Design the architecture
    planner:
      agent: agents/planner.md
    generator:
      agent: agents/gen.md
    evaluator:
      agent: agents/eval.md
    contract:
      deliverable: artifacts/design/output.md
      max_iterations: 3
`);

    const dispatcher = new ScriptedDispatcher([
      // Planner: write the task plan
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "# Task Plan\nDetailed plan for design.", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
      },
      // Contract writer (evaluator agent): write the contract
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "# Contract\n- All sections present\n- Architecture complete", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
      },
      // Generator: write the deliverable
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "# Architecture\nComplete design.", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
      // Evaluator: write PASS evaluation
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "### Overall: PASS\n\nAll criteria met.", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].status).toBe("passed");
    // Verify exactly 4 dispatch calls: planner + contract + generator + evaluator
    expect(dispatcher.calls).toHaveLength(4);

    // Verify the PGE result has 1 iteration
    const pgeResult = result.stages[0].result as { iterations: number; maxIterations: number };
    expect(pgeResult.iterations).toBe(1);
    expect(pgeResult.maxIterations).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 3. PGE retries then passes
  // -------------------------------------------------------------------------

  it("PGE retries on FAIL then passes on second iteration", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "planner.md", "# Planner\nPlan things.");
    await writeAgent(dir, "gen.md", "# Generator\nGenerate things.");
    await writeAgent(dir, "eval.md", "# Evaluator\nEvaluate things.");

    const pipeline = await writePipeline(dir, `
name: pge-retry
stages:
  - name: retry-stage
    type: pge
    task: Generate with retry
    planner:
      agent: agents/planner.md
    generator:
      agent: agents/gen.md
    evaluator:
      agent: agents/eval.md
    contract:
      deliverable: artifacts/retry-stage/output.md
      max_iterations: 3
`);

    const dispatcher = new ScriptedDispatcher([
      // Planner: write the task plan
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "# Task Plan\nPlan for retry-stage.", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
      },
      // Contract writer: write the contract
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "# Contract\n- Output is high quality", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
      },
      // Iteration 1 — generator
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "# Draft 1\nInitial attempt.", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
      // Iteration 1 — evaluator: FAIL
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(
            opts.expectedOutput,
            "### Overall: FAIL\n\n### Iteration Guidance\n1. Improve quality\n",
            "utf-8",
          );
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
      },
      // Iteration 2 — generator (retry)
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "# Draft 2\nImproved version.", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
      // Iteration 2 — evaluator: PASS
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "### Overall: PASS\n\nAll criteria met.", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].status).toBe("passed");
    // 6 dispatch calls: planner + contract + gen1 + eval1(FAIL) + gen2 + eval2(PASS)
    expect(dispatcher.calls).toHaveLength(6);

    const pgeResult = result.stages[0].result as { iterations: number };
    expect(pgeResult.iterations).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 4. PGE exhausts max iterations
  // -------------------------------------------------------------------------

  it("PGE exhausts max iterations and fails", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "planner.md", "# Planner\nPlan things.");
    await writeAgent(dir, "gen.md", "# Generator\nGenerate things.");
    await writeAgent(dir, "eval.md", "# Evaluator\nEvaluate things.");

    const pipeline = await writePipeline(dir, `
name: pge-exhaust
stages:
  - name: exhaust-stage
    type: pge
    task: Always fails evaluation
    planner:
      agent: agents/planner.md
    generator:
      agent: agents/gen.md
    evaluator:
      agent: agents/eval.md
    contract:
      deliverable: artifacts/exhaust-stage/output.md
      max_iterations: 2
`);

    const handlers: Array<(opts: DispatchOptions) => Promise<AgentResult>> = [];

    // Planner: write task plan (1 dispatch)
    handlers.push(async (opts) => {
      if (opts.expectedOutput) {
        await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
        await writeFile(opts.expectedOutput, "# Task Plan\nPlan for exhaust-stage.", "utf-8");
      }
      return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
    });

    // Contract writer: write contract (1 dispatch)
    handlers.push(async (opts) => {
      if (opts.expectedOutput) {
        await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
        await writeFile(opts.expectedOutput, "# Contract\n- Impossible criterion", "utf-8");
      }
      return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
    });

    // 2 iterations x (generator + evaluator) = 4 dispatches, all evaluators FAIL
    for (let iter = 0; iter < 2; iter++) {
      // Generator
      handlers.push(async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, `# Output iteration ${iter + 1}`, "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      });
      // Evaluator: always FAIL
      handlers.push(async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "### Overall: FAIL\n\nDoes not meet criteria.", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
      });
    }

    const dispatcher = new ScriptedDispatcher(handlers);
    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("failed");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].status).toBe("failed");
    // 6 dispatches: planner + contract + 2 generators + 2 evaluators
    expect(dispatcher.calls).toHaveLength(6);

    const pgeResult = result.stages[0].result as { iterations: number; maxIterations: number; outcome: string };
    expect(pgeResult.outcome).toBe("fail");
    expect(pgeResult.iterations).toBe(2);
    expect(pgeResult.maxIterations).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 5. Agent crash — dispatcher returns exitCode: 1
  // -------------------------------------------------------------------------

  it("agent crash returns error status", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "crasher.md", "# Crasher\nThis agent will crash.");

    const pipeline = await writePipeline(dir, `
name: crash-test
stages:
  - name: crash-stage
    type: agent
    agent: agents/crasher.md
    task: This stage will crash
`);

    const dispatcher = new ScriptedDispatcher([
      async () => {
        return { exitCode: 1, outputExists: false, durationMs: 10 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("error");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].status).toBe("error");
    expect(result.stages[0].error).toContain("crashed");
    expect(result.stages[0].error).toContain("exit code 1");
    expect(dispatcher.calls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 6. Dry-run — no dispatches made
  // -------------------------------------------------------------------------

  it("dry-run skips all dispatches and passes", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "writer.md", "# Writer\nWrite files.");

    const pipeline = await writePipeline(dir, `
name: dry-run-test
stages:
  - name: write-step
    type: agent
    agent: agents/writer.md
    output: artifacts/output.md
    task: Write some output
`);

    const dispatcher = new ScriptedDispatcher([
      // This handler should NEVER be called in dry-run mode
      async () => {
        throw new Error("Dispatch should not be called in dry-run mode");
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher, dryRun: true });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].status).toBe("passed");
    // No dispatch calls should have been made
    expect(dispatcher.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pipeline stage (sub-pipeline) tests
// ---------------------------------------------------------------------------

describe("Integration: pipeline stage (sub-pipeline)", () => {
  it("executes a sub-pipeline inline", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "worker.md", "# Worker\nDo work.");

    // Write sub-pipeline
    const subDir = join(dir, "pipelines");
    await mkdir(subDir, { recursive: true });
    const subYaml = `
name: sub-pipeline
stages:
  - name: sub-task
    type: agent
    agent: agents/worker.md
    task: Do the sub-task
    output: artifacts/sub-output.md
`;
    await writeFile(join(subDir, "sub.yaml"), subYaml, "utf-8");

    // Write main pipeline referencing the sub-pipeline
    const pipeline = await writePipeline(dir, `
name: parent-pipeline
stages:
  - name: run-sub
    type: pipeline
    file: pipelines/sub.yaml
`);

    const dispatcher = new ScriptedDispatcher([
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "# Sub output", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 30 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].stageName).toBe("run-sub");
    expect(result.stages[0].status).toBe("passed");
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0].userPrompt).toContain("Do the sub-task");
  });

  it("sub-pipeline failure propagates to parent", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "crasher.md", "# Crasher\nCrashes.");

    const subDir = join(dir, "pipelines");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "crash-sub.yaml"), `
name: crash-sub
stages:
  - name: crash-task
    type: agent
    agent: agents/crasher.md
    task: This will crash
`, "utf-8");

    const pipeline = await writePipeline(dir, `
name: parent-with-crash
stages:
  - name: run-crash
    type: pipeline
    file: pipelines/crash-sub.yaml
`);

    const dispatcher = new ScriptedDispatcher([
      async () => ({ exitCode: 1, outputExists: false, durationMs: 10 }),
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("failed");
    expect(result.stages[0].status).toBe("failed");
    expect(result.stages[0].error).toContain("crash-sub");
  });

  it("on_fail: skip allows parent to continue", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "crasher.md", "# Crasher");
    await writeAgent(dir, "writer.md", "# Writer");

    const subDir = join(dir, "pipelines");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "fail-sub.yaml"), `
name: fail-sub
stages:
  - name: fail-task
    type: agent
    agent: agents/crasher.md
    task: This will fail
`, "utf-8");

    const pipeline = await writePipeline(dir, `
name: skip-on-fail
stages:
  - name: may-fail
    type: pipeline
    file: pipelines/fail-sub.yaml
    on_fail: skip
  - name: after-fail
    type: agent
    agent: agents/writer.md
    task: This should still run
    output: artifacts/after.md
`);

    const dispatcher = new ScriptedDispatcher([
      // Sub-pipeline agent crashes
      async () => ({ exitCode: 1, outputExists: false, durationMs: 10 }),
      // After-fail agent succeeds
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "# After", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 20 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0].status).toBe("skipped");
    expect(result.stages[1].status).toBe("passed");
    expect(dispatcher.calls).toHaveLength(2);
  });

  it("detects circular pipeline dependencies", async () => {
    const dir = tmpProjectDir();

    // Pipeline A references pipeline B, B references A
    const subDir = join(dir, "pipelines");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "a.yaml"), `
name: pipeline-a
stages:
  - name: call-b
    type: pipeline
    file: pipelines/b.yaml
`, "utf-8");
    await writeFile(join(subDir, "b.yaml"), `
name: pipeline-b
stages:
  - name: call-a
    type: pipeline
    file: pipelines/a.yaml
`, "utf-8");

    // Main references A
    const pipeline = await writePipeline(dir, `
name: cycle-test
stages:
  - name: start
    type: pipeline
    file: pipelines/a.yaml
`);

    const dispatcher = new ScriptedDispatcher([]);
    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    // Circular dependency causes the nested sub-pipeline to error, which propagates as failed.
    expect(result.status).toBe("failed");
    expect(result.stages[0].status).toBe("failed");
    expect(result.stages[0].error).toContain("pipeline-a");
  });

  it("passes variables to sub-pipeline explicitly", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "worker.md", "# Worker");

    const subDir = join(dir, "pipelines");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "var-sub.yaml"), `
name: var-sub
variables:
  tag: default
stages:
  - name: greet
    type: agent
    agent: agents/worker.md
    task: Write the output
    output: "{artifact_dir}/{tag}/greet.md"
`, "utf-8");

    const pipeline = await writePipeline(dir, `
name: var-parent
stages:
  - name: run-with-vars
    type: pipeline
    file: pipelines/var-sub.yaml
    variables:
      tag: from-parent
`);

    const dispatcher = new ScriptedDispatcher([
      async (opts) => {
        if (opts.expectedOutput) {
          await mkdir(resolve(opts.expectedOutput, ".."), { recursive: true });
          await writeFile(opts.expectedOutput, "# Greeting", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 20 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    // The variable override should appear in the resolved output path
    expect(dispatcher.calls[0].expectedOutput).toContain("from-parent");
  });

  it("resumes sub-pipeline from correct child stage after crash", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "worker.md", "# Worker\nDo work.");

    // Write sub-pipeline with 3 stages
    const subDir = join(dir, "pipelines");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "multi-sub.yaml"), `
name: multi-sub
stages:
  - name: child-a
    type: agent
    agent: agents/worker.md
    task: First child task
  - name: child-b
    type: agent
    agent: agents/worker.md
    task: Second child task
  - name: child-c
    type: agent
    agent: agents/worker.md
    task: Third child task
`, "utf-8");

    const pipeline = await writePipeline(dir, `
name: resume-parent
stages:
  - name: run-sub
    type: pipeline
    file: pipelines/multi-sub.yaml
`);

    // First run: child-a passes, child-b crashes
    const firstDispatcher = new ScriptedDispatcher([
      async () => ({ exitCode: 0, outputExists: false, durationMs: 10 }),  // child-a passes
      async () => ({ exitCode: 1, outputExists: false, durationMs: 10 }),  // child-b crashes
    ]);

    const ctx1 = buildTestContext({ projectDir: dir, pipeline, dispatcher: firstDispatcher });
    const result1 = await runPipeline(ctx1);

    expect(result1.status).toBe("failed");

    // Load state for resume
    const { openDatabase } = await import("../src/db.js");
    const db = await openDatabase(dir);
    const runs = db.listRuns();
    expect(runs.length).toBeGreaterThan(0);
    // Find the parent run (it has the pipeline name "resume-parent")
    const parentRun = runs.find(r => r.state.pipeline === "resume-parent");
    expect(parentRun).toBeDefined();
    const existingState = parentRun!.state;

    // Verify the child state was saved in the parent
    expect(existingState.stages["run-sub"].children).toBeDefined();
    expect(existingState.stages["run-sub"].children!.stages["child-a"].status).toBe("passed");

    // Resume: child-b should run (not child-a again), then child-c
    const resumeDispatcher = new ScriptedDispatcher([
      async () => ({ exitCode: 0, outputExists: false, durationMs: 10 }),  // child-b retry
      async () => ({ exitCode: 0, outputExists: false, durationMs: 10 }),  // child-c
    ]);

    const ctx2 = buildTestContext({ projectDir: dir, pipeline, dispatcher: resumeDispatcher });
    const result2 = await runPipeline(ctx2, { existingState });

    expect(result2.status).toBe("passed");
    // Only 2 dispatches on resume (child-b and child-c), NOT 3
    expect(resumeDispatcher.calls).toHaveLength(2);
    // Verify child-b prompt is the second task, not the first
    expect(resumeDispatcher.calls[0].userPrompt).toContain("Second child task");
    expect(resumeDispatcher.calls[1].userPrompt).toContain("Third child task");
  });

  it("--from <sub-pipeline-stage> re-runs the entire sub-pipeline from scratch", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "worker.md", "# Worker\nDo work.");

    const subDir = join(dir, "pipelines");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "from-sub.yaml"), `
name: from-sub
stages:
  - name: child-a
    type: agent
    agent: agents/worker.md
    task: A task
  - name: child-b
    type: agent
    agent: agents/worker.md
    task: B task
`, "utf-8");

    const pipeline = await writePipeline(dir, `
name: from-parent
stages:
  - name: run-sub
    type: pipeline
    file: pipelines/from-sub.yaml
`);

    // First run: sub-pipeline fully passes.
    const firstDispatcher = new ScriptedDispatcher([
      async () => ({ exitCode: 0, outputExists: false, durationMs: 1 }),
      async () => ({ exitCode: 0, outputExists: false, durationMs: 1 }),
    ]);
    const result1 = await runPipeline(
      buildTestContext({ projectDir: dir, pipeline, dispatcher: firstDispatcher }),
    );
    expect(result1.status).toBe("passed");
    expect(firstDispatcher.calls).toHaveLength(2);

    // Load parent state and reset from the sub-pipeline stage.
    const { openDatabase } = await import("../src/db.js");
    const { resetFromStage } = await import("../src/state.js");
    const db = await openDatabase(dir);
    const parentState = db.listRuns().find(r => r.state.pipeline === "from-parent")!.state;
    await resetFromStage(parentState, "run-sub");

    // Resume should re-dispatch BOTH child stages, not skip them.
    const resumeDispatcher = new ScriptedDispatcher([
      async () => ({ exitCode: 0, outputExists: false, durationMs: 1 }),
      async () => ({ exitCode: 0, outputExists: false, durationMs: 1 }),
    ]);
    const result2 = await runPipeline(
      buildTestContext({ projectDir: dir, pipeline, dispatcher: resumeDispatcher }),
      { existingState: parentState },
    );
    expect(result2.status).toBe("passed");
    expect(resumeDispatcher.calls).toHaveLength(2);
    expect(resumeDispatcher.calls[0].userPrompt).toContain("A task");
    expect(resumeDispatcher.calls[1].userPrompt).toContain("B task");
  });
});
