import { describe, it, expect } from "vitest";
import { describeSubPipelineFailure } from "../src/runner.js";
import type { PipelineState } from "../src/types.js";

function state(stages: Record<string, { status: string; error?: string }>, order?: string[]): PipelineState {
  return {
    runId: "r",
    pipeline: "p",
    project: "proj",
    pipelineFile: "/tmp/p.yaml",
    startedAt: new Date().toISOString(),
    status: "failed",
    stages: stages as unknown as PipelineState["stages"],
    stageOrder: order ?? Object.keys(stages),
    artifactDir: "/tmp",
  };
}

describe("describeSubPipelineFailure", () => {
  it("reports the failing stage with its error", () => {
    const s = state({
      "task-10": { status: "passed" },
      "task-11": { status: "error", error: "Evaluation parse error" },
      "task-12": { status: "pending" },
    });
    const out = describeSubPipelineFailure(s);
    expect(out).toContain("task-11");
    expect(out).toContain("error");
    expect(out).toContain("Evaluation parse error");
  });

  it("reports up to 3 failing/errored stages", () => {
    const s = state({
      a: { status: "passed" },
      b: { status: "failed", error: "first" },
      c: { status: "error", error: "second" },
      d: { status: "failed", error: "third" },
      e: { status: "failed", error: "fourth — should be truncated" },
    });
    const out = describeSubPipelineFailure(s);
    expect(out).toContain("first");
    expect(out).toContain("second");
    expect(out).toContain("third");
    expect(out).not.toContain("fourth");
  });

  it("returns empty string when no failures recorded", () => {
    const s = state({
      a: { status: "passed" },
      b: { status: "skipped" },
    });
    expect(describeSubPipelineFailure(s)).toBe("");
  });

  it("handles failing stages with no error message", () => {
    const s = state({
      a: { status: "failed" },
    });
    const out = describeSubPipelineFailure(s);
    expect(out).toContain("a");
    expect(out).toContain("failed");
  });
});
