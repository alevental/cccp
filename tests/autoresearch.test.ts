import { describe, it, expect } from "vitest";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createState } from "../src/state.js";
import { AgentCrashError, MissingOutputError } from "../src/errors.js";
import type { AgentDispatcher, DispatchOptions } from "../src/dispatcher.js";
import type { AutoresearchStage, RunContext, Pipeline, AgentResult } from "../src/types.js";
import { tmpPath } from "./helpers.js";

// ---------------------------------------------------------------------------
// Autoresearch dry-run
// ---------------------------------------------------------------------------

describe("Autoresearch dry-run", () => {
  it("produces dry-run output for an autoresearch stage", async () => {
    const { runAutoresearchCycle } = await import("../src/autoresearch.js");

    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const stage: AutoresearchStage = {
      name: "test-ar",
      type: "autoresearch",
      artifact: "prompt.md",
      ground_truth: "expected.md",
      output: "actual.md",
      adjuster: { agent: "agents/adjuster.md" },
      executor: { agent: "agents/executor.md" },
      evaluator: { agent: "agents/eval.md" },
      max_iterations: 5,
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: join(dir, "artifacts"),
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: true,
      variables: { project: "test", project_dir: dir, artifact_dir: join(dir, "artifacts"), pipeline_name: "test" },
      agentSearchPaths: [join(dir, "agents")],
    };

    const state = createState("test", "test", "test.yaml", [stage], join(dir, "artifacts"));
    const result = await runAutoresearchCycle(stage, ctx, state);
    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(0);
    expect(result.maxIterations).toBe(5);
    expect(result.artifactPath).toBeDefined();
    expect(result.outputPath).toBeDefined();
  });

  it("dry-run logs unlimited iterations when max_iterations is not set", async () => {
    const { runAutoresearchCycle } = await import("../src/autoresearch.js");

    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const logLines: string[] = [];
    const mockLogger = {
      log: (...args: unknown[]) => logLines.push(args.join(" ")),
      error: (...args: unknown[]) => logLines.push(args.join(" ")),
      warn: (...args: unknown[]) => logLines.push(args.join(" ")),
    };

    const stage: AutoresearchStage = {
      name: "unlimited-ar",
      type: "autoresearch",
      artifact: "prompt.md",
      ground_truth: "expected.md",
      output: "actual.md",
      adjuster: { agent: "agents/adjuster.md" },
      executor: { agent: "agents/executor.md" },
      evaluator: { agent: "agents/eval.md" },
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: join(dir, "artifacts"),
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: true,
      variables: { project: "test", project_dir: dir, artifact_dir: join(dir, "artifacts"), pipeline_name: "test" },
      agentSearchPaths: [join(dir, "agents")],
      logger: mockLogger as any,
    };

    const state = createState("test", "test", "test.yaml", [stage], join(dir, "artifacts"));
    const result = await runAutoresearchCycle(stage, ctx, state);

    expect(result.maxIterations).toBeUndefined();
    const output = logLines.join("\n");
    expect(output).toContain("unlimited");
  });
});

// ---------------------------------------------------------------------------
// Autoresearch iteration logic (with mock dispatch)
// ---------------------------------------------------------------------------

