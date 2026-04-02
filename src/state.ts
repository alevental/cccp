import { resolve } from "node:path";
import { rm, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openDatabase, type RunFilter } from "./db.js";
import type {
  PipelineState,
  StageState,
  StageStatus,
  StageEntry,
  PgeStep,
  AutoresearchStep,
  GateInfo,
  ResumePoint,
  DiscoveredRun,
} from "./types.js";
import { isParallelGroup } from "./types.js";

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
// Stage entry flattening (parallel groups → flat stage list)
// ---------------------------------------------------------------------------

/**
 * Flatten a mixed StageEntry[] (which may contain ParallelGroups) into a flat
 * array of stage descriptors. Stages inside parallel groups get a `groupId`
 * so the TUI and runner can reconstruct group boundaries.
 */
export function flattenStageEntries(
  entries: StageEntry[],
): Array<{ name: string; type: string; groupId?: string }> {
  const result: Array<{ name: string; type: string; groupId?: string }> = [];
  let groupIndex = 0;

  for (const entry of entries) {
    if (isParallelGroup(entry)) {
      const groupId = `parallel-${groupIndex++}`;
      for (const stage of entry.parallel.stages) {
        result.push({ name: stage.name, type: stage.type, groupId });
      }
    } else {
      result.push({ name: entry.name, type: entry.type });
    }
  }

  return result;
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
  stages: Array<{ name: string; type: string; groupId?: string }>,
  artifactDir: string,
  projectDir?: string,
  sessionId?: string,
): PipelineState {
  const stageMap: Record<string, StageState> = {};
  const order: string[] = [];

  for (const s of stages) {
    const stageState: StageState = {
      name: s.name,
      type: s.type,
      status: "pending",
    };
    if (s.groupId) stageState.groupId = s.groupId;
    stageMap[s.name] = stageState;
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
    sessionId,
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
  step: PgeStep | AutoresearchStep,
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

    if ((stage.type === "pge" || stage.type === "autoresearch") && stage.status === "in_progress") {
      point.resumeIteration = stage.iteration ?? 1;
      point.resumeStep = stage.pgeStep;
    }

    return point;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Clean reset — reset a stage and all subsequent stages for fresh re-run
// ---------------------------------------------------------------------------

/**
 * Reset a named stage and every stage after it to a clean `pending` state.
 * Cleans up:
 *   - In-memory stage state (status, iteration, pgeStep, artifacts, duration, error)
 *   - Pipeline-level fields (status → running, clear completedAt/gate)
 *   - SQLite events and checkpoints for the affected stages
 *   - Artifact directories (`{artifactDir}/{stageName}/`)
 *   - Stream log files (`{artifactDir}/.cccp/{stageName}-*.stream.jsonl`)
 *   - Gate feedback files (`{artifactDir}/.cccp/{stageName}-gate-feedback-*.md`)
 *
 * Returns the list of stage names that were reset.
 */
export async function resetFromStage(
  state: PipelineState,
  fromStageName: string,
): Promise<string[]> {
  const idx = state.stageOrder.indexOf(fromStageName);
  if (idx === -1) {
    throw new Error(
      `Stage "${fromStageName}" not found. Available stages: ${state.stageOrder.join(", ")}`,
    );
  }

  const stagesToReset = state.stageOrder.slice(idx);

  // --- Reset in-memory stage state ---
  for (const name of stagesToReset) {
    const stage = state.stages[name];
    if (!stage) continue;
    stage.status = "pending";
    delete stage.iteration;
    delete stage.pgeStep;
    delete stage.artifacts;
    delete stage.durationMs;
    delete stage.error;
  }

  // --- Reset pipeline-level state ---
  state.status = "running";
  delete state.completedAt;
  delete state.gate;

  // --- Clean SQLite records ---
  const dir = resolveProjectDir(state);
  const db = await openDatabase(dir);
  db.deleteEventsForStages(state.runId, stagesToReset);
  db.deleteCheckpointsForStages(state.runId, stagesToReset);
  db.upsertRun(state, state.artifactDir);
  db.flush();

  // --- Clean filesystem ---
  const artifactDir = state.artifactDir;
  const cccpDir = resolve(artifactDir, ".cccp");

  for (const name of stagesToReset) {
    // Remove stage artifact directory.
    const stageDir = resolve(artifactDir, name);
    await rm(stageDir, { recursive: true, force: true });

    // Remove stream logs and gate feedback files.
    try {
      const files = await readdir(cccpDir);
      for (const file of files) {
        if (
          (file.startsWith(`${name}-`) && file.endsWith(".stream.jsonl")) ||
          (file.startsWith(`${name}-gate-feedback-`) && file.endsWith(".md"))
        ) {
          await unlink(resolve(cccpDir, file));
        }
      }
    } catch {
      // .cccp dir may not exist yet — that's fine.
    }
  }

  return stagesToReset;
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
