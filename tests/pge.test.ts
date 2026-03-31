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
