import { describe, it, expect } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadPipeline } from "../src/pipeline.js";
import { tmpPath } from "./helpers.js";

async function writeTmpYaml(content: string): Promise<string> {
  const dir = tmpPath();
  await mkdir(dir, { recursive: true });
  const file = join(dir, "pipeline.yaml");
  await writeFile(file, content, "utf-8");
  return file;
}

describe("loadPipeline", () => {
  it("loads a valid single-agent pipeline", async () => {
    const file = await writeTmpYaml(`
name: test-pipeline
description: A test
stages:
  - name: step-one
    type: agent
    agent: agents/my-agent.md
    output: output.md
`);

    const pipeline = await loadPipeline(file);
    expect(pipeline.name).toBe("test-pipeline");
    expect(pipeline.stages).toHaveLength(1);
    expect(pipeline.stages[0].type).toBe("agent");
    expect(pipeline.stages[0].name).toBe("step-one");
  });

  it("loads a pipeline with all three stage types", async () => {
    const file = await writeTmpYaml(`
name: full-pipeline
stages:
  - name: generate
    type: agent
    agent: agents/writer.md
    output: draft.md

  - name: review
    type: pge
    planner:
      agent: agents/planner.md
    generator:
      agent: agents/writer.md
    evaluator:
      agent: agents/reviewer.md
    contract:
      deliverable: reviewed.md
      max_iterations: 3

  - name: approve
    type: human_gate
    prompt: "Please review the output."
    artifacts:
      - reviewed.md
`);

    const pipeline = await loadPipeline(file);
    expect(pipeline.stages).toHaveLength(3);
    expect(pipeline.stages[0].type).toBe("agent");
    expect(pipeline.stages[1].type).toBe("pge");
    expect(pipeline.stages[2].type).toBe("human_gate");
  });

  it("validates pipeline-level variables", async () => {
    const file = await writeTmpYaml(`
name: vars-test
variables:
  env: production
  region: us-east-1
stages:
  - name: deploy
    type: agent
    agent: agents/deployer.md
`);

    const pipeline = await loadPipeline(file);
    expect(pipeline.variables).toEqual({
      env: "production",
      region: "us-east-1",
    });
  });

  it("rejects a pipeline with no stages", async () => {
    const file = await writeTmpYaml(`
name: empty
stages: []
`);

    await expect(loadPipeline(file)).rejects.toThrow(
      /Pipeline validation failed/,
    );
  });

  it("rejects a stage with an unknown type", async () => {
    const file = await writeTmpYaml(`
name: bad-type
stages:
  - name: oops
    type: magic
    agent: foo.md
`);

    await expect(loadPipeline(file)).rejects.toThrow(
      /Pipeline validation failed/,
    );
  });

  it("rejects a PGE stage with zero max_iterations", async () => {
    const file = await writeTmpYaml(`
name: bad-pge
stages:
  - name: broken
    type: pge
    planner:
      agent: plan.md
    generator:
      agent: gen.md
    evaluator:
      agent: eval.md
    contract:
      deliverable: out.md
      max_iterations: 0
`);

    await expect(loadPipeline(file)).rejects.toThrow(
      /Pipeline validation failed/,
    );
  });

  it("rejects PGE stage without planner", async () => {
    const file = await writeTmpYaml(`
name: no-planner
stages:
  - name: broken
    type: pge
    generator:
      agent: gen.md
    evaluator:
      agent: eval.md
    contract:
      deliverable: out.md
      max_iterations: 3
`);

    await expect(loadPipeline(file)).rejects.toThrow(
      /Pipeline validation failed/,
    );
  });

  it("throws on missing file", async () => {
    await expect(loadPipeline("/nonexistent/pipeline.yaml")).rejects.toThrow(
      /Cannot read pipeline file/,
    );
  });

  it("throws on invalid YAML", async () => {
    const file = await writeTmpYaml(`
name: bad
stages:
  - name: [[[invalid
`);

    await expect(loadPipeline(file)).rejects.toThrow();
  });

  it("parses optional PGE fields", async () => {
    const file = await writeTmpYaml(`
name: pge-options
stages:
  - name: careful
    type: pge
    planner:
      agent: plan.md
      operation: outline
      mcp_profile: research
    generator:
      agent: gen.md
      operation: detailed
      mcp_profile: research
      allowed_tools:
        - Read
        - Grep
    evaluator:
      agent: eval.md
      mcp_profile: base
    contract:
      deliverable: output.md
      guidance: Focus on correctness and completeness
      max_iterations: 5
      template: custom-contract.md
    on_fail: human_gate
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("pge");
    if (stage.type === "pge") {
      expect(stage.planner.agent).toBe("plan.md");
      expect(stage.planner.operation).toBe("outline");
      expect(stage.generator.operation).toBe("detailed");
      expect(stage.generator.mcp_profile).toBe("research");
      expect(stage.generator.allowed_tools).toEqual(["Read", "Grep"]);
      expect(stage.contract.max_iterations).toBe(5);
      expect(stage.contract.template).toBe("custom-contract.md");
      expect(stage.contract.guidance).toBe(
        "Focus on correctness and completeness",
      );
      expect(stage.on_fail).toBe("human_gate");
    }
  });

  it("validates PGE stage with planner and guidance", async () => {
    const file = await writeTmpYaml(`
name: planner-guidance
stages:
  - name: build-feature
    type: pge
    planner:
      agent: agents/planner.md
    generator:
      agent: agents/writer.md
    evaluator:
      agent: agents/reviewer.md
    contract:
      deliverable: feature.md
      guidance: Ensure the feature covers all edge cases
      max_iterations: 3
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("pge");
    if (stage.type === "pge") {
      expect(stage.planner.agent).toBe("agents/planner.md");
      expect(stage.contract.guidance).toBe(
        "Ensure the feature covers all edge cases",
      );
      expect(stage.contract.deliverable).toBe("feature.md");
      expect(stage.contract.max_iterations).toBe(3);
      // criteria should not exist on the contract
      expect(stage.contract).not.toHaveProperty("criteria");
    }
  });

  it("validates PGE stage with plan and inputs", async () => {
    const file = await writeTmpYaml(`
name: plan-inputs
stages:
  - name: implement
    type: pge
    plan: plans/feature-plan.md
    inputs:
      - src/existing-module.ts
      - docs/spec.md
    planner:
      agent: agents/planner.md
      inputs:
        - docs/requirements.md
    generator:
      agent: agents/writer.md
      inputs:
        - src/helpers.ts
    evaluator:
      agent: agents/reviewer.md
    contract:
      deliverable: output.md
      max_iterations: 4
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("pge");
    if (stage.type === "pge") {
      expect(stage.plan).toBe("plans/feature-plan.md");
      expect(stage.inputs).toEqual([
        "src/existing-module.ts",
        "docs/spec.md",
      ]);
      expect(stage.planner.inputs).toEqual(["docs/requirements.md"]);
      expect(stage.generator.inputs).toEqual(["src/helpers.ts"]);
      expect(stage.evaluator.inputs).toBeUndefined();
    }
  });

  it("loads a valid autoresearch stage", async () => {
    const file = await writeTmpYaml(`
name: autoresearch-test
stages:
  - name: tune-prompt
    type: autoresearch
    task: Optimize the prompt
    artifact: prompt.md
    ground_truth: expected.md
    output: actual.md
    adjuster:
      agent: agents/adjuster.md
    executor:
      agent: agents/executor.md
    evaluator:
      agent: agents/eval.md
    max_iterations: 5
    on_fail: stop
`);

    const pipeline = await loadPipeline(file);
    expect(pipeline.stages).toHaveLength(1);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("autoresearch");
    if (stage.type === "autoresearch") {
      expect(stage.artifact).toBe("prompt.md");
      expect(stage.ground_truth).toBe("expected.md");
      expect(stage.output).toBe("actual.md");
      expect(stage.adjuster.agent).toBe("agents/adjuster.md");
      expect(stage.executor.agent).toBe("agents/executor.md");
      expect(stage.evaluator.agent).toBe("agents/eval.md");
      expect(stage.max_iterations).toBe(5);
      expect(stage.on_fail).toBe("stop");
    }
  });

  it("loads autoresearch stage with no max_iterations (unlimited)", async () => {
    const file = await writeTmpYaml(`
name: unlimited-ar
stages:
  - name: tune
    type: autoresearch
    artifact: prompt.md
    ground_truth: expected.md
    output: actual.md
    adjuster:
      agent: adj.md
    executor:
      agent: exec.md
    evaluator:
      agent: eval.md
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("autoresearch");
    if (stage.type === "autoresearch") {
      expect(stage.max_iterations).toBeUndefined();
    }
  });

  it("rejects autoresearch stage missing required fields", async () => {
    const file = await writeTmpYaml(`
name: bad-ar
stages:
  - name: broken
    type: autoresearch
    artifact: prompt.md
    adjuster:
      agent: adj.md
    executor:
      agent: exec.md
    evaluator:
      agent: eval.md
`);

    await expect(loadPipeline(file)).rejects.toThrow(
      /Pipeline validation failed/,
    );
  });

  it("accepts task_file on agent stage", async () => {
    const file = await writeTmpYaml(`
name: task-file-test
stages:
  - name: from-file
    type: agent
    agent: agents/writer.md
    task_file: tasks/complex-task.md
    output: output.md
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("agent");
    if (stage.type === "agent") {
      expect(stage.task_file).toBe("tasks/complex-task.md");
      expect(stage.task).toBeUndefined();
    }
  });

  it("accepts task_file on PGE stage", async () => {
    const file = await writeTmpYaml(`
name: pge-task-file
stages:
  - name: build
    type: pge
    task_file: tasks/build-spec.md
    planner:
      agent: plan.md
    generator:
      agent: gen.md
    evaluator:
      agent: eval.md
    contract:
      deliverable: out.md
      max_iterations: 3
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("pge");
    if (stage.type === "pge") {
      expect(stage.task_file).toBe("tasks/build-spec.md");
    }
  });

  it("validates PGE stage with per-agent inputs", async () => {
    const file = await writeTmpYaml(`
name: per-agent-inputs
stages:
  - name: review-cycle
    type: pge
    planner:
      agent: agents/planner.md
      inputs:
        - docs/plan-context.md
        - docs/architecture.md
    generator:
      agent: agents/writer.md
      inputs:
        - src/module-a.ts
        - src/module-b.ts
    evaluator:
      agent: agents/reviewer.md
      inputs:
        - docs/review-checklist.md
    contract:
      deliverable: reviewed-output.md
      max_iterations: 2
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("pge");
    if (stage.type === "pge") {
      expect(stage.planner.inputs).toEqual([
        "docs/plan-context.md",
        "docs/architecture.md",
      ]);
      expect(stage.generator.inputs).toEqual([
        "src/module-a.ts",
        "src/module-b.ts",
      ]);
      expect(stage.evaluator.inputs).toEqual(["docs/review-checklist.md"]);
    }
  });

  it("accepts a pipeline stage with file and variables", async () => {
    const file = await writeTmpYaml(`
name: composition-test
stages:
  - name: run-sub
    type: pipeline
    file: pipelines/sub-pipeline.yaml
    variables:
      sprint: "3"
    artifact_dir: "{artifact_dir}/sub"
    on_fail: skip
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("pipeline");
    if (stage.type === "pipeline") {
      expect(stage.file).toBe("pipelines/sub-pipeline.yaml");
      expect(stage.variables).toEqual({ sprint: "3" });
      expect(stage.artifact_dir).toBe("{artifact_dir}/sub");
      expect(stage.on_fail).toBe("skip");
    }
  });

  it("rejects a pipeline stage without file", async () => {
    const file = await writeTmpYaml(`
name: bad-pipeline-stage
stages:
  - name: missing-file
    type: pipeline
`);

    await expect(loadPipeline(file)).rejects.toThrow(/Pipeline validation failed/);
  });

  it("accepts human_review on agent stages", async () => {
    const file = await writeTmpYaml(`
name: human-review-agent
stages:
  - name: write-draft
    type: agent
    agent: agents/writer.md
    output: draft.md
    human_review: true
`);

    const pipeline = await loadPipeline(file);
    expect(pipeline.stages).toHaveLength(1);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("agent");
    if (stage.type === "agent") {
      expect(stage.human_review).toBe(true);
    }
  });

  it("accepts human_review on pge stages", async () => {
    const file = await writeTmpYaml(`
name: human-review-pge
stages:
  - name: build-feature
    type: pge
    human_review: true
    planner:
      agent: agents/planner.md
    generator:
      agent: agents/writer.md
    evaluator:
      agent: agents/reviewer.md
    contract:
      deliverable: feature.md
      max_iterations: 3
`);

    const pipeline = await loadPipeline(file);
    expect(pipeline.stages).toHaveLength(1);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("pge");
    if (stage.type === "pge") {
      expect(stage.human_review).toBe(true);
    }
  });

  it("defaults human_review to undefined when not specified", async () => {
    const file = await writeTmpYaml(`
name: no-review
stages:
  - name: quick-task
    type: agent
    agent: agents/writer.md
    output: out.md
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("agent");
    if (stage.type === "agent") {
      expect(stage.human_review).toBeUndefined();
    }
  });

  it("accepts model and effort on agent stage", async () => {
    const file = await writeTmpYaml(`
name: model-effort-agent
stages:
  - name: quick-task
    type: agent
    agent: agents/analyst.md
    model: haiku
    effort: low
    output: out.md
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("agent");
    if (stage.type === "agent") {
      expect(stage.model).toBe("haiku");
      expect(stage.effort).toBe("low");
    }
  });

  it("accepts model and effort at pipeline level", async () => {
    const file = await writeTmpYaml(`
name: pipeline-defaults
model: sonnet
effort: high
stages:
  - name: task
    type: agent
    agent: agents/writer.md
    output: out.md
`);

    const pipeline = await loadPipeline(file);
    expect(pipeline.model).toBe("sonnet");
    expect(pipeline.effort).toBe("high");
  });

  it("accepts model and effort on PGE stage and per-agent configs", async () => {
    const file = await writeTmpYaml(`
name: pge-model-effort
stages:
  - name: spec-writing
    type: pge
    model: opus
    effort: high
    planner:
      agent: agents/planner.md
      effort: medium
    generator:
      agent: agents/gen.md
      model: sonnet
    evaluator:
      agent: agents/eval.md
    contract:
      deliverable: spec.md
      max_iterations: 3
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("pge");
    if (stage.type === "pge") {
      expect(stage.model).toBe("opus");
      expect(stage.effort).toBe("high");
      expect(stage.planner.effort).toBe("medium");
      expect(stage.planner.model).toBeUndefined();
      expect(stage.generator.model).toBe("sonnet");
      expect(stage.generator.effort).toBeUndefined();
      expect(stage.evaluator.model).toBeUndefined();
      expect(stage.evaluator.effort).toBeUndefined();
    }
  });

  it("accepts model and effort on autoresearch stage", async () => {
    const file = await writeTmpYaml(`
name: autoresearch-model-effort
stages:
  - name: tune
    type: autoresearch
    model: opus
    effort: high
    artifact: prompt.md
    ground_truth: expected.md
    output: actual.md
    adjuster:
      agent: agents/adjuster.md
      effort: medium
    executor:
      agent: agents/executor.md
    evaluator:
      agent: agents/eval.md
    max_iterations: 5
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("autoresearch");
    if (stage.type === "autoresearch") {
      expect(stage.model).toBe("opus");
      expect(stage.effort).toBe("high");
      expect(stage.adjuster.effort).toBe("medium");
    }
  });

  it("rejects invalid effort value", async () => {
    const file = await writeTmpYaml(`
name: bad-effort
stages:
  - name: task
    type: agent
    agent: agents/writer.md
    effort: turbo
    output: out.md
`);

    await expect(loadPipeline(file)).rejects.toThrow("Pipeline validation failed");
  });

  it("accepts phase_defaults at pipeline level", async () => {
    const file = await writeTmpYaml(`
name: phase-defaults
effort: high
phase_defaults:
  planner:
    effort: medium
  evaluator:
    model: haiku
    effort: low
  adjuster:
    effort: medium
stages:
  - name: task
    type: agent
    agent: agents/writer.md
    output: out.md
`);

    const pipeline = await loadPipeline(file);
    expect(pipeline.phase_defaults?.planner?.effort).toBe("medium");
    expect(pipeline.phase_defaults?.evaluator?.model).toBe("haiku");
    expect(pipeline.phase_defaults?.evaluator?.effort).toBe("low");
    expect(pipeline.phase_defaults?.adjuster?.effort).toBe("medium");
    expect(pipeline.phase_defaults?.generator).toBeUndefined();
    expect(pipeline.phase_defaults?.executor).toBeUndefined();
  });

  it("rejects invalid effort in phase_defaults", async () => {
    const file = await writeTmpYaml(`
name: bad-phase-effort
phase_defaults:
  planner:
    effort: extreme
stages:
  - name: task
    type: agent
    agent: agents/writer.md
`);

    await expect(loadPipeline(file)).rejects.toThrow("Pipeline validation failed");
  });
});
