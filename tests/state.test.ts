import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { closeDatabase } from "../src/db.js";
import {
  createState,
  loadState,
  saveState,
  updateStageStatus,
  updatePgeProgress,
  setStageArtifact,
  finishPipeline,
  findResumePoint,
  discoverRuns,
} from "../src/state.js";
import { tmpProjectDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// createState
// ---------------------------------------------------------------------------

describe("createState", () => {
  it("creates a state with all stages pending", () => {
    const state = createState("planning", "my-app", "planning.yaml", [
      { name: "scoping", type: "pge" },
      { name: "design", type: "pge" },
      { name: "approval", type: "human_gate" },
    ], "/tmp/test-artifacts");

    expect(state.pipeline).toBe("planning");
    expect(state.project).toBe("my-app");
    expect(state.status).toBe("running");
    expect(state.stageOrder).toEqual(["scoping", "design", "approval"]);
    expect(state.stages.scoping.status).toBe("pending");
    expect(state.stages.design.status).toBe("pending");
    expect(state.stages.approval.status).toBe("pending");
    expect(state.runId).toBeDefined();
    expect(state.startedAt).toBeDefined();
  });

  it("accepts projectDir parameter", () => {
    const state = createState("test", "proj", "t.yaml", [
      { name: "s1", type: "agent" },
    ], "/tmp/test-artifacts", "/my/project");

    expect(state.projectDir).toBe("/my/project");
  });
});

// ---------------------------------------------------------------------------
// save / load round-trip (SQLite backed)
// ---------------------------------------------------------------------------

describe("saveState / loadState", () => {
  it("persists and reloads state via SQLite", async () => {
    const projectDir = tmpProjectDir();
    const artifactDir = join(projectDir, "docs/projects/proj/test");

    const state = createState("test", "proj", "test.yaml", [
      { name: "step1", type: "agent" },
    ], artifactDir, projectDir);
    state.stages.step1.status = "passed";

    await saveState(state);

    const loaded = await loadState(state.runId, projectDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.pipeline).toBe("test");
    expect(loaded!.stages.step1.status).toBe("passed");
    expect(loaded!.runId).toBe(state.runId);

    closeDatabase(projectDir);
  });

  it("returns null for non-existent artifact dir", async () => {
    const projectDir = tmpProjectDir();
    const loaded = await loadState("nonexistent-run-id", projectDir);
    expect(loaded).toBeNull();
    closeDatabase(projectDir);
  });

  it("updates existing run on subsequent saves", async () => {
    const projectDir = tmpProjectDir();
    const artifactDir = join(projectDir, "docs/projects/proj/test");

    const state = createState("test", "proj", "test.yaml", [
      { name: "s1", type: "agent" },
    ], artifactDir, projectDir);

    await saveState(state);

    state.stages.s1.status = "passed";
    state.status = "passed";
    state.completedAt = new Date().toISOString();
    await saveState(state);

    const loaded = await loadState(state.runId, projectDir);
    expect(loaded!.status).toBe("passed");
    expect(loaded!.stages.s1.status).toBe("passed");
    expect(loaded!.completedAt).toBeDefined();

    closeDatabase(projectDir);
  });
});

// ---------------------------------------------------------------------------
// State update helpers
// ---------------------------------------------------------------------------

describe("updateStageStatus", () => {
  it("updates stage status and extra fields", () => {
    const state = createState("test", "proj", "t.yaml", [
      { name: "s1", type: "agent" },
    ], "/tmp/test-artifacts");

    updateStageStatus(state, "s1", "passed", {
      durationMs: 1234,
    });

    expect(state.stages.s1.status).toBe("passed");
    expect(state.stages.s1.durationMs).toBe(1234);
  });

  it("ignores unknown stage names", () => {
    const state = createState("test", "proj", "t.yaml", [
      { name: "s1", type: "agent" },
    ], "/tmp/test-artifacts");

    updateStageStatus(state, "nonexistent", "passed");
  });
});

describe("updatePgeProgress", () => {
  it("tracks iteration and step", () => {
    const state = createState("test", "proj", "t.yaml", [
      { name: "pge1", type: "pge" },
    ], "/tmp/test-artifacts");

    updatePgeProgress(state, "pge1", 2, "generator_dispatched");

    expect(state.stages.pge1.iteration).toBe(2);
    expect(state.stages.pge1.pgeStep).toBe("generator_dispatched");
  });
});

describe("setStageArtifact", () => {
  it("sets artifact paths", () => {
    const state = createState("test", "proj", "t.yaml", [
      { name: "s1", type: "pge" },
    ], "/tmp/test-artifacts");

    setStageArtifact(state, "s1", "contract", "/path/to/contract.md");
    setStageArtifact(state, "s1", "deliverable", "/path/to/output.md");

    expect(state.stages.s1.artifacts).toEqual({
      contract: "/path/to/contract.md",
      deliverable: "/path/to/output.md",
    });
  });
});

describe("finishPipeline", () => {
  it("sets status and completedAt", () => {
    const state = createState("test", "proj", "t.yaml", [
      { name: "s1", type: "agent" },
    ], "/tmp/test-artifacts");

    finishPipeline(state, "passed");

    expect(state.status).toBe("passed");
    expect(state.completedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// findResumePoint
// ---------------------------------------------------------------------------

describe("findResumePoint", () => {
  it("returns null for a completed pipeline", () => {
    const state = createState("test", "proj", "t.yaml", [
      { name: "s1", type: "agent" },
      { name: "s2", type: "agent" },
    ], "/tmp/test-artifacts");
    state.status = "passed";
    state.stages.s1.status = "passed";
    state.stages.s2.status = "passed";

    expect(findResumePoint(state)).toBeNull();
  });

  it("resumes from first pending stage", () => {
    const state = createState("test", "proj", "t.yaml", [
      { name: "s1", type: "agent" },
      { name: "s2", type: "agent" },
      { name: "s3", type: "agent" },
    ], "/tmp/test-artifacts");
    state.status = "interrupted";
    state.stages.s1.status = "passed";

    const point = findResumePoint(state);
    expect(point).not.toBeNull();
    expect(point!.stageIndex).toBe(1);
    expect(point!.stageName).toBe("s2");
  });

  it("resumes from an in-progress PGE stage with iteration info", () => {
    const state = createState("test", "proj", "t.yaml", [
      { name: "s1", type: "agent" },
      { name: "pge1", type: "pge" },
      { name: "s3", type: "agent" },
    ], "/tmp/test-artifacts");
    state.status = "interrupted";
    state.stages.s1.status = "passed";
    state.stages.pge1.status = "in_progress";
    state.stages.pge1.iteration = 2;
    state.stages.pge1.pgeStep = "generator_dispatched";

    const point = findResumePoint(state);
    expect(point).not.toBeNull();
    expect(point!.stageIndex).toBe(1);
    expect(point!.stageName).toBe("pge1");
    expect(point!.resumeIteration).toBe(2);
    expect(point!.resumeStep).toBe("generator_dispatched");
  });

  it("skips completed and skipped stages", () => {
    const state = createState("test", "proj", "t.yaml", [
      { name: "s1", type: "agent" },
      { name: "s2", type: "agent" },
      { name: "s3", type: "agent" },
    ], "/tmp/test-artifacts");
    state.status = "interrupted";
    state.stages.s1.status = "passed";
    state.stages.s2.status = "skipped";

    const point = findResumePoint(state);
    expect(point).not.toBeNull();
    expect(point!.stageIndex).toBe(2);
    expect(point!.stageName).toBe("s3");
  });

  it("resumes from failed stage", () => {
    const state = createState("test", "proj", "t.yaml", [
      { name: "s1", type: "agent" },
      { name: "s2", type: "agent" },
    ], "/tmp/test-artifacts");
    state.status = "failed";
    state.stages.s1.status = "passed";
    state.stages.s2.status = "failed";

    const point = findResumePoint(state);
    expect(point).not.toBeNull();
    expect(point!.stageName).toBe("s2");
  });
});

// ---------------------------------------------------------------------------
// discoverRuns (SQLite backed)
// ---------------------------------------------------------------------------

describe("discoverRuns", () => {
  it("discovers runs from SQLite database", async () => {
    const projectDir = tmpProjectDir();

    const state = createState("planning", "my-app", "p.yaml", [
      { name: "s1", type: "agent" },
    ], "/artifacts/planning", projectDir);
    await saveState(state);

    const runs = await discoverRuns(projectDir);
    expect(runs).toHaveLength(1);
    expect(runs[0].state.pipeline).toBe("planning");

    closeDatabase(projectDir);
  });

  it("returns empty for project with no runs", async () => {
    const projectDir = tmpProjectDir();
    const runs = await discoverRuns(projectDir);
    expect(runs).toHaveLength(0);
    closeDatabase(projectDir);
  });
});
