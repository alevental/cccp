import { describe, it, expect } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadPipeline } from "../src/pipeline.js";

function tmpPath() {
  return join(tmpdir(), `cccpr-test-${randomUUID()}`);
}

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
    generator:
      agent: agents/writer.md
    evaluator:
      agent: agents/reviewer.md
    contract:
      deliverable: reviewed.md
      criteria:
        - name: completeness
          description: All sections are present
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
    generator:
      agent: gen.md
    evaluator:
      agent: eval.md
    contract:
      deliverable: out.md
      criteria:
        - name: check
          description: check it
      max_iterations: 0
`);

    await expect(loadPipeline(file)).rejects.toThrow(
      /Pipeline validation failed/,
    );
  });

  it("rejects a PGE stage with no criteria", async () => {
    const file = await writeTmpYaml(`
name: no-criteria
stages:
  - name: broken
    type: pge
    generator:
      agent: gen.md
    evaluator:
      agent: eval.md
    contract:
      deliverable: out.md
      criteria: []
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
      criteria:
        - name: accuracy
          description: Must be accurate
      max_iterations: 5
      template: custom-contract.md
    on_fail: human_gate
`);

    const pipeline = await loadPipeline(file);
    const stage = pipeline.stages[0];
    expect(stage.type).toBe("pge");
    if (stage.type === "pge") {
      expect(stage.generator.operation).toBe("detailed");
      expect(stage.generator.mcp_profile).toBe("research");
      expect(stage.generator.allowed_tools).toEqual(["Read", "Grep"]);
      expect(stage.contract.max_iterations).toBe(5);
      expect(stage.contract.template).toBe("custom-contract.md");
      expect(stage.on_fail).toBe("human_gate");
    }
  });
});
