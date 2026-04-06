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
  GeStep,
  AutoresearchStep,
  LoopStep,
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
  LoopStep,
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
  step: PgeStep | GeStep | AutoresearchStep | LoopStep,
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

    if ((stage.type === "pge" || stage.type === "ge" || stage.type === "autoresearch" || stage.type === "loop") && stage.status === "in_progress") {
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
/**
 * Reset stages within a single PipelineState from the named stage onward.
 * Returns the list of stage names that were reset.
 */
function resetStagesInPipeline(
  pipelineState: PipelineState,
  fromStageName: string,
): string[] {
  const idx = pipelineState.stageOrder.indexOf(fromStageName);
  if (idx === -1) {
    throw new Error(
      `Stage "${fromStageName}" not found. Available stages: ${pipelineState.stageOrder.join(", ")}`,
    );
  }

  const stagesToReset = pipelineState.stageOrder.slice(idx);
  for (const name of stagesToReset) {
    const stage = pipelineState.stages[name];
    if (!stage) continue;
    stage.status = "pending";
    delete stage.iteration;
    delete stage.pgeStep;
    delete stage.artifacts;
    delete stage.outputs;
    delete stage.durationMs;
    delete stage.error;
  }
  return stagesToReset;
}

/**
 * Clean filesystem artifacts for the given stage names within an artifact directory.
 */
async function cleanStageArtifacts(
  artifactDir: string,
  stageNames: string[],
): Promise<void> {
  const cccpDir = resolve(artifactDir, ".cccp");

  for (const name of stageNames) {
    const stageDir = resolve(artifactDir, name);
    await rm(stageDir, { recursive: true, force: true });

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
}

/**
 * Reset from a named stage and clear all subsequent stages.
 * Supports dotted paths for sub-pipeline stages (e.g., "sprint-0.doc-refresh").
 */
export async function resetFromStage(
  state: PipelineState,
  fromStagePath: string,
): Promise<string[]> {
  const segments = fromStagePath.split(".");

  if (segments.length === 1) {
    // --- Top-level reset (existing behavior) ---
    const stagesToReset = resetStagesInPipeline(state, segments[0]);

    state.status = "running";
    delete state.completedAt;
    delete state.gate;

    const dir = resolveProjectDir(state);
    const db = await openDatabase(dir);
    db.deleteEventsForStages(state.runId, stagesToReset);
    db.deleteCheckpointsForStages(state.runId, stagesToReset);
    db.upsertRun(state, state.artifactDir);
    db.flush();

    await cleanStageArtifacts(state.artifactDir, stagesToReset);
    return stagesToReset;
  }

  // --- Dotted path: walk children chain ---
  let current: PipelineState = state;
  const ancestors: Array<{ state: PipelineState; stageName: string }> = [];

  for (let i = 0; i < segments.length - 1; i++) {
    const parentName = segments[i];
    const parentStage = current.stages[parentName];
    if (!parentStage) {
      throw new Error(
        `Stage "${parentName}" not found. Available stages: ${current.stageOrder.join(", ")}`,
      );
    }
    if (!parentStage.children) {
      throw new Error(
        parentStage.type === "pipeline"
          ? `Sub-pipeline "${parentName}" has not started yet. Use '--from ${parentName}' to reset the entire stage.`
          : `Stage "${parentName}" is type "${parentStage.type}", not "pipeline". Dotted paths only work with sub-pipeline stages.`,
      );
    }
    ancestors.push({ state: current, stageName: parentName });
    current = parentStage.children;
  }

  const targetStage = segments[segments.length - 1];
  const childStagesToReset = resetStagesInPipeline(current, targetStage);

  // Reset child pipeline status.
  current.status = "running";
  delete current.completedAt;

  // Set ancestor stages back to in_progress so the runner re-enters them.
  for (const { state: ancestorState, stageName } of ancestors) {
    const stage = ancestorState.stages[stageName];
    stage.status = "in_progress";
    delete stage.durationMs;
    delete stage.error;
  }

  // Reset top-level pipeline status.
  state.status = "running";
  delete state.completedAt;
  delete state.gate;

  // DB cleanup.
  const dir = resolveProjectDir(state);
  const db = await openDatabase(dir);
  const parentStageName = ancestors[ancestors.length - 1].stageName;
  db.deleteChildEventsForStages(state.runId, parentStageName, childStagesToReset);
  db.deleteCheckpointsForStages(state.runId, childStagesToReset);
  db.upsertRun(state, state.artifactDir);
  db.flush();

  // Clean child filesystem artifacts.
  await cleanStageArtifacts(current.artifactDir, childStagesToReset);

  return childStagesToReset.map((n) => `${segments.slice(0, -1).join(".")}.${n}`);
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
