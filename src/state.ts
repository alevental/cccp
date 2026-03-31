import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, type RunFilter } from "./db.js";
import type {
  PipelineState,
  StageState,
  StageStatus,
  PgeStep,
  GateInfo,
  ResumePoint,
  DiscoveredRun,
} from "./types.js";

export type {
  PipelineState,
  StageState,
  StageStatus,
  PgeStep,
  GateInfo,
  ResumePoint,
  DiscoveredRun,
} from "./types.js";

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
  artifactDir: string,
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
    artifactDir,
    projectDir,
  };
}

/**
 * Load pipeline state by run ID. Queries the SQLite database.
 * When `reloadFromDisk` is true, re-reads the DB file first — needed when
 * another process (e.g., MCP server) may have written to it.
 */
export async function loadState(
  runId: string,
  projectDir?: string,
  reloadFromDisk?: boolean,
): Promise<PipelineState | null> {
  try {
    const dir = projectDir ?? resolveProjectDir();
    const db = await openDatabase(dir);
    if (reloadFromDisk) db.reload();
    return db.getRun(runId);
  } catch (err) {
    // Log database errors but don't crash — callers handle null gracefully.
    if (err instanceof Error) {
      console.error(`[cccp] loadState error: ${err.message}`);
    }
    return null;
  }
}

/**
 * Save pipeline state to the SQLite database and flush to disk.
 * The artifact directory is extracted from `state.artifactDir`.
 */
export async function saveState(
  state: PipelineState,
): Promise<void> {
  const dir = resolveProjectDir(state);
  const db = await openDatabase(dir);
  db.upsertRun(state, state.artifactDir);
  db.flush();
}

/**
 * Save state and record an event in the audit log.
 * The artifact directory is extracted from `state.artifactDir`.
 */
export async function saveStateWithEvent(
  state: PipelineState,
  eventType: string,
  stageName?: string,
  eventData?: unknown,
): Promise<void> {
  const dir = resolveProjectDir(state);
  const db = await openDatabase(dir);
  db.upsertRun(state, state.artifactDir);
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
 * Discover pipeline runs from the SQLite database.
 * Optionally filter by project, pipeline, status, or artifact directory.
 * Returns matching runs sorted running-first, then by start time descending.
 */
export async function discoverRuns(
  projectDir: string,
  filter?: RunFilter,
): Promise<DiscoveredRun[]> {
  try {
    const db = await openDatabase(projectDir);
    return db.findRuns(filter);
  } catch (err) {
    // Log database errors but don't crash — callers handle empty list gracefully.
    if (err instanceof Error) {
      console.error(`[cccp] discoverRuns error: ${err.message}`);
    }
    return [];
  }
}
