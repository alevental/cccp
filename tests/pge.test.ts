import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createState } from "../src/state.js";
import { AgentCrashError, MissingOutputError } from "../src/errors.js";
import type { AgentDispatcher, DispatchOptions } from "../src/dispatcher.js";
import type { PgeStage, RunContext, Pipeline, PipelineState, AgentResult } from "../src/types.js";
import { tmpPath } from "./helpers.js";

// ---------------------------------------------------------------------------
// PGE dry-run
// ---------------------------------------------------------------------------

describe("PGE dry-run", () => {
  it("produces dry-run output for a PGE stage via runner", async () => {
    const { runPgeCycle } = await import("../src/pge.js");

    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const stage: PgeStage = {
      name: "test-pge",
      type: "pge",
      planner: { agent: "agents/planner.md" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "output.md",
        max_iterations: 2,
      },
    };

    const pipeline: Pipeline = {
      name: "test",
      stages: [stage],
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: join(dir, "artifacts"),
      pipelineFile: "test.yaml",
      pipeline,
      dryRun: true,
      variables: { project: "test", project_dir: dir, artifact_dir: join(dir, "artifacts"), pipeline_name: "test" },
      agentSearchPaths: [join(dir, "agents")],
    };

    const state = createState("test", "test", "test.yaml", [stage], join(dir, "artifacts"));
    const result = await runPgeCycle(stage, ctx, state);
    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(0);
    expect(result.maxIterations).toBe(2);
    expect(result.taskPlanPath).toBeDefined();
    expect(result.contractPath).toBeDefined();
  });

  it("dry-run logs planner and contract info", async () => {
    const { runPgeCycle } = await import("../src/pge.js");

    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const logLines: string[] = [];
    const mockLogger = {
      log: (...args: unknown[]) => logLines.push(args.join(" ")),
      error: (...args: unknown[]) => logLines.push(args.join(" ")),
      warn: (...args: unknown[]) => logLines.push(args.join(" ")),
    };

    const stage: PgeStage = {
      name: "dry-pge",
      type: "pge",
      planner: { agent: "agents/planner.md", operation: "decompose" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "output.md",
        guidance: "Focus on correctness",
        max_iterations: 3,
      },
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
    await runPgeCycle(stage, ctx, state);

    const output = logLines.join("\n");
    expect(output).toContain("agents/planner.md");
    expect(output).toContain("decompose");
    expect(output).toContain("agents/gen.md");
    expect(output).toContain("agents/eval.md");
    expect(output).toContain("guidance");
  });
});

// ---------------------------------------------------------------------------
// PGE iteration logic (with mock dispatch)
// ---------------------------------------------------------------------------

describe("PGE iteration logic", () => {
  /**
   * Helper: build a mock dispatcher for the planner-based PGE flow.
   *
   * Each PGE pass dispatches 4 agents:
   *   1. planner   → writes task-plan.md   (dispatch 1, once only)
   *   2. contract   → writes contract.md    (dispatch 2, once only)
   *   3. generator → writes deliverable     (dispatch 3+ per iter)
   *   4. evaluator → writes evaluation-N.md (dispatch 4+ per iter)
   *
   * `evalOutcomes` controls what each evaluator dispatch writes.
   * For example, ["FAIL", "PASS"] means iter 1 fails, iter 2 passes.
   */
  function buildMockDispatcher(
    dir: string,
    evalOutcomes: ("PASS" | "FAIL")[],
  ): { dispatcher: AgentDispatcher; dispatchCount: () => number } {
    let count = 0;
    let evalIndex = 0;

    const dispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});

          if (count === 1) {
            // Planner dispatch → task-plan.md
            await writeFile(opts.expectedOutput, "# Task Plan\n\n1. Do the thing\n2. Verify the thing\n", "utf-8");
          } else if (count === 2) {
            // Contract dispatch → contract.md
            await writeFile(
              opts.expectedOutput,
              "## Contract\n\n### Criteria\n\n1. Output exists\n\n### Pass Rule\n\nAll criteria must pass.\n",
              "utf-8",
            );
          } else {
            // GE loop: odd = generator, even = evaluator (relative to GE loop start)
            const geIndex = count - 2; // 1-based index within the GE loop
            if (geIndex % 2 === 1) {
              // Generator
              await writeFile(opts.expectedOutput, "# Generated Output\n\nSome content.\n", "utf-8");
            } else {
              // Evaluator
              const outcome = evalOutcomes[evalIndex] ?? "FAIL";
              evalIndex++;
              const body =
                outcome === "FAIL"
                  ? "### Overall: FAIL\n\n### Iteration Guidance\n1. Fix it\n"
                  : "### Overall: PASS\n";
              await writeFile(opts.expectedOutput, body, "utf-8");
            }
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    return { dispatcher, dispatchCount: () => count };
  }

  it("passes on first iteration when evaluator returns PASS", async () => {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "planner.md"), "# Planner\nPlan things.", "utf-8");
    await writeFile(join(agentsDir, "gen.md"), "# Generator\nGenerate things.", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator\nEvaluate things.", "utf-8");

    const { dispatcher: mockDispatcher, dispatchCount } = buildMockDispatcher(dir, ["PASS"]);

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "test-pge",
      type: "pge",
      planner: { agent: "agents/planner.md" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/test-pge/output.md",
        max_iterations: 3,
      },
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: mockDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runPgeCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(1);
    // 1 planner + 1 contract + 1 generator + 1 evaluator = 4
    expect(dispatchCount()).toBe(4);
    expect(result.taskPlanPath).toBeDefined();
    expect(result.contractPath).toBeDefined();
  });

  it("retries on FAIL then passes", async () => {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "planner.md"), "# Planner", "utf-8");
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    const { dispatcher: mockDispatcher, dispatchCount } = buildMockDispatcher(dir, ["FAIL", "PASS"]);

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "retry-test",
      type: "pge",
      planner: { agent: "agents/planner.md" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/retry-test/output.md",
        max_iterations: 3,
      },
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: mockDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runPgeCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(2);
    // 1 planner + 1 contract + 2 generators + 2 evaluators = 6
    expect(dispatchCount()).toBe(6);
  });

  it("returns fail after exhausting max iterations", async () => {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "planner.md"), "# Planner", "utf-8");
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    const { dispatcher: mockDispatcher, dispatchCount } = buildMockDispatcher(dir, ["FAIL", "FAIL"]);

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "exhaust-test",
      type: "pge",
      planner: { agent: "agents/planner.md" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/exhaust-test/output.md",
        max_iterations: 2,
      },
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: mockDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runPgeCycle(stage, ctx, state);

    expect(result.outcome).toBe("fail");
    expect(result.iterations).toBe(2);
    // 1 planner + 1 contract + 2 generators + 2 evaluators = 6
    expect(dispatchCount()).toBe(6);
  });

  it("planner crash throws AgentCrashError", async () => {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "planner.md"), "# Planner", "utf-8");
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    let count = 0;
    const crashDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        // First dispatch is the planner — crash it
        if (count === 1) {
          return { exitCode: 1, outputPath: opts.expectedOutput, outputExists: false, durationMs: 50 };
        }
        // Should never reach here
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          await writeFile(opts.expectedOutput, "content", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "crash-test",
      type: "pge",
      planner: { agent: "agents/planner.md" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/crash-test/output.md",
        max_iterations: 2,
      },
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: crashDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);

    await expect(runPgeCycle(stage, ctx, state)).rejects.toThrow(AgentCrashError);
    expect(count).toBe(1); // Only the planner was dispatched
  });

  it("contract step missing output throws MissingOutputError", async () => {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "planner.md"), "# Planner", "utf-8");
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    let count = 0;
    const noContractDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        if (count === 1) {
          // Planner succeeds and writes task-plan.md
          if (opts.expectedOutput) {
            await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
            await writeFile(opts.expectedOutput, "# Task Plan\n\n1. Step one\n", "utf-8");
          }
          return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
        }
        if (count === 2) {
          // Contract dispatch succeeds (exit 0) but does NOT write the file
          return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: false, durationMs: 100 };
        }
        // Should never reach here
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          await writeFile(opts.expectedOutput, "content", "utf-8");
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "no-contract-test",
      type: "pge",
      planner: { agent: "agents/planner.md" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/no-contract-test/output.md",
        max_iterations: 2,
      },
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: noContractDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);

    await expect(runPgeCycle(stage, ctx, state)).rejects.toThrow(MissingOutputError);
    expect(count).toBe(2); // Planner succeeded, contract dispatch happened but no file
  });
});

