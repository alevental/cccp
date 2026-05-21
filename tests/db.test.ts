import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CccpDatabase, globalDbPath, openDatabase, reopenDatabase, closeDatabase } from "../src/db.js";
import { makeState, useIsolatedDb } from "./helpers.js";

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

describe("CccpDatabase — lifecycle", () => {
  useIsolatedDb();

  it("creates a new database with schema", async () => {
    const db = await CccpDatabase.open();

    // node:sqlite creates the file on open; writes persist immediately (WAL mode).
    expect(existsSync(globalDbPath())).toBe(true);
    db.close();
  });

  it("reopens an existing database", async () => {
    const db1 = await CccpDatabase.open();
    const state = makeState();
    db1.insertRun(state, "/tmp/artifacts");
    db1.close();

    const db2 = await CccpDatabase.open();
    const loaded = db2.getRun(state.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.pipeline).toBe("test-pipeline");
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// Runs CRUD
// ---------------------------------------------------------------------------

describe("CccpDatabase — runs", () => {
  useIsolatedDb();

  it("inserts and retrieves a run", async () => {
    const db = await CccpDatabase.open();
    const state = makeState();

    db.insertRun(state, "/tmp/artifacts/test");
    const loaded = db.getRun(state.runId);

    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe(state.runId);
    expect(loaded!.pipeline).toBe("test-pipeline");
    expect(loaded!.status).toBe("running");
    expect(loaded!.stages.s1.status).toBe("pending");
    expect(loaded!.stageOrder).toEqual(["s1", "s2"]);
    db.close();
  });

  it("updates a run", async () => {
    const db = await CccpDatabase.open();
    const state = makeState();

    db.insertRun(state, "/tmp/artifacts");
    state.status = "passed";
    state.completedAt = new Date().toISOString();
    state.stages.s1.status = "passed";
    db.updateRun(state, "/tmp/artifacts");

    const loaded = db.getRun(state.runId);
    expect(loaded!.status).toBe("passed");
    expect(loaded!.completedAt).toBeDefined();
    expect(loaded!.stages.s1.status).toBe("passed");
    db.close();
  });

  it("upserts — inserts if not exists, updates if exists", async () => {
    const db = await CccpDatabase.open();
    const state = makeState();

    db.upsertRun(state, "/tmp/artifacts");
    expect(db.getRun(state.runId)).not.toBeNull();

    state.status = "failed";
    db.upsertRun(state, "/tmp/artifacts");
    expect(db.getRun(state.runId)!.status).toBe("failed");
    db.close();
  });

  it("retrieves by artifact dir", async () => {
    const db = await CccpDatabase.open();
    const state = makeState();

    db.insertRun(state, "/my/custom/artifacts");
    const loaded = db.getRunByArtifactDir("/my/custom/artifacts");

    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe(state.runId);
    db.close();
  });

  it("returns null for non-existent run", async () => {
    const db = await CccpDatabase.open();

    expect(db.getRun("nonexistent")).toBeNull();
    expect(db.getRunByArtifactDir("/nonexistent")).toBeNull();
    db.close();
  });

  it("lists runs sorted by status then date", async () => {
    const db = await CccpDatabase.open();

    const completed = makeState({
      pipeline: "old",
      status: "passed",
      startedAt: "2026-03-01T00:00:00.000Z",
    });
    const active = makeState({
      pipeline: "active",
      status: "running",
      startedAt: "2026-03-26T00:00:00.000Z",
    });

    db.insertRun(completed, "/artifacts/old");
    db.insertRun(active, "/artifacts/active");

    const runs = db.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0].state.status).toBe("running");
    expect(runs[1].state.status).toBe("passed");
    db.close();
  });

  it("stores and retrieves gate info", async () => {
    const db = await CccpDatabase.open();
    const state = makeState();
    state.gate = {
      stageName: "approval",
      status: "pending",
      prompt: "Please approve",
    };

    db.insertRun(state, "/artifacts");
    const loaded = db.getRun(state.runId);

    expect(loaded!.gate).toBeDefined();
    expect(loaded!.gate!.stageName).toBe("approval");
    expect(loaded!.gate!.status).toBe("pending");
    expect(loaded!.gate!.prompt).toBe("Please approve");
    db.close();
  });

  it("findRuns filters by projectDir", async () => {
    const db = await CccpDatabase.open();

    db.insertRun(makeState({ projectDir: "/wt/one" }), "/a/one");
    db.insertRun(makeState({ projectDir: "/wt/two" }), "/a/two");
    db.insertRun(makeState({ projectDir: "/wt/two" }), "/a/three");

    const one = db.findRuns({ projectDir: "/wt/one" });
    expect(one).toHaveLength(1);

    const two = db.findRuns({ projectDir: "/wt/two" });
    expect(two).toHaveLength(2);

    db.close();
  });

  it("getRunByIdPrefix scopes by project/projectDir filter", async () => {
    const db = await CccpDatabase.open();

    // Two runs sharing a 1-char prefix but different projects.
    const a = makeState({ runId: "abcdef-aaa-1", project: "alpha", projectDir: "/wt/a" });
    const b = makeState({ runId: "abcdef-bbb-2", project: "beta",  projectDir: "/wt/b" });
    db.insertRun(a, "/x/a");
    db.insertRun(b, "/x/b");

    // Ambiguous without filter.
    expect(db.getRunByIdPrefix("abcdef")).toBeNull();

    // Project filter disambiguates.
    expect(db.getRunByIdPrefix("abcdef", { project: "alpha" })?.runId).toBe(a.runId);
    expect(db.getRunByIdPrefix("abcdef", { projectDir: "/wt/b" })?.runId).toBe(b.runId);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Events — audit log
// ---------------------------------------------------------------------------

describe("CccpDatabase — events", () => {
  useIsolatedDb();

  it("appends and retrieves events", async () => {
    const db = await CccpDatabase.open();
    const state = makeState();
    db.insertRun(state, "/artifacts");

    db.appendEvent(state.runId, "stage_start", "s1");
    db.appendEvent(state.runId, "stage_complete", "s1", {
      status: "passed",
      durationMs: 1234,
    });

    const events = db.getEvents(state.runId);
    expect(events).toHaveLength(2);
    expect(events[0].eventType).toBe("stage_start");
    expect(events[0].stageName).toBe("s1");
    expect(events[1].eventType).toBe("stage_complete");
    expect(events[1].data).toEqual({ status: "passed", durationMs: 1234 });
    db.close();
  });

  it("getEvents with sinceId returns incremental results", async () => {
    const db = await CccpDatabase.open();
    const state = makeState();
    db.insertRun(state, "/artifacts");

    db.appendEvent(state.runId, "event_a");
    db.appendEvent(state.runId, "event_b");
    db.appendEvent(state.runId, "event_c");

    const all = db.getEvents(state.runId);
    expect(all).toHaveLength(3);

    const sinceFirst = db.getEvents(state.runId, all[0].id);
    expect(sinceFirst).toHaveLength(2);
    expect(sinceFirst[0].eventType).toBe("event_b");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Events — pruning
// ---------------------------------------------------------------------------

describe("CccpDatabase — event pruning", () => {
  useIsolatedDb();

  it("pruneEvents keeps only the most recent N events", async () => {
    const db = await CccpDatabase.open();
    const state = makeState();
    db.insertRun(state, "/artifacts");

    // Insert 10 events
    for (let i = 0; i < 10; i++) {
      db.appendEvent(state.runId, `event_${i}`, undefined, { index: i });
    }
    expect(db.getEvents(state.runId)).toHaveLength(10);

    // Prune to 3
    db.pruneEvents(state.runId, 3);

    const remaining = db.getEvents(state.runId);
    expect(remaining).toHaveLength(3);
    // Should keep the last 3 (event_7, event_8, event_9)
    expect(remaining[0].eventType).toBe("event_7");
    expect(remaining[1].eventType).toBe("event_8");
    expect(remaining[2].eventType).toBe("event_9");
    db.close();
  });

  it("pruneEvents is a no-op when fewer events than limit", async () => {
    const db = await CccpDatabase.open();
    const state = makeState();
    db.insertRun(state, "/artifacts");

    db.appendEvent(state.runId, "only_one");
    db.pruneEvents(state.runId, 500);

    expect(db.getEvents(state.runId)).toHaveLength(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

describe("CccpDatabase — checkpoints", () => {
  useIsolatedDb();

  it("stores and retrieves checkpoints", async () => {
    const db = await CccpDatabase.open();

    db.setCheckpoint("run1", "stage1", "contract", "/path/to/contract.md");
    const val = db.getCheckpoint("run1", "stage1", "contract");
    expect(val).toBe("/path/to/contract.md");
    db.close();
  });

  it("overwrites existing checkpoint", async () => {
    const db = await CccpDatabase.open();

    db.setCheckpoint("run1", "stage1", "deliverable", "/v1.md");
    db.setCheckpoint("run1", "stage1", "deliverable", "/v2.md");
    expect(db.getCheckpoint("run1", "stage1", "deliverable")).toBe("/v2.md");
    db.close();
  });

  it("returns null for non-existent checkpoint", async () => {
    const db = await CccpDatabase.open();

    expect(db.getCheckpoint("x", "y", "z")).toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Persistence — writes land on disk immediately (WAL mode)
// ---------------------------------------------------------------------------

describe("CccpDatabase — persistence", () => {
  useIsolatedDb();

  it("writes are visible to a reopened handle", async () => {
    const db = await CccpDatabase.open();
    const state = makeState();

    db.insertRun(state, "/artifacts");
    db.appendEvent(state.runId, "test_event");
    db.close();

    // Reopen and verify — no flush() needed with node:sqlite.
    const db2 = await CccpDatabase.open();
    expect(db2.getRun(state.runId)).not.toBeNull();
    expect(db2.getEvents(state.runId)).toHaveLength(1);
    db2.close();
  });

  it("concurrent handles on the same file see each other's writes", async () => {
    const writer = await CccpDatabase.open();
    const reader = await CccpDatabase.open();
    const state = makeState();

    writer.insertRun(state, "/artifacts");
    // WAL mode: reader sees the committed write without any manual reload.
    expect(reader.getRun(state.runId)).not.toBeNull();

    writer.close();
    reader.close();
  });

  // Regression for v0.17.3: a long-lived reader in a different process was
  // observed to miss WAL frames committed by the writer until the connection
  // was recycled. reopenDatabase() is the recycle primitive. The test opens
  // a reader, lets a child process insert a row, then asserts that the
  // recycled handle sees the row. We don't assert on the stale handle's
  // behavior — it's platform-dependent — only that the fix works.
  it("reopenDatabase picks up a sibling-process write on the reader side", () => {
    const filePath = globalDbPath();

    // Seed one row so the DB file exists with schema applied.
    const seed = openDatabase();
    seed.insertRun(makeState({ runId: "seed-run" }), "/artifacts");

    // Child process: open the same DB via node:sqlite directly, insert a
    // row, exit. Uses raw SQL so the child doesn't need tsx / the built dist.
    const childScript = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(filePath)});
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
      db.prepare(
        "INSERT INTO runs (run_id, pipeline, project, pipeline_file, artifact_dir, project_dir, started_at, status, stages_json, stage_order_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run("child-run", "p", "pr", "/f", "/a", "/wt/child", new Date().toISOString(), "running", "{}", "[]", new Date().toISOString());
      db.close();
    `;
    const child = spawnSync(process.execPath, ["-e", childScript], {
      encoding: "utf-8",
    });
    expect(child.status, child.stderr).toBe(0);

    // After reopen the reader must see the child-process write.
    const fresh = reopenDatabase();
    expect(fresh.getRun("child-run")).not.toBeNull();
    expect(fresh.getRun("seed-run")).not.toBeNull();

    closeDatabase();
  });
});
