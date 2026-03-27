import initSqlJs, { type Database } from "sql.js";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { PipelineState, StageState } from "./types.js";
import type { GateInfo } from "./state.js";

// ---------------------------------------------------------------------------
// Event types for the audit log
// ---------------------------------------------------------------------------

export interface StateEvent {
  id: number;
  runId: string;
  timestamp: string;
  eventType: string;
  stageName?: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Discovered run (returned by listRuns)
// ---------------------------------------------------------------------------

export interface DiscoveredRun {
  artifactDir: string;
  state: PipelineState;
}

// ---------------------------------------------------------------------------
// sql.js initialization (async, once)
// ---------------------------------------------------------------------------

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSql(): Promise<typeof SQL> {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL!;
}

// ---------------------------------------------------------------------------
// Database path
// ---------------------------------------------------------------------------

export function dbPath(projectDir: string): string {
  return resolve(projectDir, ".cccp", "cccp.db");
}

// ---------------------------------------------------------------------------
// CccpDatabase
// ---------------------------------------------------------------------------

export class CccpDatabase {
  private db: Database;
  private filePath: string;

  private constructor(db: Database, filePath: string) {
    this.db = db;
    this.filePath = filePath;
  }

  /**
   * Open or create a database. If the file exists, load it. Otherwise create
   * a new empty DB with the schema.
   */
  static async open(projectDir: string): Promise<CccpDatabase> {
    const sql = await getSql();
    const fp = dbPath(projectDir);
    const dir = dirname(fp);

    mkdirSync(dir, { recursive: true });

    let db: Database;
    if (existsSync(fp)) {
      const buffer = readFileSync(fp);
      db = new sql!.Database(buffer);
    } else {
      db = new sql!.Database();
    }

    const instance = new CccpDatabase(db, fp);
    instance.migrate();
    return instance;
  }

  /**
   * Open a read-only copy of the database (for standalone dashboard / MCP server).
   * Re-reads the file from disk each time — safe for cross-process access.
   */
  static async openReadOnly(projectDir: string): Promise<CccpDatabase> {
    const sql = await getSql();
    const fp = dbPath(projectDir);

    if (!existsSync(fp)) {
      // No DB yet — return an empty one (no writes will be flushed)
      const db = new sql!.Database();
      const instance = new CccpDatabase(db, fp);
      instance.migrate();
      return instance;
    }

    const buffer = readFileSync(fp);
    const db = new sql!.Database(buffer);
    return new CccpDatabase(db, fp);
  }

  // -------------------------------------------------------------------------
  // Schema migration
  // -------------------------------------------------------------------------

  private migrate(): void {
    const version = this.pragma("user_version");

    if (version < 1) {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS runs (
          run_id           TEXT PRIMARY KEY,
          pipeline         TEXT NOT NULL,
          project          TEXT NOT NULL,
          pipeline_file    TEXT NOT NULL,
          artifact_dir     TEXT NOT NULL,
          project_dir      TEXT,
          started_at       TEXT NOT NULL,
          completed_at     TEXT,
          status           TEXT NOT NULL DEFAULT 'running',
          stages_json      TEXT NOT NULL,
          stage_order_json TEXT NOT NULL,
          gate_json        TEXT,
          updated_at       TEXT NOT NULL
        )
      `);
      this.db.run(
        `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`,
      );
      this.db.run(
        `CREATE INDEX IF NOT EXISTS idx_runs_artifact_dir ON runs(artifact_dir)`,
      );

      this.db.run(`
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
      this.db.run(
        `CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id)`,
      );

      this.db.run(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          run_id      TEXT NOT NULL,
          stage_name  TEXT NOT NULL,
          key         TEXT NOT NULL,
          value       TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (run_id, stage_name, key)
        )
      `);

      this.db.run(`PRAGMA user_version = 1`);
    }
  }

  private pragma(name: string): number {
    const result = this.db.exec(`PRAGMA ${name}`);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as number;
    }
    return 0;
  }

  // -------------------------------------------------------------------------
  // Runs — CRUD
  // -------------------------------------------------------------------------

  insertRun(state: PipelineState, artifactDir: string): void {
    this.db.run(
      `INSERT INTO runs (run_id, pipeline, project, pipeline_file, artifact_dir, project_dir, started_at, completed_at, status, stages_json, stage_order_json, gate_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        state.runId,
        state.pipeline,
        state.project,
        state.pipelineFile,
        artifactDir,
        state.projectDir ?? null,
        state.startedAt,
        state.completedAt ?? null,
        state.status,
        JSON.stringify(state.stages),
        JSON.stringify(state.stageOrder),
        state.gate ? JSON.stringify(state.gate) : null,
        new Date().toISOString(),
      ],
    );
  }

  updateRun(state: PipelineState, artifactDir: string): void {
    this.db.run(
      `UPDATE runs SET
        status = ?, completed_at = ?, stages_json = ?, stage_order_json = ?,
        gate_json = ?, updated_at = ?
       WHERE run_id = ?`,
      [
        state.status,
        state.completedAt ?? null,
        JSON.stringify(state.stages),
        JSON.stringify(state.stageOrder),
        state.gate ? JSON.stringify(state.gate) : null,
        new Date().toISOString(),
        state.runId,
      ],
    );
  }

  /**
   * Insert or update — tries update first, inserts if no row exists.
   */
  upsertRun(state: PipelineState, artifactDir: string): void {
    const existing = this.getRun(state.runId);
    if (existing) {
      this.updateRun(state, artifactDir);
    } else {
      this.insertRun(state, artifactDir);
    }
  }