// ---------------------------------------------------------------------------
// PgeCycleOptions: skip planning and inject gate feedback
// ---------------------------------------------------------------------------

describe("PGE cycle with PgeCycleOptions", () => {
  it("skips planner and contract when existingContractPath and existingTaskPlanPath are provided", async () => {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    const stageDir = join(artifactDir, "options-test");
    await mkdir(agentsDir, { recursive: true });
    await mkdir(stageDir, { recursive: true });
    await writeFile(join(agentsDir, "planner.md"), "# Planner", "utf-8");
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    // Create existing contract and task plan files
    const existingContractPath = join(stageDir, "contract.md");
    const existingTaskPlanPath = join(stageDir, "task-plan.md");
    const gateFeedbackPath = join(dir, "gate-feedback.md");
    await writeFile(existingContractPath, "## Contract\n\n### Criteria\n\n1. Output exists\n", "utf-8");
    await writeFile(existingTaskPlanPath, "# Task Plan\n\n1. Do the thing\n", "utf-8");
    await writeFile(gateFeedbackPath, "# Gate Feedback\n\nFix the introduction section.\n", "utf-8");

    const dispatches: string[] = [];
    let dispatchIndex = 0;

    const trackingDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        dispatchIndex++;
        dispatches.push(opts.userPrompt);

        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          if (dispatchIndex % 2 === 1) {
            // Generator
            await writeFile(opts.expectedOutput, "# Generated Output\n\nRevised content.\n", "utf-8");
          } else {
            // Evaluator
            await writeFile(opts.expectedOutput, "### Overall: PASS\n", "utf-8");
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "options-test",
      type: "pge",
      planner: { agent: "agents/planner.md" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/options-test/output.md",
        max_iterations: 3,
      },
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: trackingDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runPgeCycle(stage, ctx, state, undefined, {
      existingContractPath,
      existingTaskPlanPath,
      gateFeedbackPath,
    });

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(1);
    // Only 2 dispatches: generator + evaluator (planner and contract skipped)
    expect(dispatchIndex).toBe(2);
    // Generator prompt should contain gate feedback reference
    expect(dispatches[0]).toContain("Gate Feedback");
    expect(dispatches[0]).toContain(gateFeedbackPath);
  });

  it("does not inject gate feedback when gateFeedbackPath is not provided", async () => {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    const stageDir = join(artifactDir, "no-feedback-test");
    await mkdir(agentsDir, { recursive: true });
    await mkdir(stageDir, { recursive: true });
    await writeFile(join(agentsDir, "planner.md"), "# Planner", "utf-8");
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    const existingContractPath = join(stageDir, "contract.md");
    const existingTaskPlanPath = join(stageDir, "task-plan.md");
    await writeFile(existingContractPath, "## Contract\n\n### Criteria\n\n1. OK\n", "utf-8");
    await writeFile(existingTaskPlanPath, "# Task Plan\n\n1. Step one\n", "utf-8");

    const dispatches: string[] = [];
    let dispatchIndex = 0;

    const trackingDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        dispatchIndex++;
        dispatches.push(opts.userPrompt);

        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          if (dispatchIndex % 2 === 1) {
            await writeFile(opts.expectedOutput, "# Output\n", "utf-8");
          } else {
            await writeFile(opts.expectedOutput, "### Overall: PASS\n", "utf-8");
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "no-feedback-test",
      type: "pge",
      planner: { agent: "agents/planner.md" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/no-feedback-test/output.md",
        max_iterations: 2,
      },
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: trackingDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runPgeCycle(stage, ctx, state, undefined, {
      existingContractPath,
      existingTaskPlanPath,
    });

    expect(result.outcome).toBe("pass");
    // Generator prompt should NOT contain gate feedback
    expect(dispatches[0]).not.toContain("Gate Feedback");
  });

  it("threads model/effort overrides to each dispatch", async () => {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "planner.md"), "# Planner", "utf-8");
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    // Track model/effort per dispatch
    const captured: { agentName?: string; model?: string; effort?: string }[] = [];
    let count = 0;
    let evalIndex = 0;

    const trackingDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        captured.push({ agentName: opts.agentName, model: opts.model, effort: opts.effort });
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          if (count === 1) {
            await writeFile(opts.expectedOutput, "# Task Plan\n\n1. Do it\n", "utf-8");
          } else if (count === 2) {
            await writeFile(opts.expectedOutput, "## Contract\n\n### Criteria\n\n1. OK\n", "utf-8");
          } else {
            const geIndex = count - 2;
            if (geIndex % 2 === 1) {
              await writeFile(opts.expectedOutput, "# Output\n", "utf-8");
            } else {
              await writeFile(opts.expectedOutput, "### Overall: PASS\n", "utf-8");
            }
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "effort-test",
      type: "pge",
      effort: "high",
      model: "opus",
      planner: { agent: "agents/planner.md", effort: "medium" },
      generator: { agent: "agents/gen.md", model: "sonnet" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/effort-test/output.md",
        max_iterations: 3,
      },
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", effort: "low", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: trackingDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runPgeCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
    expect(captured).toHaveLength(4);

    // Planner: agent override effort=medium, inherits model=opus from stage
    expect(captured[0].agentName).toContain("planner");
    expect(captured[0].effort).toBe("medium");
    expect(captured[0].model).toBe("opus");

    // Contract: uses evaluator config (no overrides), inherits from stage
    expect(captured[1].agentName).toContain("contract");
    expect(captured[1].effort).toBe("high");
    expect(captured[1].model).toBe("opus");

    // Generator: agent override model=sonnet, inherits effort=high from stage
    expect(captured[2].agentName).toContain("generator");
    expect(captured[2].model).toBe("sonnet");
    expect(captured[2].effort).toBe("high");

    // Evaluator: no overrides, inherits from stage
    expect(captured[3].agentName).toContain("evaluator");
    expect(captured[3].effort).toBe("high");
    expect(captured[3].model).toBe("opus");
  });

  it("applies phase_defaults when stage and agent don't override", async () => {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "planner.md"), "# Planner", "utf-8");
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    const captured: { agentName?: string; model?: string; effort?: string }[] = [];
    let count = 0;

    const trackingDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        captured.push({ agentName: opts.agentName, model: opts.model, effort: opts.effort });
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          if (count === 1) {
            await writeFile(opts.expectedOutput, "# Task Plan\n\n1. Do it\n", "utf-8");
          } else if (count === 2) {
            await writeFile(opts.expectedOutput, "## Contract\n\n### Criteria\n\n1. OK\n", "utf-8");
          } else {
            const geIndex = count - 2;
            if (geIndex % 2 === 1) {
              await writeFile(opts.expectedOutput, "# Output\n", "utf-8");
            } else {
              await writeFile(opts.expectedOutput, "### Overall: PASS\n", "utf-8");
            }
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const { runPgeCycle } = await import("../src/pge.js");

    // No stage-level or agent-level overrides — only phase_defaults + pipeline default
    const stage: PgeStage = {
      name: "phase-test",
      type: "pge",
      planner: { agent: "agents/planner.md" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/phase-test/output.md",
        max_iterations: 3,
      },
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: artifactDir,
      pipelineFile: "test.yaml",
      pipeline: {
        name: "test",
        effort: "high",
        phase_defaults: {
          planner: { effort: "medium" },
          evaluator: { model: "haiku", effort: "low" },
        },
        stages: [stage],
      },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: trackingDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runPgeCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
    expect(captured).toHaveLength(4);

    // Planner: phase_defaults planner effort=medium, no model phase default → pipeline model (undefined)
    expect(captured[0].agentName).toContain("planner");
    expect(captured[0].effort).toBe("medium");
    expect(captured[0].model).toBeUndefined();

    // Contract: uses evaluator phase defaults → model=haiku, effort=low
    expect(captured[1].agentName).toContain("contract");
    expect(captured[1].model).toBe("haiku");
    expect(captured[1].effort).toBe("low");

    // Generator: no phase default for generator → falls back to pipeline effort=high
    expect(captured[2].agentName).toContain("generator");
    expect(captured[2].effort).toBe("high");
    expect(captured[2].model).toBeUndefined();

    // Evaluator: phase_defaults evaluator → model=haiku, effort=low
    expect(captured[3].agentName).toContain("evaluator");
    expect(captured[3].model).toBe("haiku");
    expect(captured[3].effort).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// PGE stages with structured outputs
// ---------------------------------------------------------------------------

describe("PGE stages with structured outputs", () => {
  it("passes outputsPath and outputKeys to generator prompt when stage declares outputs", async () => {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "planner.md"), "# Planner", "utf-8");
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    const dispatches: { agentName?: string; prompt: string }[] = [];
    let count = 0;
    let evalIndex = 0;

    const trackingDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        dispatches.push({ agentName: opts.agentName, prompt: opts.userPrompt });
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          if (count === 1) {
            await writeFile(opts.expectedOutput, "# Task Plan\n\n1. Do it\n", "utf-8");
          } else if (count === 2) {
            await writeFile(opts.expectedOutput, "## Contract\n\n### Criteria\n\n1. OK\n", "utf-8");
          } else {
            const geIndex = count - 2;
            if (geIndex % 2 === 1) {
              // Generator — also write .outputs.json
              await writeFile(opts.expectedOutput, "# Output\n", "utf-8");
              const stageDir = join(artifactDir, "outputs-test");
              await mkdir(stageDir, { recursive: true });
              await writeFile(
                join(stageDir, ".outputs.json"),
                JSON.stringify({ has_issues: "no" }),
                "utf-8",
              );
            } else {
              await writeFile(opts.expectedOutput, "### Overall: PASS\n", "utf-8");
            }
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "outputs-test",
      type: "pge",
      planner: { agent: "agents/planner.md" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/outputs-test/output.md",
        max_iterations: 2,
      },
      outputs: {
        has_issues: "yes if the review found issues, no if clean",
      },
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: trackingDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runPgeCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");

    // Generator prompt (dispatch 3) should contain structured outputs instructions
    const genPrompt = dispatches[2].prompt;
    expect(genPrompt).toContain("Structured Outputs");
    expect(genPrompt).toContain(".outputs.json");
    expect(genPrompt).toContain("has_issues");
  });

  it("injects outputs verification guidance into evaluator prompt", async () => {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "planner.md"), "# Planner", "utf-8");
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    const dispatches: { agentName?: string; prompt: string }[] = [];
    let count = 0;

    const trackingDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        dispatches.push({ agentName: opts.agentName, prompt: opts.userPrompt });
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          if (count === 1) {
            await writeFile(opts.expectedOutput, "# Task Plan\n\n1. Do it\n", "utf-8");
          } else if (count === 2) {
            await writeFile(opts.expectedOutput, "## Contract\n\n### Criteria\n\n1. OK\n", "utf-8");
          } else {
            const geIndex = count - 2;
            if (geIndex % 2 === 1) {
              await writeFile(opts.expectedOutput, "# Output\n", "utf-8");
            } else {
              await writeFile(opts.expectedOutput, "### Overall: PASS\n", "utf-8");
            }
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "eval-outputs-check",
      type: "pge",
      planner: { agent: "agents/planner.md" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/eval-outputs-check/output.md",
        max_iterations: 2,
      },
      outputs: {
        has_issues: "yes if the review found issues, no if clean",
      },
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: trackingDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    await runPgeCycle(stage, ctx, state);

    // Evaluator prompt (dispatch 4) should contain outputs verification guidance
    const evalPrompt = dispatches[3].prompt;
    expect(evalPrompt).toContain("Structured Outputs Check");
    expect(evalPrompt).toContain(".outputs.json");
    expect(evalPrompt).toContain("has_issues");
    expect(evalPrompt).toContain("MUST FAIL");
  });

  it("does not inject outputs instructions when stage has no outputs", async () => {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "planner.md"), "# Planner", "utf-8");
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    const dispatches: { agentName?: string; prompt: string }[] = [];
    let count = 0;

    const trackingDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        dispatches.push({ agentName: opts.agentName, prompt: opts.userPrompt });
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          if (count === 1) {
            await writeFile(opts.expectedOutput, "# Task Plan\n\n1. Do it\n", "utf-8");
          } else if (count === 2) {
            await writeFile(opts.expectedOutput, "## Contract\n\n### Criteria\n\n1. OK\n", "utf-8");
          } else {
            const geIndex = count - 2;
            if (geIndex % 2 === 1) {
              await writeFile(opts.expectedOutput, "# Output\n", "utf-8");
            } else {
              await writeFile(opts.expectedOutput, "### Overall: PASS\n", "utf-8");
            }
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "no-outputs",
      type: "pge",
      planner: { agent: "agents/planner.md" },
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/no-outputs/output.md",
        max_iterations: 2,
      },
      // No outputs declared
    };

    const ctx: RunContext = {
      project: "test",
      projectDir: dir,
      artifactDir: artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher: trackingDispatcher,
    };

    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    await runPgeCycle(stage, ctx, state);

    // Neither generator nor evaluator should mention outputs
    const genPrompt = dispatches[2].prompt;
    const evalPrompt = dispatches[3].prompt;
    expect(genPrompt).not.toContain("Structured Outputs");
    expect(genPrompt).not.toContain(".outputs.json");
    expect(evalPrompt).not.toContain("Structured Outputs Check");
  });
});
