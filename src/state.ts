import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, type CccpDatabase, type DiscoveredRun, type StateEvent } from "./db.js";

// Re-export types from db.ts that callers reference
export type { DiscoveredRun, StateEvent } from "./db.js";

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export type StageStatus =
  | "pending"
  | "in_progress"
  | "passed"
  | "failed"
  | "skipped"
  | "error";

export type PgeStep =
  | "contract_written"
  | "generator_dispatched"
  | "evaluator_dispatched"
  | "routed";

export interface StageState {
  name: string;
  type: string;
  status: StageStatus;
  /** Current PGE iteration (1-based). Only for type: pge. */
  iteration?: number;
  /** Last completed PGE sub-step within the current iteration. */
  pgeStep?: PgeStep;
  /** Paths to artifacts produced by this stage. */
  artifacts?: Record<string, string>;
  /** Duration in ms (set on completion). */
  durationMs?: number;
  /** Error message if status is error/failed. */
  error?: string;
}

export interface GateInfo {
  stageName: string;
  status: "pending" | "approved" | "rejected";
  prompt?: string;
  feedback?: string;
  respondedAt?: string;
}

export interface PipelineState {
  /** Unique run ID. */
  runId: string;
  /** Pipeline name. */
  pipeline: string;
  /** Project name. */
  project: string;
  /** Pipeline YAML file path. */
  pipelineFile: string;
  /** ISO timestamp when the run started. */
  startedAt: string;
  /** ISO timestamp when the run completed (set on finish). */
  completedAt?: string;
  /** Overall status. */
  status: "running" | "passed" | "failed" | "error" | "interrupted";
  /** Per-stage state, keyed by stage name. */
  stages: Record<string, StageState>;
  /** Stage execution order (preserves YAML order). */
  stageOrder: string[];
  /** Active gate info, if any. */
  gate?: GateInfo;
  /** Project root directory. Used to locate the database. */
  projectDir?: string;
}

// ---------------------------------------------------------------------------
// Legacy state file path (kept for .stream.jsonl and artifact directory)
// ---------------------------------------------------------------------------

export function stateDir(artifactDir: string): string {
  return resolve(artifactDir, ".cccp");
}

export function statePath(artifactDir: string): string {
  return resolve(stateDir(artifactDir), "state.json");
}

// ---------------------------------------------------------------------------
// Database resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the project directory for database access.
 * Priority: state.projectDir > derive from pipelineFile > cwd
 */
function resolveProjectDir(state?: PipelineState | null): string {
  if (state?.projectDir) return state.projectDir;
  // Fall back to cwd (the MCP server and CLI always run from project root)
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Create / Load / Save
// ---------------------------------------------------------------------------

/**
 * Create a fresh pipeline state for a new run.
 */
export function createState(
  pipeline: string,
  project: string,
  pipelineFile: string,
  stages: Array<{ name: string; type: string }>,
  projectDir?: string,
): PipelineState {
  const stageMap: Record<string, StageState> = {};
  const order: string[] = [];

  for (const s of stages) {
    stageMap[s.name] = {
      name: s.name,
      type: s.type,
      status: "pending",
    };
    order.push(s.name);
  }

  return {
    runId: randomUUID(),
    pipeline,
    project,
    pipelineFile,
    startedAt: new Date().toISOString(),
    status: "running",
    stages: stageMap,
    stageOrder: order,
    projectDir,
  };
}

/**
 * Load pipeline state. Queries the SQLite database by artifactDir.
 * When `reloadFromDisk` is true, re-reads the DB file first — needed when
 * another process (e.g., MCP server) may have written to it.
 */
export async function loadState(
  artifactDir: string,
  projectDir?: string,
  reloadFromDisk?: boolean,
): Promise<PipelineState | null> {
  try {
    const dir = projectDir ?? resolveProjectDir();
    const db = await openDatabase(dir);
    if (reloadFromDisk) db.reload();
    return db.getRunByArtifactDir(artifactDir);
  } catch {
    return null;
  }
}

/**
 * Save pipeline state to the SQLite database.
 * Also appends an event to the audit log and flushes to disk.
 */
export async function saveState(
  artifactDir: string,
  state: PipelineState,
): Promise<void> {
  const dir = resolveProjectDir(state);
  const db = await openDatabase(dir);
  db.upsertRun(state, artifactDir);
  db.flush();
}

/**
 * Save state and record an event in the audit log.
 */
export async function saveStateWithEvent(
  artifactDir: string,
  state: PipelineState,
  eventType: string,
  stageName?: string,
  eventData?: unknown,
): Promise<void> {
  const dir = resolveProjectDir(state);
  const db = await openDatabase(dir);
  db.upsertRun(state, artifactDir);
  db.appendEvent(state.runId, eventType, stageName, eventData);
  db.flush();
}

// ---------------------------------------------------------------------------
// State update helpers (in-memory mutations — caller must saveState after)
// ---------------------------------------------------------------------------

export function updateStageStatus(
  state: PipelineState,
  stageName: string,
  status: StageStatus,
  extra?: Partial<StageState>,
): void {
  const stage = state.stages[stageName];
  if (!stage) return;
  stage.status = status;
  if (extra) Object.assign(stage, extra);
}

export function updatePgeProgress(
  state: PipelineState,
  stageName: string,
  iteration: number,
  step: PgeStep,
): void {
  const stage = state.stages[stageName];
  if (!stage) return;
  stage.iteration = iteration;
  stage.pgeStep = step;
}

export function setStageArtifact(
  state: PipelineState,
  stageName: string,
  key: string,
  path: string,
): void {
  const stage = state.stages[stageName];
  if (!stage) return;
  if (!stage.artifacts) stage.artifacts = {};
  stage.artifacts[key] = path;
}

export function finishPipeline(
  state: PipelineState,
  status: "passed" | "failed" | "error",
): void {
  state.status = status;
  state.completedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Resume logic
// ---------------------------------------------------------------------------

export interface ResumePoint {
  /** Index into stageOrder to resume from. */
  stageIndex: number;
  /** Stage name to resume from. */
  stageName: string;
  /** For PGE stages: which iteration to resume at. */
  resumeIteration?: number;
  /** For PGE stages: which sub-step to resume at within the iteration. */
  resumeStep?: PgeStep;
}

/**
 * Determine where to resume a pipeline from its saved state.
 * Returns null if the pipeline is already complete or has no resumable point.
 */
export function findResumePoint(state: PipelineState): ResumePoint | null {
  if (state.status === "passed") return null;

  for (let i = 0; i < state.stageOrder.length; i++) {
    const name = state.stageOrder[i];
    const stage = state.stages[name];

    if (stage.status === "passed" || stage.status === "skipped") {
      continue;
    }

    const point: ResumePoint = {
      stageIndex: i,
      stageName: name,
    };

    if (stage.type === "pge" && stage.status === "in_progress") {
      point.resumeIteration = stage.iteration ?? 1;
      point.resumeStep = stage.pgeStep;
    }

    return point;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Run discovery — queries SQLite database
// ---------------------------------------------------------------------------

/**
 * Discover all pipeline runs from the SQLite database.
 * Returns both active and completed runs, sorted running-first.
 */
export async function discoverRuns(
  projectDir: string,
): Promise<DiscoveredRun[]> {
  try {
    const db = await openDatabase(projectDir);
    return db.listRuns();
  } catch {
    return [];
  }
}
