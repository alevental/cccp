import { describe, it, expect } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  interpolate,
  resolveTaskBody,
  loadAgentMarkdown,
  buildTaskContext,
  writeSystemPromptFile,
} from "../src/prompt.js";
import { tmpPath } from "./helpers.js";

// ---------------------------------------------------------------------------
// interpolate
// ---------------------------------------------------------------------------

describe("interpolate", () => {
  it("replaces known variables", () => {
    const result = interpolate("{project}/output/{pipeline_name}.md", {
      project: "my-app",
      pipeline_name: "planning",
    });
    expect(result).toBe("my-app/output/planning.md");
  });

  it("leaves unknown variables untouched", () => {
    const result = interpolate("{known}/{unknown}", { known: "yes" });
    expect(result).toBe("yes/{unknown}");
  });

  it("handles strings with no placeholders", () => {
    expect(interpolate("no placeholders here", { foo: "bar" })).toBe(
      "no placeholders here",
    );
  });

  it("handles empty variables map", () => {
    expect(interpolate("{a}/{b}", {})).toBe("{a}/{b}");
  });

  it("replaces multiple occurrences of the same variable", () => {
    expect(interpolate("{x}-{x}-{x}", { x: "1" })).toBe("1-1-1");
  });
});

// ---------------------------------------------------------------------------
// resolveTaskBody
// ---------------------------------------------------------------------------

