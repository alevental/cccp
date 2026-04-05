import { describe, it, expect } from "vitest";
import { isAgentActive } from "../src/tui/components.js";
import type { StageState } from "../src/types.js";

function makeStage(overrides: Partial<StageState> & { name: string }): StageState {
  return { type: "agent", status: "pending", ...overrides };
}

describe("isAgentActive", () => {
  it("matches agent key by stage name prefix for simple agent stages", () => {
    const stages: Record<string, StageState> = {
      research: makeStage({ name: "research", status: "in_progress" }),
    };
    expect(isAgentActive("research", stages)).toBe(true);
    expect(isAgentActive("research-sub", stages)).toBe(true);
    expect(isAgentActive("other", stages)).toBe(false);
  });

  it("does not match completed stages", () => {
    const stages: Record<string, StageState> = {
      research: makeStage({ name: "research", status: "passed" }),
    };
    expect(isAgentActive("research", stages)).toBe(false);
  });

  it("only matches current PGE phase agent, not completed phases", () => {
    const stages: Record<string, StageState> = {
      review: makeStage({
        name: "review",
        type: "pge",
        status: "in_progress",
        pgeStep: "planner_dispatched", // planner done, contract running
      }),
    };
    // Planner is done — should NOT be active.
    expect(isAgentActive("review-planner", stages)).toBe(false);
    // Contract is currently running.
    expect(isAgentActive("review-contract", stages)).toBe(true);
    // Generator has not started yet.
    expect(isAgentActive("review-generator", stages)).toBe(false);
  });

  it("matches generator when contract is done", () => {
    const stages: Record<string, StageState> = {
      review: makeStage({
        name: "review",
        type: "pge",
        status: "in_progress",
        pgeStep: "contract_dispatched",
      }),
    };
    expect(isAgentActive("review-contract", stages)).toBe(false);
    expect(isAgentActive("review-generator", stages)).toBe(true);
  });

  it("matches evaluator when generator is done", () => {
    const stages: Record<string, StageState> = {
      review: makeStage({
        name: "review",
        type: "pge",
        status: "in_progress",
        pgeStep: "generator_dispatched",
      }),
    };
    expect(isAgentActive("review-generator", stages)).toBe(false);
    expect(isAgentActive("review-evaluator", stages)).toBe(true);
  });

  it("matches generator on retry (after routed)", () => {
    const stages: Record<string, StageState> = {
      review: makeStage({
        name: "review",
        type: "pge",
        status: "in_progress",
        pgeStep: "routed", // FAIL, retrying
      }),
    };
    expect(isAgentActive("review-evaluator", stages)).toBe(false);
    expect(isAgentActive("review-generator", stages)).toBe(true);
  });

  it("matches planner when PGE stage just started (no pgeStep yet)", () => {
    const stages: Record<string, StageState> = {
      review: makeStage({
        name: "review",
        type: "pge",
        status: "in_progress",
        // pgeStep is undefined — planner is the first dispatch
      }),
    };
    expect(isAgentActive("review-planner", stages)).toBe(true);
    expect(isAgentActive("review-generator", stages)).toBe(false);
  });

  it("matches PGE agents in sub-pipeline children", () => {
    const stages: Record<string, StageState> = {
      "sprint-1": makeStage({
        name: "sprint-1",
        type: "pipeline",
        status: "in_progress",
        children: {
          runId: "r1",
          pipeline: "sprint",
          project: "p",
          pipelineFile: "f",
          startedAt: "",
          status: "running",
          stageOrder: ["code-review"],
          stages: {
            "code-review": makeStage({
              name: "code-review",
              type: "pge",
              status: "in_progress",
              pgeStep: "contract_dispatched", // generator running
            }),
          },
          artifactDir: "/tmp",
        },
      }),
    };
    expect(isAgentActive("code-review-planner", stages)).toBe(false);
    expect(isAgentActive("code-review-contract", stages)).toBe(false);
    expect(isAgentActive("code-review-generator", stages)).toBe(true);
    expect(isAgentActive("code-review-evaluator", stages)).toBe(false);
  });
});
