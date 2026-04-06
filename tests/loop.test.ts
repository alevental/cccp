import { describe, it, expect } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createState } from "../src/state.js";
import { AgentCrashError, MissingOutputError } from "../src/errors.js";
import type { AgentDispatcher, DispatchOptions } from "../src/dispatcher.js";
import type { LoopStage, RunContext, AgentResult } from "../src/types.js";
import { tmpPath } from "./helpers.js";

// ---------------------------------------------------------------------------
// Loop dry-run
// ---------------------------------------------------------------------------

describe("Loop dry-run", () => {
  it("produces dry-run output for a loop stage", async () => {
    const { runLoopCycle } = await import("../src/loop.js");

    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const stage: LoopStage = {
      name: "test-loop",
      type: "loop",
      stages: [
        { name: "fix", agent: "agents/implementer.md" },
      ],
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

    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], join(dir, "artifacts"));
    const result = await runLoopCycle(stage, ctx, state);
    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(0);
    expect(result.maxIterations).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Loop iteration logic (with mock dispatch)
// ---------------------------------------------------------------------------

describe("Loop iteration logic", () => {
  /**
   * Helper: build a mock dispatcher for loop stages.
   *
   * Loop dispatches in this pattern per iteration:
   *   body_1 → body_2 → ... → evaluator
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
        const name = opts.agentName ?? "";

        if (name.endsWith("-evaluator")) {
          dispatches.push("evaluator");
          if (opts.expectedOutput) {
            await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
            const outcome = evalOutcomes[evalIndex] ?? "FAIL";
            evalIndex++;
            const body =
              outcome === "FAIL"
                ? "### Overall: FAIL\n\n### Iteration Guidance\n1. Issues found.\n"
                : "### Overall: PASS\n";
            await writeFile(opts.expectedOutput, body, "utf-8");
          }
        } else {
          // Extract body stage name: agentName is "{stageName}-{bodyName}"
          // Find the last segment after the stage name prefix
          const lastDash = name.lastIndexOf("-");
          const bodyName = lastDash >= 0 ? name.slice(lastDash + 1) : name;
          dispatches.push(bodyName);
          if (opts.expectedOutput) {
            await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
            await writeFile(opts.expectedOutput, `# Output from ${name}\n`, "utf-8");
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
    await writeFile(join(agentsDir, "implementer.md"), "# Implementer\nImplement changes.", "utf-8");
    await writeFile(join(agentsDir, "tester.md"), "# Tester\nRun tests.", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator\nEvaluate output.", "utf-8");
    return agentsDir;
  }

  function makeStage(overrides?: Partial<LoopStage>): LoopStage {
    return {
      name: "test-loop",
      type: "loop",
      stages: [
        { name: "fix", agent: "agents/implementer.md" },
      ],
      evaluator: { agent: "agents/eval.md" },
      max_iterations: 5,
      ...overrides,
    };
  }

  function makeCtx(dir: string, agentsDir: string, stage: LoopStage, dispatcher: AgentDispatcher): RunContext {
    const artifactDir = join(dir, "artifacts");
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

  it("passes on first iteration", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    const { dispatcher: mockDispatcher, dispatchCount, dispatches } = buildMockDispatcher(dir, ["PASS"]);
    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage();
    const ctx = makeCtx(dir, agentsDir, stage, mockDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);
    const result = await runLoopCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(1);
    // 1 body + 1 evaluator = 2
    expect(dispatchCount()).toBe(2);
    expect(dispatches).toEqual(["fix", "evaluator"]);
  });

  it("retries on FAIL and passes on iteration 2", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    const { dispatcher: mockDispatcher, dispatchCount, dispatches } = buildMockDispatcher(dir, ["FAIL", "PASS"]);
    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage({ max_iterations: 3 });
    const ctx = makeCtx(dir, agentsDir, stage, mockDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);
    const result = await runLoopCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(2);
    // Iter 1: fix + eval = 2, Iter 2: fix + eval = 2 → total 4
    expect(dispatchCount()).toBe(4);
    expect(dispatches).toEqual(["fix", "evaluator", "fix", "evaluator"]);
  });

  it("skip_first skips body on iteration 1", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    const { dispatcher: mockDispatcher, dispatchCount, dispatches } = buildMockDispatcher(dir, ["FAIL", "PASS"]);
    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage({
      stages: [
        { name: "fix", agent: "agents/implementer.md", skip_first: true },
        { name: "test", agent: "agents/tester.md" },
      ],
      max_iterations: 3,
    });
    const ctx = makeCtx(dir, agentsDir, stage, mockDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);
    const result = await runLoopCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(2);
    // Iter 1: test + eval = 2 (fix skipped)
    // Iter 2: fix + test + eval = 3
    // Total: 5
    expect(dispatchCount()).toBe(5);
    expect(dispatches).toEqual(["test", "evaluator", "fix", "test", "evaluator"]);
  });

  it("returns fail after exhausting max iterations", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    const { dispatcher: mockDispatcher, dispatchCount } = buildMockDispatcher(dir, ["FAIL", "FAIL"]);
    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage({ max_iterations: 2 });
    const ctx = makeCtx(dir, agentsDir, stage, mockDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);
    const result = await runLoopCycle(stage, ctx, state);

    expect(result.outcome).toBe("fail");
    expect(result.iterations).toBe(2);
    // Iter 1: fix + eval = 2, Iter 2: fix + eval = 2 → total 4
    expect(dispatchCount()).toBe(4);
  });

  it("body agent crash throws AgentCrashError", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    const crashDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        return { exitCode: 1, outputPath: opts.expectedOutput, outputExists: false, durationMs: 50 };
      },
    };

    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage();
    const ctx = makeCtx(dir, agentsDir, stage, crashDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);

    await expect(runLoopCycle(stage, ctx, state)).rejects.toThrow(AgentCrashError);
  });

  it("evaluator crash throws AgentCrashError", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    let count = 0;
    const crashDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        if (count === 1) {
          // Body succeeds
          return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
        }
        // Evaluator crashes
        return { exitCode: 1, outputPath: opts.expectedOutput, outputExists: false, durationMs: 50 };
      },
    };

    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage();
    const ctx = makeCtx(dir, agentsDir, stage, crashDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);

    await expect(runLoopCycle(stage, ctx, state)).rejects.toThrow(AgentCrashError);
  });

  it("missing body output throws MissingOutputError", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    const missingOutputDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        // Body agent succeeds but doesn't create output
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: false, durationMs: 50 };
      },
    };

    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage({
      stages: [
        { name: "fix", agent: "agents/implementer.md", output: "{artifact_dir}/test-loop/fix-output.md" },
      ],
    });
    const ctx = makeCtx(dir, agentsDir, stage, missingOutputDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);

    await expect(runLoopCycle(stage, ctx, state)).rejects.toThrow(MissingOutputError);
  });

  it("parse error returns outcome error", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    let count = 0;
    const parseErrorDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        count++;
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          if ((opts.agentName ?? "").includes("evaluator")) {
            // Write output without PASS/FAIL line
            await writeFile(opts.expectedOutput, "# Evaluation\nSome feedback without a verdict.\n", "utf-8");
          } else {
            await writeFile(opts.expectedOutput, "# Body output\n", "utf-8");
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
      },
    };

    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage();
    const ctx = makeCtx(dir, agentsDir, stage, parseErrorDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);
    const result = await runLoopCycle(stage, ctx, state);

    expect(result.outcome).toBe("error");
    expect(result.iterations).toBe(1);
  });

  it("tracks iteration and pgeStep in state", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    const { dispatcher: mockDispatcher } = buildMockDispatcher(dir, ["PASS"]);
    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage();
    const ctx = makeCtx(dir, agentsDir, stage, mockDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);
    await runLoopCycle(stage, ctx, state);

    expect(state.stages["test-loop"].iteration).toBe(1);
    expect(state.stages["test-loop"].pgeStep).toBe("routed");
  });

  it("dispatches multi-body stages in order each iteration", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);
    // Add a third agent
    await writeFile(join(agentsDir, "reviewer.md"), "# Reviewer\nReview work.", "utf-8");

    const { dispatcher: mockDispatcher, dispatches } = buildMockDispatcher(dir, ["PASS"]);
    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage({
      stages: [
        { name: "fix", agent: "agents/implementer.md" },
        { name: "test", agent: "agents/tester.md" },
        { name: "review", agent: "agents/reviewer.md" },
      ],
    });
    const ctx = makeCtx(dir, agentsDir, stage, mockDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);
    await runLoopCycle(stage, ctx, state);

    expect(dispatches).toEqual(["fix", "test", "review", "evaluator"]);
  });

  it("previousEvaluation only goes to first non-skipped body stage", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    const prompts: Record<string, string> = {};
    const evalOutcomes = ["FAIL", "PASS"];
    let evalIndex = 0;

    const trackingDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        const name = opts.agentName ?? "";
        prompts[name] = opts.userPrompt;
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          if (name.includes("evaluator")) {
            const outcome = evalOutcomes[evalIndex] ?? "FAIL";
            evalIndex++;
            const body = outcome === "FAIL"
              ? "### Overall: FAIL\n\n### Iteration Guidance\n1. Issues found.\n"
              : "### Overall: PASS\n";
            await writeFile(opts.expectedOutput, body, "utf-8");
          } else {
            await writeFile(opts.expectedOutput, `# Output from ${name}\n`, "utf-8");
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage({
      stages: [
        { name: "fix", agent: "agents/implementer.md", skip_first: true },
        { name: "test", agent: "agents/tester.md" },
      ],
      max_iterations: 3,
    });
    const ctx = makeCtx(dir, agentsDir, stage, trackingDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);
    await runLoopCycle(stage, ctx, state);

    // On iter 2, "fix" is the first active body — it should get previousEvaluation
    const fixPromptIter2 = prompts["test-loop-fix"];
    expect(fixPromptIter2).toContain("Previous Evaluation");

    // "test" should NOT get previousEvaluation on iter 2
    const testPromptIter2 = prompts["test-loop-test"];
    expect(testPromptIter2).not.toContain("Previous Evaluation");
  });

  it("body without output skips output check", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    // Dispatcher that never creates output files
    const noOutputDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        if ((opts.agentName ?? "").includes("evaluator") && opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          await writeFile(opts.expectedOutput, "### Overall: PASS\n", "utf-8");
          return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 50 };
        }
        // Body agent: no expectedOutput (since body has no output field)
        return { exitCode: 0, outputExists: true, durationMs: 50 };
      },
    };

    const { runLoopCycle } = await import("../src/loop.js");

    // Stage with no output on body — should not throw MissingOutputError
    const stage = makeStage({
      stages: [
        { name: "fix", agent: "agents/implementer.md" },
      ],
    });
    const ctx = makeCtx(dir, agentsDir, stage, noOutputDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);
    const result = await runLoopCycle(stage, ctx, state);

    expect(result.outcome).toBe("pass");
  });

  it("gate feedback retry injects feedback into first body stage", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    // Write a fake gate feedback file
    const feedbackPath = join(dir, "feedback.md");
    await writeFile(feedbackPath, "# Gate Feedback\nFix the issues.", "utf-8");

    const prompts: Record<string, string> = {};

    const trackingDispatcher: AgentDispatcher = {
      async dispatch(opts: DispatchOptions): Promise<AgentResult> {
        const name = opts.agentName ?? "";
        prompts[name] = opts.userPrompt;
        if (opts.expectedOutput) {
          await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
          if (name.includes("evaluator")) {
            await writeFile(opts.expectedOutput, "### Overall: PASS\n", "utf-8");
          } else {
            await writeFile(opts.expectedOutput, `# Output from ${name}\n`, "utf-8");
          }
        }
        return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
      },
    };

    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage();
    const ctx = makeCtx(dir, agentsDir, stage, trackingDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);
    const result = await runLoopCycle(stage, ctx, state, undefined, { gateFeedbackPath: feedbackPath });

    expect(result.outcome).toBe("pass");
    // The first body stage should have received the gate feedback
    expect(prompts["test-loop-fix"]).toContain("Gate Feedback");
  });

  it("evaluation artifacts are tracked in state", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentsDir = await setupAgents(dir);

    const { dispatcher: mockDispatcher } = buildMockDispatcher(dir, ["FAIL", "PASS"]);
    const { runLoopCycle } = await import("../src/loop.js");

    const stage = makeStage({ max_iterations: 3 });
    const ctx = makeCtx(dir, agentsDir, stage, mockDispatcher);
    const state = createState("test", "test", "test.yaml", [{ name: stage.name, type: stage.type }], ctx.artifactDir);
    await runLoopCycle(stage, ctx, state);

    expect(state.stages["test-loop"].artifacts).toBeDefined();
    expect(state.stages["test-loop"].artifacts!["evaluation-1"]).toBeDefined();
    expect(state.stages["test-loop"].artifacts!["evaluation-2"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe("Loop schema validation", () => {
  it("valid loop stage parses", async () => {
    const { loadPipeline } = await import("../src/pipeline.js");
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const yaml = `
name: test-pipeline
stages:
  - name: qa-review
    type: loop
    task: "Fix all issues"
    max_iterations: 5
    stages:
      - name: fix
        agent: implementer
    evaluator:
      agent: qa-engineer
`;
    const file = join(dir, "pipeline.yaml");
    await writeFile(file, yaml, "utf-8");
    const pipeline = await loadPipeline(file);
    expect(pipeline.stages.length).toBe(1);
    const stage = pipeline.stages[0] as LoopStage;
    expect(stage.type).toBe("loop");
    expect(stage.max_iterations).toBe(5);
    expect(stage.stages.length).toBe(1);
  });

  it("rejects loop with 0 body stages", async () => {
    const { loadPipeline } = await import("../src/pipeline.js");
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const yaml = `
name: test-pipeline
stages:
  - name: empty-loop
    type: loop
    max_iterations: 3
    stages: []
    evaluator:
      agent: eval
`;
    const file = join(dir, "pipeline.yaml");
    await writeFile(file, yaml, "utf-8");
    await expect(loadPipeline(file)).rejects.toThrow();
  });

  it("rejects loop with max_iterations > 20", async () => {
    const { loadPipeline } = await import("../src/pipeline.js");
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const yaml = `
name: test-pipeline
stages:
  - name: big-loop
    type: loop
    max_iterations: 21
    stages:
      - name: fix
        agent: implementer
    evaluator:
      agent: eval
`;
    const file = join(dir, "pipeline.yaml");
    await writeFile(file, yaml, "utf-8");
    await expect(loadPipeline(file)).rejects.toThrow();
  });

  it("rejects all body stages having skip_first", async () => {
    const { loadPipeline } = await import("../src/pipeline.js");
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const yaml = `
name: test-pipeline
stages:
  - name: all-skip
    type: loop
    max_iterations: 3
    stages:
      - name: fix
        agent: implementer
        skip_first: true
      - name: test
        agent: tester
        skip_first: true
    evaluator:
      agent: eval
`;
    const file = join(dir, "pipeline.yaml");
    await writeFile(file, yaml, "utf-8");
    await expect(loadPipeline(file)).rejects.toThrow("at least one body stage must not have skip_first");
  });

  it("rejects duplicate body stage names", async () => {
    const { loadPipeline } = await import("../src/pipeline.js");
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const yaml = `
name: test-pipeline
stages:
  - name: dup-loop
    type: loop
    max_iterations: 3
    stages:
      - name: fix
        agent: implementer
      - name: fix
        agent: tester
    evaluator:
      agent: eval
`;
    const file = join(dir, "pipeline.yaml");
    await writeFile(file, yaml, "utf-8");
    await expect(loadPipeline(file)).rejects.toThrow("duplicate body stage name");
  });

  it("rejects loop inside parallel group", async () => {
    const { loadPipeline } = await import("../src/pipeline.js");
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const yaml = `
name: test-pipeline
stages:
  - parallel:
      stages:
        - name: agent-a
          type: agent
          agent: foo
        - name: loop-in-parallel
          type: loop
          max_iterations: 3
          stages:
            - name: fix
              agent: implementer
          evaluator:
            agent: eval
`;
    const file = join(dir, "pipeline.yaml");
    await writeFile(file, yaml, "utf-8");
    await expect(loadPipeline(file)).rejects.toThrow("cannot be inside a parallel group");
  });
});
