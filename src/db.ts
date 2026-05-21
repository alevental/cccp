import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import type {
  PipelineState,
  StateEvent,
  DiscoveredRun,
} from "./types.js";

/** Filter criteria for querying pipeline runs. */
export interface RunFilter {
  project?: string;
  pipeline?: string;
  status?: string;
  artifactDir?: string;
  /** Filter to runs originating from this absolute project directory. */
  projectDir?: string;
}

// ---------------------------------------------------------------------------
// Database path — single global DB shared by all projects on this machine.
// Override with CCCP_DB_PATH (used by tests for isolation; also a power-user
// knob for relocating state to e.g. a synced folder).
// ---------------------------------------------------------------------------

export function globalDbPath(): string {
  return process.env.CCCP_DB_PATH || join(homedir(), ".cccp", "cccp.db");
}

// ---------------------------------------------------------------------------
// CccpDatabase
// ---------------------------------------------------------------------------

export class CccpDatabase {
  private db: DatabaseSync;
  private filePath: string;

  private constructor(db: DatabaseSync, filePath: string) {
    this.db = db;
    this.filePath = filePath;
  }

  /**
   * Open or create the global database. Enables WAL mode so readers in
   * other processes see committed writes without manual reload.
   */
  static open(): CccpDatabase {
    const fp = globalDbPath();
    mkdirSync(dirname(fp), { recursive: true });

    const db = new DatabaseSync(fp);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");

    const instance = new CccpDatabase(db, fp);
    instance.migrate();
    return instance;
  }

  // -------------------------------------------------------------------------
  // Schema migration
  // -------------------------------------------------------------------------

