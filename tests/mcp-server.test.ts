import { describe, it, expect } from "vitest";
import { closeDatabase } from "../src/db.js";
import {
  createState,
  saveState,
  discoverRuns,
} from "../src/state.js";
import { tmpProjectDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// discoverRuns (SQLite backed)
// ---------------------------------------------------------------------------

describe("discoverRuns", () => {
  it("finds a single run", async () => {
    const projectDir = tmpProjectDir();

    const state = createState("planning", "my-app", "planning.yaml", [
      { name: "s1", type: "agent" },
    ], "/artifacts/planning", projectDir);
    await saveState(state);

    const runs = await discoverRuns(projectDir);
    expect(runs).toHaveLength(1);
    expect(runs[0].state.pipeline).toBe("planning");
    expect(runs[0].state.project).toBe("my-app");
    expect(runs[0].artifactDir).toBe("/artifacts/planning");

    closeDatabase(projectDir);
  });

  it("finds multiple concurrent runs", async () => {
    const projectDir = tmpProjectDir();

    const state1 = createState("discovery", "app-a", "d.yaml", [
      { name: "research", type: "agent" },
    ], "/artifacts/discovery", projectDir);
    await saveState(state1);

    const state2 = createState("planning", "app-b", "p.yaml", [
      { name: "design", type: "pge" },
    ], "/artifacts/planning", projectDir);
    await saveState(state2);

    const runs = await discoverRuns(projectDir);
    expect(runs).toHaveLength(2);

    const pipelines = runs.map((r) => r.state.pipeline).sort();
    expect(pipelines).toEqual(["discovery", "planning"]);

    closeDatabase(projectDir);
  });

  it("returns empty array for a project with no runs", async () => {
    const projectDir = tmpProjectDir();
    const runs = await discoverRuns(projectDir);
    expect(runs).toHaveLength(0);
    closeDatabase(projectDir);
  });

  it("sorts running runs before completed", async () => {
    const projectDir = tmpProjectDir();

    const completed = createState("old", "p", "o.yaml", [
      { name: "s1", type: "agent" },
    ], "/artifacts/old", projectDir);
    completed.status = "passed";
    completed.startedAt = "2026-03-01T00:00:00.000Z";
    await saveState(completed);

    const active = createState("active", "p", "a.yaml", [
      { name: "s1", type: "agent" },
    ], "/artifacts/active", projectDir);
    active.startedAt = "2026-03-26T00:00:00.000Z";
    await saveState(active);

    const runs = await discoverRuns(projectDir);
    expect(runs).toHaveLength(2);
    expect(runs[0].state.status).toBe("running");
    expect(runs[1].state.status).toBe("passed");

    closeDatabase(projectDir);
  });
});
