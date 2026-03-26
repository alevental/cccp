import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { generateContract } from "../src/contract.js";
import type { PgeStage, RunContext, Pipeline } from "../src/types.js";

function tmpPath() {
  return join(tmpdir(), `cccpr-test-${randomUUID()}`);
}

// ---------------------------------------------------------------------------
// Contract generation
// ---------------------------------------------------------------------------

describe("generateContract", () => {
  it("generates a contract with criteria table", async () => {
    const contract = await generateContract({
      stageName: "architecture-design",
      deliverable: "docs/architecture.md",
      criteria: [
        { name: "modularity", description: "System is decomposed into independent modules" },
        { name: "scalability", description: "Design supports 10x traffic growth" },
      ],
      maxIterations: 3,
    });

    expect(contract).toContain("## Contract: architecture-design");
    expect(contract).toContain("docs/architecture.md");
    expect(contract).toContain("modularity");
    expect(contract).toContain("scalability");
    expect(contract).toContain("10x traffic growth");
    expect(contract).toContain("Max Iterations: 3");
    expect(contract).toContain("ALL criteria must pass");
  });

  it("numbers criteria rows correctly", async () => {
    const contract = await generateContract({
      stageName: "test",
      deliverable: "out.md",
      criteria: [
        { name: "a", description: "first" },
        { name: "b", description: "second" },
        { name: "c", description: "third" },
      ],
      maxIterations: 2,
    });

    expect(contract).toContain("| 1 | a |");
    expect(contract).toContain("| 2 | b |");
    expect(contract).toContain("| 3 | c |");
  });

  it("uses a custom template when provided", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const tpl = join(dir, "custom.md");
    await writeFile(
      tpl,
      "Stage: {stage_name}\nOutput: {deliverable}\n{criteria_table}\nRetries: {max_iterations}",
      "utf-8",
    );

    const contract = await generateContract({
      stageName: "custom-stage",
      deliverable: "custom-output.md",
      criteria: [{ name: "check", description: "verify it" }],
      maxIterations: 5,
      templatePath: tpl,
    });

    expect(contract).toContain("Stage: custom-stage");
    expect(contract).toContain("Output: custom-output.md");
    expect(contract).toContain("| 1 | check | verify it |");
    expect(contract).toContain("Retries: 5");
  });
});

// ---------------------------------------------------------------------------
// PGE dry-run
// ---------------------------------------------------------------------------

describe("PGE dry-run", () => {
  it("produces dry-run output for a PGE stage via runner", async () => {
    // We test dry-run by importing runPgeCycle and verifying it doesn't
    // try to read agent files or spawn processes.
    const { runPgeCycle } = await import("../src/pge.js");

    const dir = tmpPath();
    await mkdir(dir, { recursive: true });

    const stage: PgeStage = {
      name: "test-pge",
      type: "pge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "output.md",
        criteria: [{ name: "exists", description: "Output file exists" }],
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

    const result = await runPgeCycle(stage, ctx);
    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(0);
    expect(result.maxIterations).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PGE iteration logic (with mock dispatch)
// ---------------------------------------------------------------------------

describe("PGE iteration logic", () => {
  it("passes on first iteration when evaluator returns PASS", async () => {
    // Mock agent.ts dispatch to:
    // 1. Write a deliverable file (generator)
    // 2. Write an evaluation file with PASS (evaluator)
    const agentModule = await import("../src/agent.js");

    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "gen.md"), "# Generator\nGenerate things.", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator\nEvaluate things.", "utf-8");

    let dispatchCount = 0;
    const originalDispatch = agentModule.dispatchAgent;

    vi.spyOn(agentModule, "dispatchAgent").mockImplementation(async (opts) => {
      dispatchCount++;
      if (opts.expectedOutput) {
        await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
        // Generator dispatch writes a deliverable
        if (dispatchCount === 1) {
          await mkdir(join(dir, "artifacts", "test-pge"), { recursive: true }).catch(() => {});
          await writeFile(opts.expectedOutput, "# Generated Output\n\nSome content.", "utf-8");
        }
        // Evaluator dispatch writes a PASS evaluation
        if (dispatchCount === 2) {
          await writeFile(opts.expectedOutput, "### Overall: PASS\n", "utf-8");
        }
      }
      return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
    });

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "test-pge",
      type: "pge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/test-pge/output.md",
        criteria: [{ name: "exists", description: "Output exists" }],
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
    };

    const result = await runPgeCycle(stage, ctx);

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(1);
    expect(dispatchCount).toBe(2); // 1 generator + 1 evaluator

    vi.restoreAllMocks();
  });

  it("retries on FAIL then passes", async () => {
    const agentModule = await import("../src/agent.js");

    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    let dispatchCount = 0;

    vi.spyOn(agentModule, "dispatchAgent").mockImplementation(async (opts) => {
      dispatchCount++;
      if (opts.expectedOutput) {
        await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});

        // Dispatch 1: generator (iter 1)
        // Dispatch 2: evaluator (iter 1) — FAIL
        // Dispatch 3: generator (iter 2)
        // Dispatch 4: evaluator (iter 2) — PASS
        if (dispatchCount === 1 || dispatchCount === 3) {
          await writeFile(opts.expectedOutput, "# Output", "utf-8");
        } else if (dispatchCount === 2) {
          await writeFile(opts.expectedOutput, "### Overall: FAIL\n\n### Iteration Guidance\n1. Fix it\n", "utf-8");
        } else if (dispatchCount === 4) {
          await writeFile(opts.expectedOutput, "### Overall: PASS\n", "utf-8");
        }
      }
      return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
    });

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "retry-test",
      type: "pge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/retry-test/output.md",
        criteria: [{ name: "quality", description: "Must be good" }],
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
    };

    const result = await runPgeCycle(stage, ctx);

    expect(result.outcome).toBe("pass");
    expect(result.iterations).toBe(2);
    expect(dispatchCount).toBe(4); // 2 generators + 2 evaluators

    vi.restoreAllMocks();
  });

  it("returns fail after exhausting max iterations", async () => {
    const agentModule = await import("../src/agent.js");

    const dir = tmpPath();
    const artifactDir = join(dir, "artifacts");
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "gen.md"), "# Generator", "utf-8");
    await writeFile(join(agentsDir, "eval.md"), "# Evaluator", "utf-8");

    let dispatchCount = 0;

    vi.spyOn(agentModule, "dispatchAgent").mockImplementation(async (opts) => {
      dispatchCount++;
      if (opts.expectedOutput) {
        await mkdir(join(opts.expectedOutput, ".."), { recursive: true }).catch(() => {});
        // All generators write output, all evaluators write FAIL
        if (dispatchCount % 2 === 1) {
          await writeFile(opts.expectedOutput, "# Output", "utf-8");
        } else {
          await writeFile(opts.expectedOutput, "### Overall: FAIL\n", "utf-8");
        }
      }
      return { exitCode: 0, outputPath: opts.expectedOutput, outputExists: true, durationMs: 100 };
    });

    const { runPgeCycle } = await import("../src/pge.js");

    const stage: PgeStage = {
      name: "exhaust-test",
      type: "pge",
      generator: { agent: "agents/gen.md" },
      evaluator: { agent: "agents/eval.md" },
      contract: {
        deliverable: "artifacts/exhaust-test/output.md",
        criteria: [{ name: "impossible", description: "Can never pass" }],
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
    };

    const result = await runPgeCycle(stage, ctx);

    expect(result.outcome).toBe("fail");
    expect(result.iterations).toBe(2);
    expect(dispatchCount).toBe(4); // 2 generators + 2 evaluators

    vi.restoreAllMocks();
  });
});