describe("resolveTaskBody", () => {
  it("returns inline task when set", async () => {
    const result = await resolveTaskBody(
      { task: "Do the thing.", name: "s1" },
      {},
      "fallback",
    );
    expect(result).toBe("Do the thing.");
  });

  it("returns fallback when neither task nor task_file is set", async () => {
    const result = await resolveTaskBody({ name: "s1" }, {}, "fallback text");
    expect(result).toBe("fallback text");
  });

  it("reads task from a file when task_file is set", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const taskFile = join(dir, "task.md");
    await writeFile(taskFile, "# Complex Task\n\nDo many things.", "utf-8");

    const result = await resolveTaskBody(
      { task_file: taskFile, name: "s1" },
      {},
      "fallback",
    );
    expect(result).toBe("# Complex Task\n\nDo many things.");
  });

  it("interpolates variables in task_file path", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const taskFile = join(dir, "task.md");
    await writeFile(taskFile, "Task from file.", "utf-8");

    const result = await resolveTaskBody(
      { task_file: `${dir}/{filename}`, name: "s1" },
      { filename: "task.md" },
      "fallback",
    );
    expect(result).toBe("Task from file.");
  });

  it("throws when both task and task_file are set", async () => {
    await expect(
      resolveTaskBody(
        { task: "inline", task_file: "some/file.md", name: "s1" },
        {},
        "fallback",
      ),
    ).rejects.toThrow(/cannot specify both "task" and "task_file"/);
  });

  it("throws when task_file does not exist", async () => {
    await expect(
      resolveTaskBody(
        { task_file: "/nonexistent/task.md", name: "s1" },
        {},
        "fallback",
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadAgentMarkdown
// ---------------------------------------------------------------------------

describe("loadAgentMarkdown", () => {
  it("reads a flat agent file", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentFile = join(dir, "agent.md");
    await writeFile(agentFile, "# My Agent\n\nDo things.", "utf-8");

    const content = await loadAgentMarkdown(agentFile);
    expect(content).toBe("# My Agent\n\nDo things.");
  });

  it("concatenates agent.md + operation file", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const agentFile = join(dir, "agent.md");
    const opFile = join(dir, "review.md");
    await writeFile(agentFile, "# Architect\n\nBase instructions.", "utf-8");
    await writeFile(opFile, "# Review Operation\n\nReview the code.", "utf-8");

    const content = await loadAgentMarkdown(agentFile, opFile);
    expect(content).toBe(
      "# Architect\n\nBase instructions.\n\n---\n\n# Review Operation\n\nReview the code.",
    );
  });

  it("throws on missing agent file", async () => {
    await expect(loadAgentMarkdown("/nonexistent/agent.md")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildTaskContext
// ---------------------------------------------------------------------------

describe("buildTaskContext", () => {
  it("builds a minimal task context", () => {
    const result = buildTaskContext({ task: "Summarize the project." });
    expect(result).toContain("# Task");
    expect(result).toContain("Summarize the project.");
  });

  it("includes inputs section", () => {
    const result = buildTaskContext({
      task: "Review these files.",
      inputs: ["src/main.ts", "src/utils.ts"],
    });
    expect(result).toContain("## Inputs");
    expect(result).toContain("- src/main.ts");
    expect(result).toContain("- src/utils.ts");
  });

  it("includes output section", () => {
    const result = buildTaskContext({
      task: "Write a summary.",
      output: "docs/summary.md",
    });
    expect(result).toContain("## Output");
    expect(result).toContain("docs/summary.md");
  });

  it("includes contract path", () => {
    const result = buildTaskContext({
      task: "Generate the plan.",
      contractPath: "contracts/planning.md",
    });
    expect(result).toContain("## Contract");
    expect(result).toContain("contracts/planning.md");
  });

  it("includes previous evaluation on retry", () => {
    const result = buildTaskContext({
      task: "Fix the issues.",
      previousEvaluation: "evals/attempt-1.md",
      iteration: 2,
      maxIterations: 3,
    });
    expect(result).toContain("## Previous Evaluation");
    expect(result).toContain("evals/attempt-1.md");
    expect(result).toContain("## Iteration");
    expect(result).toContain("iteration 2 of 3");
  });

  it("includes extra context", () => {
    const result = buildTaskContext({
      task: "Do it.",
      extra: { branch: "feature/test", sprint: "3" },
    });
    expect(result).toContain("## Context");
    expect(result).toContain("**branch**: feature/test");
    expect(result).toContain("**sprint**: 3");
  });

  it("includes plan file section", () => {
    const result = buildTaskContext({
      task: "Implement the feature.",
      planFile: "/path/to/plan.md",
    });
    expect(result).toContain("## Plan");
    expect(result).toContain("/path/to/plan.md");
  });

  it("includes contract template section", () => {
    const result = buildTaskContext({
      task: "Write the contract.",
      contractTemplate: "/path/to/template.md",
    });
    expect(result).toContain("## Contract Template");
    expect(result).toContain("/path/to/template.md");
  });

  it("includes guidance section", () => {
    const result = buildTaskContext({
      task: "Refactor the module.",
      guidance: "Must handle backward compat",
    });
    expect(result).toContain("## Guidance");
    expect(result).toContain("Must handle backward compat");
  });

  it("includes deliverable info section", () => {
    const result = buildTaskContext({
      task: "Write the contract criteria.",
      deliverableInfo: "The generator will produce: output.ts",
    });
    expect(result).toContain("## Deliverable");
    expect(result).toContain("The generator will produce: output.ts");
  });

  it("includes evaluator format when evaluatorFormat is true", () => {
    const result = buildTaskContext({
      task: "Evaluate the deliverable.",
      evaluatorFormat: true,
    });
    expect(result).toContain("## Evaluation Format");
    expect(result).toContain("### Overall: PASS");
    expect(result).toContain("### Overall: FAIL");
    expect(result).toContain("Criterion");
  });

  it("includes ground truth path section", () => {
    const result = buildTaskContext({
      task: "Evaluate the output.",
      groundTruthPath: "/path/to/expected.md",
    });
    expect(result).toContain("## Ground Truth");
    expect(result).toContain("/path/to/expected.md");
  });

  it("omits evaluator format when evaluatorFormat is false or absent", () => {
    const result = buildTaskContext({ task: "Generate output." });
    expect(result).not.toContain("Evaluation Format");
    expect(result).not.toContain("### Overall:");
  });
});

// ---------------------------------------------------------------------------
// writeSystemPromptFile
// ---------------------------------------------------------------------------

describe("writeSystemPromptFile", () => {
  it("writes markdown to a temp file and returns its path", async () => {
    const content = "# Agent\n\nDo things.";
    const filePath = await writeSystemPromptFile(content);

    expect(filePath).toContain("cccp-agent-");
    const read = await readFile(filePath, "utf-8");
    expect(read).toBe(content);
  });
});
