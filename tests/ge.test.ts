import { describe, it, expect } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createState } from "../src/state.js";
import { AgentCrashError, MissingOutputError } from "../src/errors.js";
import type { AgentDispatcher, DispatchOptions } from "../src/dispatcher.js";
import type { GeStage, RunContext, Pipeline, AgentResult } from "../src/types.js";
import { tmpPath } from "./helpers.js";

// ---------------------------------------------------------------------------
// GE dry-run
// ---------------------------------------------------------------------------

describe("GE dry-run", () => {
  it("produces dry-run output for a GE stage", async () => {
    const { runGeCycle } = await import("../src/ge.js");

    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const stage: GeStage = {
      name: "test-ge",
      type: "ge",
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
    const result = await runGeCycle(stage, ctx, state);
    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(0);
    expect(result.maxIterations).toBe(2);
    expect(result.contractPath).toBeDefined();
  });

  it("dry-run logs contract and agent info", async () => {
    const { runGeCycle } = await import("../src/ge.js");

    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const logLines: string[] = [];
    const mockLogger = {
      log: (...args: unknown[]) => logLines.push(args.join(" ")),
      error: (...args: unknown[]) => logLines.push(args.join(" ")),
      warn: (...args: unknown[]) => logLines.push(args.join(" ")),
    };

    const stage: GeStage = {
      name: "dry-ge",
      type: "ge",
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
    await runGeCycle(stage, ctx, state);

    const output = logLines.join("\n");
    // Should NOT mention planner
    expect(output).not.toContain("planner");
    expect(output).not.toContain("task plan");
    // Should mention generator and evaluator
    expect(output).toContain("agents/gen.md");
    expect(output).toContain("agents/eval.md");
    expect(output).toContain("guidance");
  });
});

// ---------------------------------------------------------------------------
// GE iteration logic (with mock dispatch)
// ---------------------------------------------------------------------------

describe("GE iteration logic", () => {
  /**
   * Helper: build a mock dispatcher for the GE flow.
   *
   * Each GE pass dispatches 3 agents:
   *   1. contract   → writes contract.md    (dispatch 1, once only)
   *   2. generator → writes deliverable     (dispatch 2+ per iter)
   *   3. evaluator → writes evaluation-N.md (dispatch 3+ per iter)
   *
   * `evalOutcomes` controls what each evaluator dispatch writes.
   */
  function buildMockDispatcher(
    dir: string,
    evalOutcomes: ("PASS" | "FAIL")[],
  ): { dispatcher: AgentDispatcher; dispatchCount: () => number; prompts: string[] } {
    let count = 0;
    let evalIndex = 0;
    const prompts: string[] = [];

    const dispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        prompts.push(opts.userPrompt);
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});

          if (count === 1) {
            // Contract dispatch → contract.md
            await writeFile(
              opts.expectedOutput,
              "## Contract\n\n### Criteria\n\n1. Output exists\n\n### Pass Rule\n\nAll criteria must pass.\n",
              "utf-8",
            );
          } else {
            // GE loop: odd (relative) = generator, even = evaluator
            const geIndex = count - 1; // 1-based within GE loop
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

    return { dispatcher, dispatchCount: () => count, prompts };
  }

  async function setup() {
    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "gen.md"), "# Generator\nGenerate things.", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator\nEvaluate things.", "utf-8");
    return { dir, artifactDir, agentsDir };
  }

  function makeCtx(dir: string, artifactDir: string, agentsDir: string, stage: GeStage, dispatcher: AgentDispatcher): RunContext {
    return {
      project: "test",
      projectDir: dir,
      artifactDir,
      pipelineFile: "test.yaml",
      pipeline: { name: "test", stages: [stage] },
      dryRun: false,
      variables: { project: "test", project_dir: dir, artifact_dir: artifactDir, pipeline_name: "test" },
      agentSearchPaths: [agentsDir],
      dispatcher,
    };
  }

  it("passes on first iteration when evaluator returns PASS", async () => {
    const { dir, artifactDir, agentsDir } = await setup();
    const { dispatcher, dispatchCount } = buildMockDispatcher(dir, ["PASS"]);
    const { runGeCycle } = await import("../src/ge.js");

    const stage: GeStage = {
      name: "test-ge",
      type: "ge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/test-ge/output.md",
        max_iterations: 3,
      },
    };

    const ctx = makeCtx(dir, artifactDir, agentsDir, stage, dispatcher);
    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runGeCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(1);
    // 1 contract + 1 generator + 1 evaluator = 3
    expect(dispatchCount()).toBe(3);
    expect(result.contractPath).toBeDefined();
  });

  it("retries on FAIL then passes", async () => {
    const { dir, artifactDir, agentsDir } = await setup();
    const { dispatcher, dispatchCount } = buildMockDispatcher(dir, ["FAIL", "PASS"]);
    const { runGeCycle } = await import("../src/ge.js");

    const stage: GeStage = {
      name: "retry-ge",
      type: "ge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/retry-ge/output.md",
        max_iterations: 3,
      },
    };

    const ctx = makeCtx(dir, artifactDir, agentsDir, stage, dispatcher);
    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runGeCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(2);
    // 1 contract + 2 generators + 2 evaluators = 5
    expect(dispatchCount()).toBe(5);
  });

  it("returns fail after exhausting max iterations", async () => {
    const { dir, artifactDir, agentsDir } = await setup();
    const { dispatcher, dispatchCount } = buildMockDispatcher(dir, ["FAIL", "FAIL"]);
    const { runGeCycle } = await import("../src/ge.js");

    const stage: GeStage = {
      name: "exhaust-ge",
      type: "ge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/exhaust-ge/output.md",
        max_iterations: 2,
      },
    };

    const ctx = makeCtx(dir, artifactDir, agentsDir, stage, dispatcher);
    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runGeCycle(stage, ctx, state);

    expect(result.outcome).toBe("fail");
    expect(result.iterations).toBe(2);
    // 1 contract + 2 generators + 2 evaluators = 5
    expect(dispatchCount()).toBe(5);
  });

  it("contract writer crash throws AgentCrashError", async () => {
    const { dir, artifactDir, agentsDir } = await setup();
    const { runGeCycle } = await import("../src/ge.js");

    const crashDispatcher: AgentDispatcher = {
      async dispatch(): Promise<AgentResult> {
        return { exitCode: 1, outputExists: false, durationMs: 50 };
      },
    };

    const stage: GeStage = {
      name: "crash-ge",
      type: "ge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/crash-ge/output.md",
        max_iterations: 2,
      },
    };

    const ctx = makeCtx(dir, artifactDir, agentsDir, stage, crashDispatcher);
    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    await expect(runGeCycle(stage, ctx, state)).rejects.toThrow(AgentCrashError);
  });

  it("generator crash throws AgentCrashError", async () => {
    const { dir, artifactDir, agentsDir } = await setup();
    const { runGeCycle } = await import("../src/ge.js");

    let count = 0;
    const crashDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        if (count === 1 && opts.expectedOutput) {
          // Contract succeeds
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          await writeFile(opts.expectedOutput, "## Contract\n\n1. OK\n", "utf-8");
          return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
        }
        // Generator crashes
        return { exitCode: 1, outputExists: false, durationMs: 50 };
      },
    };

    const stage: GeStage = {
      name: "gen-crash",
      type: "ge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/gen-crash/output.md",
        max_iterations: 2,
      },
    };

    const ctx = makeCtx(dir, artifactDir, agentsDir, stage, crashDispatcher);
    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    await expect(runGeCycle(stage, ctx, state)).rejects.toThrow(AgentCrashError);
  });

  it("missing generator output throws MissingOutputError", async () => {
    const { dir, artifactDir, agentsDir } = await setup();
    const { runGeCycle } = await import("../src/ge.js");

    let count = 0;
    const noOutputDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        if (count === 1 && opts.expectedOutput) {
          // Contract succeeds
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          await writeFile(opts.expectedOutput, "## Contract\n", "utf-8");
          return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
        }
        // Generator exits 0 but no output
        return { exitCode: 0, outputExists: false, durationMs: 100 };
      },
    };

    const stage: GeStage = {
      name: "no-output",
      type: "ge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/no-output/output.md",
        max_iterations: 2,
      },
    };

    const ctx = makeCtx(dir, artifactDir, agentsDir, stage, noOutputDispatcher);
    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    await expect(runGeCycle(stage, ctx, state)).rejects.toThrow(MissingOutputError);
  });

  it("evaluation parse error returns error outcome", async () => {
    const { dir, artifactDir, agentsDir } = await setup();
    const { runGeCycle } = await import("../src/ge.js");

    let count = 0;
    const badEvalDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          if (count === 1) {
            await writeFile(opts.expectedOutput, "## Contract\n", "utf-8");
          } else if (count === 2) {
            await writeFile(opts.expectedOutput, "# Output\n", "utf-8");
          } else {
            // Evaluator writes unparseable output
            await writeFile(opts.expectedOutput, "No clear verdict here.\n", "utf-8");
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const stage: GeStage = {
      name: "parse-err",
      type: "ge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/parse-err/output.md",
        max_iterations: 2,
      },
    };

    const ctx = makeCtx(dir, artifactDir, agentsDir, stage, badEvalDispatcher);
    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    const result = await runGeCycle(stage, ctx, state);
    expect(result.outcome).toBe("error");
  });

  it("generator prompt has contractPath but no planFile", async () => {
    const { dir, artifactDir, agentsDir } = await setup();
    const { dispatcher, prompts } = buildMockDispatcher(dir, ["PASS"]);
    const { runGeCycle } = await import("../src/ge.js");

    const stage: GeStage = {
      name: "prompt-ge",
      type: "ge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/prompt-ge/output.md",
        max_iterations: 2,
      },
    };

    const ctx = makeCtx(dir, artifactDir, agentsDir, stage, dispatcher);
    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    await runGeCycle(stage, ctx, state);

    // prompt[0] = contract writer, prompt[1] = generator, prompt[2] = evaluator
    const genPrompt = prompts[1];
    expect(genPrompt).toContain("Contract");
    expect(genPrompt).toContain("contract.md");
    // No plan references
    expect(genPrompt).not.toContain("Plan\n");
    expect(genPrompt).not.toContain("task-plan.md");
  });

  it("tracks state progress through contract and GE loop", async () => {
    const { dir, artifactDir, agentsDir } = await setup();
    const { dispatcher } = buildMockDispatcher(dir, ["FAIL", "PASS"]);
    const { runGeCycle } = await import("../src/ge.js");

    const stage: GeStage = {
      name: "state-ge",
      type: "ge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/state-ge/output.md",
        max_iterations: 3,
      },
    };

    const ctx = makeCtx(dir, artifactDir, agentsDir, stage, dispatcher);
    const state = createState("test", "test", "test.yaml", [stage], artifactDir);

    const steps: string[] = [];
    const onProgress = async (eventType?: string) => {
      if (eventType) steps.push(eventType);
    };

    await runGeCycle(stage, ctx, state, onProgress);

    // Should see contract events, then GE loop events
    expect(steps).toContain("ge_contract_start");
    expect(steps).toContain("ge_contract_done");
    expect(steps).toContain("ge_start");
    expect(steps).toContain("ge_generator_start");
    expect(steps).toContain("ge_generator_done");
    expect(steps).toContain("ge_evaluator_start");
    expect(steps).toContain("ge_evaluator_done");
    expect(steps).toContain("ge_evaluation");

    // State artifacts
    expect(state.stages["state-ge"].artifacts?.contract).toBeDefined();
    expect(state.stages["state-ge"].artifacts?.deliverable).toBeDefined();
  });

  it("contract writer receives generator inputs for full context", async () => {
    const { dir, artifactDir, agentsDir } = await setup();
    const { dispatcher, prompts } = buildMockDispatcher(dir, ["PASS"]);
    const { runGeCycle } = await import("../src/ge.js");

    const stage: GeStage = {
      name: "ctx-ge",
      type: "ge",
      inputs: ["{artifact_dir}/shared.md"],
      generator: { agent: "agents/gen.md", inputs: ["{artifact_dir}/gen-only.md"] },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/ctx-ge/output.md",
        max_iterations: 2,
      },
    };

    const ctx = makeCtx(dir, artifactDir, agentsDir, stage, dispatcher);
    const state = createState("test", "test", "test.yaml", [stage], artifactDir);
    await runGeCycle(stage, ctx, state);

    // Contract prompt (first dispatch) should have both shared and generator inputs
    const contractPrompt = prompts[0];
    expect(contractPrompt).toContain("shared.md");
    expect(contractPrompt).toContain("gen-only.md");
  });

  it("reuses existing contract on gate feedback retry", async () => {
    const { dir, artifactDir, agentsDir } = await setup();
    const { runGeCycle } = await import("../src/ge.js");

    let count = 0;
    const prompts: string[] = [];
    const retryDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        prompts.push(opts.userPrompt);
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          if (count === 1) {
            // Generator
            await writeFile(opts.expectedOutput, "# Output\n", "utf-8");
          } else {
            // Evaluator
            await writeFile(opts.expectedOutput, "### Overall: PASS\n", "utf-8");
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const stage: GeStage = {
      name: "retry-ge",
      type: "ge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/retry-ge/output.md",
        max_iterations: 3,
      },
    };

    const ctx = makeCtx(dir, artifactDir, agentsDir, stage, retryDispatcher);
    const state = createState("test", "test", "test.yaml", [stage], artifactDir);

    const result = await runGeCycle(stage, ctx, state, undefined, {
      existingContractPath: "/existing/contract.md",
      gateFeedbackPath: "/feedback/review.md",
    });

    expect(result.outcome).toBe("pass");
    // No contract dispatch — jumped straight to generator + evaluator = 2
    expect(count).toBe(2);
    expect(result.contractPath).toBe("/existing/contract.md");
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("GE schema validation", () => {
  it("valid GE stage parses", async () => {
    const { loadPipeline } = await import("../src/pipeline.js");
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const yaml = `
name: ge-test
stages:
  - name: write-docs
    type: ge
    task: "Write docs."
    generator:
      agent: writer
    evaluator:
      agent: reviewer
    contract:
      deliverable: docs.md
      max_iterations: 3
`;
    const file = join(dir, "ge.yaml");
    await writeFile(file, yaml, "utf-8");
    const pipeline = await loadPipeline(file);
    expect(pipeline.stages).toHaveLength(1);
    const stage = pipeline.stages[0] as GeStage;
    expect(stage.type).toBe("ge");
    expect(stage.contract.max_iterations).toBe(3);
  });

  it("GE without contract.deliverable is rejected", async () => {
    const { loadPipeline } = await import("../src/pipeline.js");
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const yaml = `
name: bad-ge
stages:
  - name: bad
    type: ge
    generator:
      agent: writer
    evaluator:
      agent: reviewer
    contract:
      max_iterations: 3
`;
    const file = join(dir, "bad.yaml");
    await writeFile(file, yaml, "utf-8");
    await expect(loadPipeline(file)).rejects.toThrow();
  });

  it("GE max_iterations > 10 is rejected", async () => {
    const { loadPipeline } = await import("../src/pipeline.js");
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const yaml = `
name: bad-ge
stages:
  - name: bad
    type: ge
    generator:
      agent: writer
    evaluator:
      agent: reviewer
    contract:
      deliverable: out.md
      max_iterations: 20
`;
    const file = join(dir, "bad.yaml");
    await writeFile(file, yaml, "utf-8");
    await expect(loadPipeline(file)).rejects.toThrow();
  });

  it("GE inside parallel group is allowed", async () => {
    const { loadPipeline } = await import("../src/pipeline.js");
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const yaml = `
name: parallel-ge
stages:
  - parallel:
      stages:
        - name: a
          type: ge
          generator: { agent: w }
          evaluator: { agent: r }
          contract: { deliverable: a.md, max_iterations: 2 }
        - name: b
          type: agent
          agent: writer
          output: b.md
`;
    const file = join(dir, "par.yaml");
    await writeFile(file, yaml, "utf-8");
    const pipeline = await loadPipeline(file);
    expect(pipeline.stages).toHaveLength(1);
  });

  it("GE output conflict in parallel group is detected", async () => {
    const { loadPipeline } = await import("../src/pipeline.js");
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const yaml = `
name: conflict-ge
stages:
  - parallel:
      stages:
        - name: a
          type: ge
          generator: { agent: w }
          evaluator: { agent: r }
          contract: { deliverable: same.md, max_iterations: 2 }
        - name: b
          type: ge
          generator: { agent: w }
          evaluator: { agent: r }
          contract: { deliverable: same.md, max_iterations: 2 }
`;
    const file = join(dir, "conflict.yaml");
    await writeFile(file, yaml, "utf-8");
    await expect(loadPipeline(file)).rejects.toThrow(/same\.md/);
  });
});
