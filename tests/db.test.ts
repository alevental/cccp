import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { CccpDatabase, dbPath } from "../src/db.js";
import { tmpProjectDir, makeState } from "./helpers.js";

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

describe("CccpDatabase — lifecycle", () => {
  it("creates a new database with schema", async () => {
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);

    // node:sqlite creates the file on open; writes persist immediately (WAL mode).
    expect(existsSync(dbPath(dir))).toBe(true);
    db.close();
  });

  it("reopens an existing database", async () => {
    const dir = tmpProjectDir();
    const db1 = await CccpDatabase.open(dir);
    const state = makeState();
    db1.insertRun(state, "/tmp/artifacts");
    db1.close();

    const db2 = await CccpDatabase.open(dir);
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
  it("inserts and retrieves a run", async () => {
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);
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
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);
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
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);
    const state = makeState();

    db.upsertRun(state, "/tmp/artifacts");
    expect(db.getRun(state.runId)).not.toBeNull();

    state.status = "failed";
    db.upsertRun(state, "/tmp/artifacts");
    expect(db.getRun(state.runId)!.status).toBe("failed");
    db.close();
  });

  it("retrieves by artifact dir", async () => {
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);
    const state = makeState();

    db.insertRun(state, "/my/custom/artifacts");
    const loaded = db.getRunByArtifactDir("/my/custom/artifacts");

    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe(state.runId);
    db.close();
  });

  it("returns null for non-existent run", async () => {
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);

    expect(db.getRun("nonexistent")).toBeNull();
    expect(db.getRunByArtifactDir("/nonexistent")).toBeNull();
    db.close();
  });

  it("lists runs sorted by status then date", async () => {
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);

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
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);
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

});

// ---------------------------------------------------------------------------
// Events — audit log
// ---------------------------------------------------------------------------

describe("CccpDatabase — events", () => {
  it("appends and retrieves events", async () => {
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);
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
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);
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
  it("pruneEvents keeps only the most recent N events", async () => {
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);
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
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);
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
  it("stores and retrieves checkpoints", async () => {
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);

    db.setCheckpoint("run1", "stage1", "contract", "/path/to/contract.md");
    const val = db.getCheckpoint("run1", "stage1", "contract");
    expect(val).toBe("/path/to/contract.md");
    db.close();
  });

  it("overwrites existing checkpoint", async () => {
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);

    db.setCheckpoint("run1", "stage1", "deliverable", "/v1.md");
    db.setCheckpoint("run1", "stage1", "deliverable", "/v2.md");
    expect(db.getCheckpoint("run1", "stage1", "deliverable")).toBe("/v2.md");
    db.close();
  });

  it("returns null for non-existent checkpoint", async () => {
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);

    expect(db.getCheckpoint("x", "y", "z")).toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Persistence — writes land on disk immediately (WAL mode)
// ---------------------------------------------------------------------------

describe("CccpDatabase — persistence", () => {
  it("writes are visible to a reopened handle", async () => {
    const dir = tmpProjectDir();
    const db = await CccpDatabase.open(dir);
    const state = makeState();

    db.insertRun(state, "/artifacts");
    db.appendEvent(state.runId, "test_event");
    db.close();

    // Reopen and verify — no flush() needed with node:sqlite.
    const db2 = await CccpDatabase.open(dir);
    expect(db2.getRun(state.runId)).not.toBeNull();
    expect(db2.getEvents(state.runId)).toHaveLength(1);
    db2.close();
  });

  it("concurrent handles on the same file see each other's writes", async () => {
    const dir = tmpProjectDir();
    const writer = await CccpDatabase.open(dir);
    const reader = await CccpDatabase.open(dir);
    const state = makeState();

    writer.insertRun(state, "/artifacts");
    // WAL mode: reader sees the committed write without any manual reload.
    expect(reader.getRun(state.runId)).not.toBeNull();

    writer.close();
    reader.close();
  });
});