  getRun(runId: string): PipelineState | null {
    const results = this.db.exec(
      `SELECT * FROM runs WHERE run_id = ?`,
      [runId],
    );
    if (results.length === 0 || results[0].values.length === 0) return null;
    return this.rowToState(results[0].columns, results[0].values[0]);
  }

  getRunByArtifactDir(artifactDir: string): PipelineState | null {
    const results = this.db.exec(
      `SELECT * FROM runs WHERE artifact_dir = ? ORDER BY started_at DESC LIMIT 1`,
      [artifactDir],
    );
    if (results.length === 0 || results[0].values.length === 0) return null;
    return this.rowToState(results[0].columns, results[0].values[0]);
  }

  listRuns(): DiscoveredRun[] {
    const results = this.db.exec(
      `SELECT * FROM runs ORDER BY
        CASE WHEN status = 'running' THEN 0 ELSE 1 END,
        started_at DESC`,
    );
    if (results.length === 0) return [];

    return results[0].values.map((row) => {
      const state = this.rowToState(results[0].columns, row);
      const artifactDirIdx = results[0].columns.indexOf("artifact_dir");
      return {
        artifactDir: row[artifactDirIdx] as string,
        state,
      };
    });
  }

  getLastUpdated(artifactDir: string): string | null {
    const results = this.db.exec(
      `SELECT updated_at FROM runs WHERE artifact_dir = ? LIMIT 1`,
      [artifactDir],
    );
    if (results.length === 0 || results[0].values.length === 0) return null;
    return results[0].values[0][0] as string;
  }

  private rowToState(
    columns: string[],
    row: unknown[],
  ): PipelineState {
    const col = (name: string) => row[columns.indexOf(name)];
    return {
      runId: col("run_id") as string,
      pipeline: col("pipeline") as string,
      project: col("project") as string,
      pipelineFile: col("pipeline_file") as string,
      startedAt: col("started_at") as string,
      completedAt: (col("completed_at") as string) || undefined,
      status: col("status") as PipelineState["status"],
      stages: JSON.parse(col("stages_json") as string),
      stageOrder: JSON.parse(col("stage_order_json") as string),
      gate: col("gate_json")
        ? JSON.parse(col("gate_json") as string)
        : undefined,
      projectDir: (col("project_dir") as string) || undefined,
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
    this.db.run(
      `INSERT INTO events (run_id, timestamp, event_type, stage_name, data_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        runId,
        new Date().toISOString(),
        eventType,
        stageName ?? null,
        data ? JSON.stringify(data) : null,
      ],
    );
  }

  getEvents(runId: string, sinceId?: number): StateEvent[] {
    const sql = sinceId != null
      ? `SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id`
      : `SELECT * FROM events WHERE run_id = ? ORDER BY id`;
    const params = sinceId != null ? [runId, sinceId] : [runId];
    const results = this.db.exec(sql, params);
    if (results.length === 0) return [];

    const cols = results[0].columns;
    return results[0].values.map((row) => ({
      id: row[cols.indexOf("id")] as number,
      runId: row[cols.indexOf("run_id")] as string,
      timestamp: row[cols.indexOf("timestamp")] as string,
      eventType: row[cols.indexOf("event_type")] as string,
      stageName: (row[cols.indexOf("stage_name")] as string) || undefined,
      data: row[cols.indexOf("data_json")]
        ? JSON.parse(row[cols.indexOf("data_json")] as string)
        : undefined,
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
    this.db.run(
      `INSERT OR REPLACE INTO checkpoints (run_id, stage_name, key, value, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [runId, stageName, key, value],
    );
  }

  getCheckpoint(
    runId: string,
    stageName: string,
    key: string,
  ): string | null {
    const results = this.db.exec(
      `SELECT value FROM checkpoints WHERE run_id = ? AND stage_name = ? AND key = ?`,
      [runId, stageName, key],
    );
    if (results.length === 0 || results[0].values.length === 0) return null;
    return results[0].values[0][0] as string;
  }

  // -------------------------------------------------------------------------
  // Persistence — flush to disk
  // -------------------------------------------------------------------------

  /**
   * Atomically write the database to disk (write to .tmp then rename).
   */
  flush(): void {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.cccp-db-${randomUUID()}.tmp`);
    writeFileSync(tmp, buffer);
    renameSync(tmp, this.filePath);
  }

  /**
   * Reload the database from disk (for read-only consumers in separate processes).
   */
  reload(): void {
    if (!existsSync(this.filePath)) return;
    const buffer = readFileSync(this.filePath);
    const sql = SQL!;
    this.db.close();
    this.db = new sql.Database(buffer);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Singleton cache
// ---------------------------------------------------------------------------

const instances = new Map<string, CccpDatabase>();

/**
 * Get or create a CccpDatabase for the given project directory.
 * Caches the instance for reuse within the same process.
 */
export async function openDatabase(
  projectDir: string,
): Promise<CccpDatabase> {
  const key = resolve(projectDir);
  let db = instances.get(key);
  if (!db) {
    db = await CccpDatabase.open(projectDir);
    instances.set(key, db);
  }
  return db;
}

/**
 * Close and remove a cached database instance.
 */
export function closeDatabase(projectDir: string): void {
  const key = resolve(projectDir);
  const db = instances.get(key);
  if (db) {
    db.close();
    instances.delete(key);
  }
}