describe("Autoresearch iteration logic", () => {
  /**
   * Helper: build a mock dispatcher for autoresearch.
   *
   * Autoresearch dispatches in this pattern:
   *   Iter 1: executor(1) → evaluator(2)
   *   Iter 2+: adjuster(N) → executor(N+1) → evaluator(N+2)
   *
   * `evalOutcomes` controls what each evaluator dispatch writes.
   */
  function buildMockDispatcher(
    dir: string,
    evalOutcomes: ("PASS" | "FAIL")[],
  ): { dispatcher: AgentDispatcher; dispatchCount: () => number; dispatches: string[] } {
    let count = 0;
    let evalIndex = 0;
    const dispatches: string[] = [];

    const dispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});

          // Determine agent type from the agentName
          const name = opts.agentName ?? "";
          if (name.includes("adjuster")) {
            dispatches.push("adjuster");
            // Adjuster writes to the artifact path
            await writeFile(opts.expectedOutput, `# Adjusted Prompt v${count}\n\nTuned content.\n`, "utf-8");
          } else if (name.includes("executor")) {
            dispatches.push("executor");
            await writeFile(opts.expectedOutput, "# Executor Output\n\nResult content.\n", "utf-8");
          } else if (name.includes("evaluator")) {
            dispatches.push("evaluator");
            const outcome = evalOutcomes[evalIndex] ?? "FAIL";
            evalIndex++;
            const body =
              outcome === "FAIL"
                ? "### Overall: FAIL\n\n### Iteration Guidance\n1. Output diverges from expected.\n"
                : "### Overall: PASS\n";
            await writeFile(opts.expectedOutput, body, "utf-8");
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    return { dispatcher, dispatchCount: () => count, dispatches };
  }

  async function setupAgents(dir: string) {
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "adjuster.md"), "# Adjuster\nAdjust the artifact.", "utf-8");
    await writeFile(join(agentsDir, "executor.md"), "# Executor\nExecute the task.", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator\nEvaluate output.", "utf-8");

    // Create the initial artifact and ground truth
    await writeFile(join(dir, "prompt.md"), "# Initial Prompt\n\nOriginal content.\n", "utf-8");
    await writeFile(join(dir, "expected.md"), "# Expected Output\n\nTarget content.\n", "utf-8");

    return agentsDir;
  }

  it("passes on first iteration (no adjuster dispatched)", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);
    const artifactDir = join(dir, "artifacts");

    const { dispatcher: mockDispatcher, dispatchCount, dispatches } = buildMockDispatcher(dir, ["PASS"]);

    const { runAutoresearchCycle } = await import("../src/autoresearch.js");

    const stage: AutoresearchStage = {
      name: "test-ar",
      type: "autoresearch",
      artifact: "prompt.md",
      ground_truth: "expected.md",
      output: "artifacts/test-ar/actual.md",
      adjuster: { agent: "agents/adjuster.md" },
      executor: { agent: "agents/executor.md" },
      evaluator: { agent: "agents/eval.md" },
      max_iterations: 3,
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: mockDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runAutoresearchCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(1);
    // Iter 1: executor + evaluator = 2 (no adjuster on first iteration)
    expect(dispatchCount()).toBe(2);
    expect(dispatches).toEqual(["executor", "evaluator"]);
  });

  it("adjusts then passes on second iteration", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);
    const artifactDir = join(dir, "artifacts");

    const { dispatcher: mockDispatcher, dispatchCount, dispatches } = buildMockDispatcher(dir, ["FAIL", "PASS"]);

    const { runAutoresearchCycle } = await import("../src/autoresearch.js");

    const stage: AutoresearchStage = {
      name: "adjust-test",
      type: "autoresearch",
      artifact: "prompt.md",
      ground_truth: "expected.md",
      output: "artifacts/adjust-test/actual.md",
      adjuster: { agent: "agents/adjuster.md" },
      executor: { agent: "agents/executor.md" },
      evaluator: { agent: "agents/eval.md" },
      max_iterations: 3,
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: mockDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runAutoresearchCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(2);
    // Iter 1: executor + evaluator = 2
    // Iter 2: adjuster + executor + evaluator = 3
    // Total: 5
    expect(dispatchCount()).toBe(5);
    expect(dispatches).toEqual(["executor", "evaluator", "adjuster", "executor", "evaluator"]);
  });

  it("returns fail after exhausting max iterations", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);
    const artifactDir = join(dir, "artifacts");

    const { dispatcher: mockDispatcher, dispatchCount, dispatches } = buildMockDispatcher(dir, ["FAIL", "FAIL"]);

    const { runAutoresearchCycle } = await import("../src/autoresearch.js");

    const stage: AutoresearchStage = {
      name: "exhaust-test",
      type: "autoresearch",
      artifact: "prompt.md",
      ground_truth: "expected.md",
      output: "artifacts/exhaust-test/actual.md",
      adjuster: { agent: "agents/adjuster.md" },
      executor: { agent: "agents/executor.md" },
      evaluator: { agent: "agents/eval.md" },
      max_iterations: 2,
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: mockDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runAutoresearchCycle(stage, ctx, state);

    expect(result.outcome).toBe("fail");
    expect(result.iterations).toBe(2);
    // Iter 1: executor + evaluator = 2
    // Iter 2: adjuster + executor + evaluator = 3
    // Total: 5
    expect(dispatchCount()).toBe(5);
  });

  it("unlimited iterations: loops until PASS", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);
    const artifactDir = join(dir, "artifacts");

    // Fail 3 times, then pass on iteration 4
    const { dispatcher: mockDispatcher, dispatchCount, dispatches } = buildMockDispatcher(
      dir,
      ["FAIL", "FAIL", "FAIL", "PASS"],
    );

    const { runAutoresearchCycle } = await import("../src/autoresearch.js");

    const stage: AutoresearchStage = {
      name: "unlimited-test",
      type: "autoresearch",
      artifact: "prompt.md",
      ground_truth: "expected.md",
      output: "artifacts/unlimited-test/actual.md",
      adjuster: { agent: "agents/adjuster.md" },
      executor: { agent: "agents/executor.md" },
      evaluator: { agent: "agents/eval.md" },
      // No max_iterations — unlimited
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: mockDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runAutoresearchCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(4);
    expect(result.maxIterations).toBeUndefined();
    // Iter 1: executor + evaluator = 2
    // Iter 2-4: (adjuster + executor + evaluator) * 3 = 9
    // Total: 11
    expect(dispatchCount()).toBe(11);
  });

  it("executor crash throws AgentCrashError", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);
    const artifactDir = join(dir, "artifacts");

    let count = 0;
    const crashDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        // First dispatch is the executor — crash it
        return { exitCode: 1, outputPath: opts.expectedOutput, outputExists: false, durationMs: 50 };
      },
    };

    const { runAutoresearchCycle } = await import("../src/autoresearch.js");

    const stage: AutoresearchStage = {
      name: "crash-test",
      type: "autoresearch",
      artifact: "prompt.md",
      ground_truth: "expected.md",
      output: "artifacts/crash-test/actual.md",
      adjuster: { agent: "agents/adjuster.md" },
      executor: { agent: "agents/executor.md" },
      evaluator: { agent: "agents/eval.md" },
      max_iterations: 2,
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: crashDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);

    await expect(runAutoresearchCycle(stage, ctx, state)).rejects.toThrow(AgentCrashError);
    expect(count).toBe(1); // Only the executor was dispatched
  });

  it("tracks artifact versions in stage directory", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);
    const artifactDir = join(dir, "artifacts");

    const { dispatcher: mockDispatcher } = buildMockDispatcher(dir, ["FAIL", "PASS"]);

    const { runAutoresearchCycle } = await import("../src/autoresearch.js");

    const stage: AutoresearchStage = {
      name: "version-test",
      type: "autoresearch",
      artifact: "prompt.md",
      ground_truth: "expected.md",
      output: "artifacts/version-test/actual.md",
      adjuster: { agent: "agents/adjuster.md" },
      executor: { agent: "agents/executor.md" },
      evaluator: { agent: "agents/eval.md" },
      max_iterations: 3,
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: mockDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    await runAutoresearchCycle(stage, ctx, state);

    // Should have initial version (v0) and adjusted version (v2)
    expect(state.stages["version-test"].artifacts).toBeDefined();
    expect(state.stages["version-test"].artifacts!["artifact-v0"]).toBeDefined();
    expect(state.stages["version-test"].artifacts!["artifact-v2"]).toBeDefined();
    // Should have evaluations
    expect(state.stages["version-test"].artifacts!["evaluation-1"]).toBeDefined();
    expect(state.stages["version-test"].artifacts!["evaluation-2"]).toBeDefined();
  });
});
