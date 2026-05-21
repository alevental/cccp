import { describe, it, expect } from "vitest";
import {
  createState,
  saveState,
  discoverRuns,
} from "../src/state.js";
import { tmpProjectDir, useIsolatedDb } from "./helpers.js";

// ---------------------------------------------------------------------------
// discoverRuns (SQLite backed, global DB)
// ---------------------------------------------------------------------------

describe("discoverRuns", () => {
  useIsolatedDb();

  it("finds a single run", async () => {
    const projectDir = tmpProjectDir();

    const state = createState("planning", "my-app", "planning.yaml", [
      { name: "s1", type: "agent" },
    ], "/artifacts/planning", projectDir);
    await saveState(state);

    const runs = await discoverRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].state.pipeline).toBe("planning");
    expect(runs[0].state.project).toBe("my-app");
    expect(runs[0].artifactDir).toBe("/artifacts/planning");
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

    const runs = await discoverRuns();
    expect(runs).toHaveLength(2);

    const pipelines = runs.map((r) => r.state.pipeline).sort();
    expect(pipelines).toEqual(["discovery", "planning"]);
  });

  it("returns empty array when no runs exist", async () => {
    const runs = await discoverRuns();
    expect(runs).toHaveLength(0);
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

    const runs = await discoverRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0].state.status).toBe("running");
    expect(runs[1].state.status).toBe("passed");
  });

  it("filters by projectDir across worktrees", async () => {
    const wt1 = tmpProjectDir();
    const wt2 = tmpProjectDir();

    await saveState(createState("p1", "alpha", "p1.yaml", [
      { name: "s1", type: "agent" },
    ], "/artifacts/wt1", wt1));
    await saveState(createState("p2", "beta", "p2.yaml", [
      { name: "s1", type: "agent" },
    ], "/artifacts/wt2", wt2));

    const all = await discoverRuns();
    expect(all).toHaveLength(2);

    const onlyWt1 = await discoverRuns({ projectDir: wt1 });
    expect(onlyWt1).toHaveLength(1);
    expect(onlyWt1[0].state.projectDir).toBe(wt1);
  });
});
