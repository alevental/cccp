import { describe, it, expect } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  interpolate,
  loadAgentMarkdown,
  buildTaskContext,
  writeSystemPromptFile,
} from "../src/prompt.js";

function tmpPath() {
  return join(tmpdir(), `cccp-test-${randomUUID()}`);
}

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
