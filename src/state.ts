import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

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
}

// ---------------------------------------------------------------------------
// State file path
// ---------------------------------------------------------------------------

export function stateDir(artifactDir: string): string {
  return resolve(artifactDir, ".cccpr");
}

export function statePath(artifactDir: string): string {
  return resolve(stateDir(artifactDir), "state.json");
}

// ---------------------------------------------------------------------------
// Atomic file write
// ---------------------------------------------------------------------------

async function atomicWrite(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.state-${randomUUID()}.tmp`);
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, path);
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
  };
}

/**
 * Load pipeline state from disk. Returns null if no state file exists.
 */
export async function loadState(
  artifactDir: string,
): Promise<PipelineState | null> {
  const path = statePath(artifactDir);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as PipelineState;
  } catch {
    return null;
  }
}

/**
 * Save pipeline state to disk (atomic write).
 */
export async function saveState(
  artifactDir: string,
  state: PipelineState,
): Promise<void> {
  const path = statePath(artifactDir);
  await atomicWrite(path, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// State update helpers
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

    // Skip completed/skipped stages.
    if (stage.status === "passed" || stage.status === "skipped") {
      continue;
    }

    // Found a stage that wasn't completed.
    const point: ResumePoint = {
      stageIndex: i,
      stageName: name,
    };

    // For PGE stages that were in progress, resume at the right sub-step.
    if (stage.type === "pge" && stage.status === "in_progress") {
      point.resumeIteration = stage.iteration ?? 1;
      point.resumeStep = stage.pgeStep;
    }

    return point;
  }

  return null;
}