  private migrate(): void {
    const version = this.pragma("user_version");

    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          run_id           TEXT PRIMARY KEY,
          pipeline         TEXT NOT NULL,
          project          TEXT NOT NULL,
          pipeline_file    TEXT NOT NULL,
          artifact_dir     TEXT NOT NULL,
          project_dir      TEXT NOT NULL,
          started_at       TEXT NOT NULL,
          completed_at     TEXT,
          status           TEXT NOT NULL DEFAULT 'running',
          stages_json      TEXT NOT NULL,
          stage_order_json TEXT NOT NULL,
          gate_json        TEXT,
          updated_at       TEXT NOT NULL
        )
      `);
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`,
      );
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_runs_artifact_dir ON runs(artifact_dir)`,
      );
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_runs_project_dir ON runs(project_dir)`,
      );

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id      TEXT NOT NULL,
          timestamp   TEXT NOT NULL,
          event_type  TEXT NOT NULL,
          stage_name  TEXT,
          data_json   TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id)`,
      );

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          run_id      TEXT NOT NULL,
          stage_name  TEXT NOT NULL,
          key         TEXT NOT NULL,
          value       TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (run_id, stage_name, key)
        )
      `);

      this.db.exec(`PRAGMA user_version = 1`);
    }

    if (version < 2) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN session_id TEXT`);
      this.db.exec(`PRAGMA user_version = 2`);
    }

    if (version < 3) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN pause_requested INTEGER DEFAULT 0`);
      this.db.exec(`PRAGMA user_version = 3`);
    }
  }

  private pragma(name: string): number {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return 0;
    const value = Object.values(row)[0];
    return typeof value === "number" ? value : 0;
  }

  // -------------------------------------------------------------------------
  // Runs — CRUD
  // -------------------------------------------------------------------------

  insertRun(state: PipelineState, artifactDir: string): void {
    if (!state.projectDir) {
      throw new Error(
        `Cannot insert run ${state.runId}: projectDir is required (global DB scopes runs by project_dir).`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO runs (run_id, pipeline, project, pipeline_file, artifact_dir, project_dir, started_at, completed_at, status, stages_json, stage_order_json, gate_json, session_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        state.runId,
        state.pipeline,
        state.project,
        state.pipelineFile,
        artifactDir,
        state.projectDir,
        state.startedAt,
        state.completedAt ?? null,
        state.status,
        JSON.stringify(state.stages),
        JSON.stringify(state.stageOrder),
        state.gate ? JSON.stringify(state.gate) : null,
        state.sessionId ?? null,
        new Date().toISOString(),
      );
  }

  updateRun(state: PipelineState, _artifactDir: string): void {
    this.db
      .prepare(
        `UPDATE runs SET
          status = ?, completed_at = ?, stages_json = ?, stage_order_json = ?,
          gate_json = ?, session_id = ?, updated_at = ?
         WHERE run_id = ?`,
      )
      .run(
        state.status,
        state.completedAt ?? null,
        JSON.stringify(state.stages),
        JSON.stringify(state.stageOrder),
        state.gate ? JSON.stringify(state.gate) : null,
        state.sessionId ?? null,
        new Date().toISOString(),
        state.runId,
      );
  }

  /** Insert or update — tries getRun first, inserts if no row exists. */
  upsertRun(state: PipelineState, artifactDir: string): void {
    const existing = this.getRun(state.runId);
    if (existing) {
      this.updateRun(state, artifactDir);
    } else {
      this.insertRun(state, artifactDir);
    }
  }

  getRun(runId: string): PipelineState | null {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE run_id = ?`)
      .get(runId) as unknown as RunRow | undefined;
    return row ? this.rowToState(row) : null;
  }

  /** @deprecated Use getRun(runId) instead. */
  getRunByArtifactDir(artifactDir: string): PipelineState | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE artifact_dir = ? ORDER BY started_at DESC LIMIT 1`,
      )
      .get(artifactDir) as unknown as RunRow | undefined;
    return row ? this.rowToState(row) : null;
  }

  /**
   * Find a run by ID prefix, optionally narrowed by project/projectDir.
   * Returns null if zero or multiple matches.
   */
  getRunByIdPrefix(
    prefix: string,
    filter?: Pick<RunFilter, "project" | "projectDir">,
  ): PipelineState | null {
    const conditions: string[] = ["run_id LIKE ? || '%'"];
    const params: string[] = [prefix];
    if (filter?.project) {
      conditions.push("project = ?");
      params.push(filter.project);
    }
    if (filter?.projectDir) {
      conditions.push("project_dir = ?");
      params.push(filter.projectDir);
    }
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE ${conditions.join(" AND ")}`)
      .all(...params) as unknown as RunRow[];
    return rows.length === 1 ? this.rowToState(rows[0]) : null;
  }

  listRuns(): DiscoveredRun[] {
    return this.findRuns();
  }

  /**
   * Find runs matching optional filters. All filters are AND-combined.
   * Results sorted running-first, then by start time descending.
   */
  findRuns(filter?: RunFilter): DiscoveredRun[] {
    const conditions: string[] = [];
    const params: string[] = [];

    if (filter?.project) {
      conditions.push("project = ?");
      params.push(filter.project);
    }
    if (filter?.pipeline) {
      conditions.push("pipeline = ?");
      params.push(filter.pipeline);
    }
    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.artifactDir) {
      conditions.push("artifact_dir = ?");
      params.push(filter.artifactDir);
    }
    if (filter?.projectDir) {
      conditions.push("project_dir = ?");
      params.push(filter.projectDir);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM runs ${where} ORDER BY
          CASE WHEN status = 'running' THEN 0 WHEN status = 'paused' THEN 1 ELSE 2 END,
          started_at DESC`,
      )
      .all(...params) as unknown as RunRow[];

    return rows.map((row) => {
      const state = this.rowToState(row);
      return { artifactDir: state.artifactDir, state };
    });
  }

  private rowToState(row: RunRow): PipelineState {
    return {
      runId: row.run_id,
      pipeline: row.pipeline,
      project: row.project,
      pipelineFile: row.pipeline_file,
      startedAt: row.started_at,
      completedAt: row.completed_at || undefined,
      status: row.status as PipelineState["status"],
      stages: JSON.parse(row.stages_json),
      stageOrder: JSON.parse(row.stage_order_json),
      gate: row.gate_json ? JSON.parse(row.gate_json) : undefined,
      artifactDir: row.artifact_dir,
      projectDir: row.project_dir,
      sessionId: row.session_id || undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Events — append-only audit log
  // -------------------------------------------------------------------------

  appendEvent(
    runId: string,
    eventType: string,
    stageName?: string,
    data?: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (run_id, timestamp, event_type, stage_name, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        new Date().toISOString(),
        eventType,
        stageName ?? null,
        data ? JSON.stringify(data) : null,
      );
  }

  /**
   * Remove old events for a run, keeping only the most recent `keep` entries.
   * Caps unbounded growth of the append-only events table on long runs.
   */
  pruneEvents(runId: string, keep: number = 500): void {
    this.db
      .prepare(
        `DELETE FROM events WHERE run_id = ? AND id NOT IN (
          SELECT id FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?
        )`,
      )
      .run(runId, runId, keep);
  }

  /** Total event count for a run. Used by the memory JSONL logger as a leak signal. */
  countEvents(runId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE run_id = ?`)
      .get(runId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  getEvents(runId: string, sinceId?: number): StateEvent[] {
    const rows =
      sinceId != null
        ? (this.db
            .prepare(
              `SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id`,
            )
            .all(runId, sinceId) as unknown as EventRow[])
        : (this.db
            .prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY id`)
            .all(runId) as unknown as EventRow[]);

    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      timestamp: row.timestamp,
      eventType: row.event_type,
      stageName: row.stage_name || undefined,
      data: row.data_json ? JSON.parse(row.data_json) : undefined,
    }));
  }

  // -------------------------------------------------------------------------
  // Checkpoints — cached stage outputs
  // -------------------------------------------------------------------------

  setCheckpoint(
    runId: string,
    stageName: string,
    key: string,
    value: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints (run_id, stage_name, key, value, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      )
      .run(runId, stageName, key, value);
  }

  getCheckpoint(
    runId: string,
    stageName: string,
    key: string,
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT value FROM checkpoints WHERE run_id = ? AND stage_name = ? AND key = ?`,
      )
      .get(runId, stageName, key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  // -------------------------------------------------------------------------
  // Pause — cross-process pause signalling (separate from state JSON)
  // -------------------------------------------------------------------------

  setPauseRequested(runId: string, requested: boolean): void {
    this.db
      .prepare(`UPDATE runs SET pause_requested = ? WHERE run_id = ?`)
      .run(requested ? 1 : 0, runId);
  }

  isPauseRequested(runId: string): boolean {
    const row = this.db
      .prepare(`SELECT pause_requested FROM runs WHERE run_id = ?`)
      .get(runId) as { pause_requested: number } | undefined;
    return row?.pause_requested === 1;
  }

  // -------------------------------------------------------------------------
  // Cleanup — delete events/checkpoints for specific stages
  // -------------------------------------------------------------------------

  deleteEventsForStages(runId: string, stageNames: string[]): void {
    if (stageNames.length === 0) return;
    const placeholders = stageNames.map(() => "?").join(", ");
    this.db
      .prepare(
        `DELETE FROM events WHERE run_id = ? AND stage_name IN (${placeholders})`,
      )
      .run(runId, ...stageNames);
  }

  deleteCheckpointsForStages(runId: string, stageNames: string[]): void {
    if (stageNames.length === 0) return;
    const placeholders = stageNames.map(() => "?").join(", ");
    this.db
      .prepare(
        `DELETE FROM checkpoints WHERE run_id = ? AND stage_name IN (${placeholders})`,
      )
      .run(runId, ...stageNames);
  }

  /**
   * Delete child events for specific child stages within a parent pipeline stage.
   * Child events are stored with stage_name = parentStageName and the child stage
   * name inside data_json.childStage.
   */
  deleteChildEventsForStages(
    runId: string,
    parentStageName: string,
    childStageNames: string[],
  ): void {
    if (childStageNames.length === 0) return;
    const placeholders = childStageNames.map(() => "?").join(", ");
    this.db
      .prepare(
        `DELETE FROM events WHERE run_id = ? AND stage_name = ?
         AND event_type LIKE 'child_%'
         AND json_extract(data_json, '$.childStage') IN (${placeholders})`,
      )
      .run(runId, parentStageName, ...childStageNames);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Row type shapes (internal to this module)
// ---------------------------------------------------------------------------

interface RunRow {
  run_id: string;
  pipeline: string;
  project: string;
  pipeline_file: string;
  artifact_dir: string;
  project_dir: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  stages_json: string;
  stage_order_json: string;
  gate_json: string | null;
  session_id: string | null;
  updated_at: string;
  pause_requested?: number;
}

interface EventRow {
  id: number;
  run_id: string;
  timestamp: string;
  event_type: string;
  stage_name: string | null;
  data_json: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Singleton cache — one global DB handle per process, keyed by the resolved
// path (so a test toggling CCCP_DB_PATH between suites gets a fresh handle).
// ---------------------------------------------------------------------------

let cached: { path: string; db: CccpDatabase } | null = null;

/**
 * Get or create the process-wide CccpDatabase handle. If the resolved global
 * path changed since the last call (e.g. tests overrode CCCP_DB_PATH), the
 * stale handle is closed and a new one opened.
 */
export function openDatabase(): CccpDatabase {
  const path = resolve(globalDbPath());
  if (cached && cached.path === path) return cached.db;
  if (cached) cached.db.close();
  cached = { path, db: CccpDatabase.open() };
  return cached.db;
}

/**
 * Close and clear the cached database instance.
 */
export function closeDatabase(): void {
  if (cached) {
    cached.db.close();
    cached = null;
  }
}

/**
 * Close the cached instance and return a freshly opened one. Cross-process
 * readers call this before each read: long-lived `DatabaseSync` handles on
 * macOS + Node 24/25 were observed to pin a WAL snapshot and miss frames
 * committed by a sibling writer process until the connection is recycled.
 * See v0.17.3 notes / regression test in tests/db.test.ts.
 */
export function reopenDatabase(): CccpDatabase {
  closeDatabase();
  return openDatabase();
}
