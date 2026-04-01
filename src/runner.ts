import { resolve, dirname } from "node:path";
import { activityBus } from "./activity-bus.js";
import { resolveAgent } from "./agent-resolver.js";
import { DefaultAgentDispatcher, type AgentDispatcher } from "./dispatcher.js";
import { AgentCrashError, MissingOutputError } from "./errors.js";
import { FilesystemGateStrategy } from "./gate/gate-watcher.js";
import { ConsoleLogger, type Logger } from "./logger.js";
import { writeMcpConfigFile } from "./mcp/mcp-config.js";
import { runAutoresearchCycle } from "./autoresearch.js";
import { loadPipeline } from "./pipeline.js";
import { runPgeCycle } from "./pge.js";
import { interpolate, resolveTaskBody, loadAgentMarkdown, buildTaskContext, writeSystemPromptFile } from "./prompt.js";
import { updatePipelineStatus, notifyPipelineComplete } from "./tui/cmux.js";
import {
  createState,
  loadState,
  saveState,
  saveStateWithEvent,
  updateStageStatus,
  finishPipeline,
  findResumePoint,
} from "./state.js";
import type {
  AgentStage,
  AutoresearchStage,
  HumanGateStage,
  PgeStage,
  PipelineStage,
  RunContext,
  StageResult,
  StageStatus,
  PipelineResult,
  Stage,
  Pipeline,
  PipelineState,
  GateInfo,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLogger(ctx: RunContext): Logger {
  return ctx.logger ?? new ConsoleLogger();
}

function getDispatcher(ctx: RunContext): AgentDispatcher {
  return ctx.dispatcher ?? new DefaultAgentDispatcher();
}

// ---------------------------------------------------------------------------
// Stage dispatch — type: agent
// ---------------------------------------------------------------------------

async function runAgentStage(
  stage: AgentStage,
  ctx: RunContext,
): Promise<StageResult> {
  const start = Date.now();
  const vars = { ...ctx.variables, ...(stage.variables ?? {}) };

  const taskDescription = await resolveTaskBody(stage, vars, `Execute stage: ${stage.name}`);
  const output = stage.output ? interpolate(stage.output, vars) : undefined;
  const inputs = stage.inputs?.map((i) => interpolate(i, vars));

  const userPrompt = buildTaskContext({
    task: taskDescription,
    inputs,
    output,
  });

  // In dry-run mode, try to resolve but don't fail if files are missing.
  if (ctx.dryRun) {
    let resolvedPath = stage.agent;
    try {
      const resolved = await resolveAgent(stage.agent, ctx.agentSearchPaths, stage.operation, ctx.projectDir);
      resolvedPath = resolved.agentPath;
    } catch {
      resolvedPath = `${stage.agent} (not found — will resolve at runtime)`;
    }
    const logger = getLogger(ctx);
    logger.log("\n[dry-run] Stage:", stage.name);
    logger.log("  agent:     ", resolvedPath);
    if (stage.operation) logger.log("  operation: ", stage.operation);
    if (stage.mcp_profile) logger.log("  mcp:       ", stage.mcp_profile);
    if (inputs?.length) logger.log("  inputs:    ", inputs.join(", "));
    if (output) logger.log("  output:    ", output);
    logger.log("  user prompt:");
    for (const line of userPrompt.split("\n")) {
      logger.log("    " + line);
    }
    return {
      stageName: stage.name,
      status: "passed",
      result: { exitCode: 0, outputExists: false, durationMs: 0 },
      durationMs: 0,
    };
  }

  // Resolve agent via search paths.
  const resolved = await resolveAgent(
    stage.agent,
    ctx.agentSearchPaths,
    stage.operation,
    ctx.projectDir,
  );

  const agentMarkdown = await loadAgentMarkdown(resolved.agentPath, resolved.operationPath);
  const systemPromptFile = await writeSystemPromptFile(agentMarkdown, ctx.tempTracker);
  const mcpConfigFile = ctx.projectConfig
    ? await writeMcpConfigFile(stage.mcp_profile, ctx.projectConfig, ctx.tempTracker)
    : undefined;

  const result = await getDispatcher(ctx).dispatch({
    userPrompt,
    systemPromptFile,
    mcpConfigFile,
    expectedOutput: output ? resolve(ctx.projectDir, output) : undefined,
    cwd: ctx.projectDir,
    allowedTools: stage.allowed_tools,
    agentName: stage.agent.replace(/[/\\]/g, "-").replace(/\.md$/, ""),
    streamLogDir: resolve(ctx.artifactDir, ".cccp"),
    claudeConfigDir: ctx.projectConfig?.claude_config_dir,
    permissionMode: ctx.projectConfig?.permission_mode,
    onActivity: (activity) => activityBus.emit("activity", activity),
    quiet: ctx.quiet,
  });

  if (result.exitCode !== 0) {
    throw new AgentCrashError(stage.agent, result.exitCode);
  }
  if (output && !result.outputExists) {
    throw new MissingOutputError(stage.agent, output);
  }

  return {
    stageName: stage.name,
    status: "passed",
    result,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Stage dispatch — type: pge
// ---------------------------------------------------------------------------

async function runPgeStage(
  stage: PgeStage,
  ctx: RunContext,
  state: PipelineState,
): Promise<StageResult> {
  const start = Date.now();
  const pgeResult = await runPgeCycle(stage, ctx, state, async (eventType, eventData) => {
    if (eventType) {
      await saveStateWithEvent(state, eventType, stage.name, eventData);
    } else {
      await saveState(state);
    }
  });

  if (pgeResult.outcome === "pass") {
    return {
      stageName: stage.name,
      status: "passed",
      result: pgeResult,
      durationMs: Date.now() - start,
    };
  }

  if (pgeResult.outcome === "error") {
    return {
      stageName: stage.name,
      status: "error",
      result: pgeResult,
      error: "Evaluation parse error",
      durationMs: Date.now() - start,
    };
  }

  // outcome === "fail" — apply escalation strategy
  const strategy = stage.on_fail ?? "stop";
  switch (strategy) {
    case "stop":
      return {
        stageName: stage.name,
        status: "failed",
        result: pgeResult,
        error: `Failed after ${pgeResult.iterations}/${pgeResult.maxIterations} iterations`,
        durationMs: Date.now() - start,
      };

    case "skip":
      getLogger(ctx).log(`    escalation: skip — continuing pipeline`);
      return {
        stageName: stage.name,
        status: "skipped",
        result: pgeResult,
        durationMs: Date.now() - start,
      };

    case "human_gate":
      if (!ctx.gateStrategy) {
        getLogger(ctx).log(`    escalation: human_gate — no gate strategy, stopping`);
        return {
          stageName: stage.name,
          status: "failed",
          result: pgeResult,
          error: `Failed after ${pgeResult.iterations} iterations (no gate strategy configured)`,
          durationMs: Date.now() - start,
        };
      }
      getLogger(ctx).log(`    escalation: human_gate — awaiting approval`);
      const gateInfo: GateInfo = {
        stageName: stage.name,
        status: "pending",
        prompt: `PGE stage "${stage.name}" failed after ${pgeResult.iterations} iterations. Approve to continue or reject to stop.`,
      };
      state.gate = gateInfo;
      await saveState(state);
      const gateResponse = await ctx.gateStrategy.waitForGate(gateInfo);
      state.gate = undefined;
      await saveState(state);
      if (gateResponse.approved) {
        getLogger(ctx).log(`    gate approved — continuing pipeline`);
        return {
          stageName: stage.name,
          status: "skipped",
          result: pgeResult,
          durationMs: Date.now() - start,
        };
      }
      return {
        stageName: stage.name,
        status: "failed",
        result: pgeResult,
        error: `Failed and gate rejected${gateResponse.feedback ? `: ${gateResponse.feedback}` : ""}`,
        durationMs: Date.now() - start,
      };
  }
}

// ---------------------------------------------------------------------------
// Stage dispatch — type: autoresearch
// ---------------------------------------------------------------------------

async function runAutoresearchStage(
  stage: AutoresearchStage,
  ctx: RunContext,
  state: PipelineState,
): Promise<StageResult> {
  const start = Date.now();
  const result = await runAutoresearchCycle(stage, ctx, state, async (eventType, eventData) => {
    if (eventType) {
      await saveStateWithEvent(state, eventType, stage.name, eventData);
    } else {
      await saveState(state);
    }
  });

  if (result.outcome === "pass") {
    return {
      stageName: stage.name,
      status: "passed",
      result,
      durationMs: Date.now() - start,
    };
  }

  if (result.outcome === "error") {
    return {
      stageName: stage.name,
      status: "error",
      result,
      error: "Evaluation parse error",
      durationMs: Date.now() - start,
    };
  }

  // outcome === "fail" — apply escalation strategy
  const strategy = stage.on_fail ?? "stop";
  const iterLabel = result.maxIterations
    ? `${result.iterations}/${result.maxIterations}`
    : `${result.iterations}`;
  switch (strategy) {
    case "stop":
      return {
        stageName: stage.name,
        status: "failed",
        result,
        error: `Failed after ${iterLabel} iterations`,
        durationMs: Date.now() - start,
      };

    case "skip":
      getLogger(ctx).log(`    escalation: skip — continuing pipeline`);
      return {
        stageName: stage.name,
        status: "skipped",
        result,
        durationMs: Date.now() - start,
      };

    case "human_gate":
      if (!ctx.gateStrategy) {
        getLogger(ctx).log(`    escalation: human_gate — no gate strategy, stopping`);
        return {
          stageName: stage.name,
          status: "failed",
          result,
          error: `Failed after ${iterLabel} iterations (no gate strategy configured)`,
          durationMs: Date.now() - start,
        };
      }
      getLogger(ctx).log(`    escalation: human_gate — awaiting approval`);
      const gateInfo: GateInfo = {
        stageName: stage.name,
        status: "pending",
        prompt: `Autoresearch stage "${stage.name}" failed after ${iterLabel} iterations. Approve to continue or reject to stop.`,
      };
      state.gate = gateInfo;
      await saveState(state);
      const gateResponse = await ctx.gateStrategy.waitForGate(gateInfo);
      state.gate = undefined;
      await saveState(state);
      if (gateResponse.approved) {
        getLogger(ctx).log(`    gate approved — continuing pipeline`);
        return {
          stageName: stage.name,
          status: "skipped",
          result,
          durationMs: Date.now() - start,
        };
      }
      return {
        stageName: stage.name,
        status: "failed",
        result,
        error: `Failed and gate rejected${gateResponse.feedback ? `: ${gateResponse.feedback}` : ""}`,
        durationMs: Date.now() - start,
      };
  }
}

// ---------------------------------------------------------------------------
// Stage dispatch — type: human_gate
// ---------------------------------------------------------------------------

async function runHumanGateStage(
  stage: HumanGateStage,
  ctx: RunContext,
  state: PipelineState,
): Promise<StageResult> {
  const start = Date.now();

  // Dry-run: just show what would happen.
  if (ctx.dryRun) {
    const logger = getLogger(ctx);
    logger.log("\n[dry-run] Human Gate:", stage.name);
    if (stage.prompt) logger.log("  prompt:    ", stage.prompt);
    if (stage.artifacts?.length) logger.log("  artifacts: ", stage.artifacts.join(", "));
    logger.log("  on_reject: ", stage.on_reject ?? "stop");
    return {
      stageName: stage.name,
      status: "passed",
      durationMs: 0,
    };
  }

  // No gate strategy configured — skip with warning.
  if (!ctx.gateStrategy) {
    getLogger(ctx).log(`  [skip] No gate strategy configured (stage: ${stage.name})`);
    return {
      stageName: stage.name,
      status: "skipped",
      durationMs: 0,
    };
  }

  // Write gate_pending to state.
  const gateInfo: GateInfo = {
    stageName: stage.name,
    status: "pending",
    prompt: stage.prompt,
  };

  state.gate = gateInfo;
  await saveState(state);

  // Wait for response via the gate strategy.
  const response = await ctx.gateStrategy.waitForGate(gateInfo);

  // Clear gate from state.
  state.gate = undefined;
  await saveState(state);

  if (response.approved) {
    return {
      stageName: stage.name,
      status: "passed",
      durationMs: Date.now() - start,
    };
  }

  // Rejected.
  const onReject = stage.on_reject ?? "stop";
  if (onReject === "stop") {
    return {
      stageName: stage.name,
      status: "failed",
      error: `Gate rejected${response.feedback ? `: ${response.feedback}` : ""}`,
      durationMs: Date.now() - start,
    };
  }

  // on_reject: retry — for now, treat same as stop since retry needs
  // the previous generator context which is stage-dependent.
  return {
    stageName: stage.name,
    status: "failed",
    error: `Gate rejected (retry not yet supported)${response.feedback ? `: ${response.feedback}` : ""}`,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Stage dispatch — type: pipeline (sub-pipeline)
// ---------------------------------------------------------------------------

const MAX_PIPELINE_DEPTH = 5;

async function runPipelineStage(
  stage: PipelineStage,
  ctx: RunContext,
  state: PipelineState,
): Promise<StageResult> {
  const start = Date.now();
  const vars = { ...ctx.variables, ...(stage.variables ?? {}) };

  // Resolve sub-pipeline file path relative to parent pipeline's directory.
  const filePath = resolve(dirname(ctx.pipelineFile), interpolate(stage.file, vars));

  // --- Dry-run ---
  if (ctx.dryRun) {
    const logger = getLogger(ctx);
    logger.log(`\n[dry-run] Pipeline Stage: ${stage.name}`);
    logger.log(`  file:         ${filePath}`);
    if (stage.artifact_dir) {
      logger.log(`  artifact_dir: ${interpolate(stage.artifact_dir, vars)}`);
    }
    if (stage.on_fail) {
      logger.log(`  on_fail:      ${stage.on_fail}`);
    }

    // Load and dry-run the sub-pipeline.
    let childPipeline: Pipeline;
    try {
      childPipeline = await loadPipeline(filePath);
    } catch (err) {
      logger.log(`  (sub-pipeline not loadable — will resolve at runtime)`);
      return { stageName: stage.name, status: "passed", durationMs: 0 };
    }

    logger.log(`  sub-pipeline: ${childPipeline.name} (${childPipeline.stages.length} stages)`);
    for (const s of childPipeline.stages) {
      logger.log(`    - ${s.name} (${s.type})`);
    }

    return { stageName: stage.name, status: "passed", durationMs: 0 };
  }

  // --- Cycle detection ---
  const visited = ctx.visitedPipelines ?? new Set<string>();
  if (visited.has(filePath)) {
    throw new Error(
      `Circular pipeline dependency: ${[...visited, filePath].join(" → ")}`,
    );
  }
  if (visited.size >= MAX_PIPELINE_DEPTH) {
    throw new Error(
      `Pipeline nesting depth exceeded (max ${MAX_PIPELINE_DEPTH}): ${[...visited, filePath].join(" → ")}`,
    );
  }

  // --- Load sub-pipeline ---
  const childPipeline = await loadPipeline(filePath);

  // --- Build child context ---
  const childArtifactDir = stage.artifact_dir
    ? resolve(ctx.projectDir, interpolate(stage.artifact_dir, vars))
    : ctx.artifactDir;

  const childVars: Record<string, string> = {
    project: ctx.project,
    project_dir: ctx.projectDir,
    artifact_dir: childArtifactDir,
    pipeline_name: childPipeline.name,
    ...(childPipeline.variables ?? {}),
    ...(stage.variables ?? {}),
  };

  const childVisited = new Set(visited);
  childVisited.add(resolve(ctx.pipelineFile));

  const childCtx: RunContext = {
    ...ctx,
    pipeline: childPipeline,
    pipelineFile: filePath,
    artifactDir: childArtifactDir,
    variables: childVars,
    visitedPipelines: childVisited,
    // Inherit parent's agent search paths + sub-pipeline's directory.
    agentSearchPaths: [
      resolve(dirname(filePath), "agents"),
      ...ctx.agentSearchPaths,
    ],
  };

  // --- Execute child stages ---
  const stageState = state.stages[stage.name];
  const existingChildState = stageState?.children;

  const childResult = await runStages(
    childCtx,
    existingChildState,
  );

  // Store child state in parent.
  if (stageState) {
    stageState.children = childResult.state;
  }

  const durationMs = Date.now() - start;
  const result: StageResult = {
    stageName: stage.name,
    status: childResult.pipelineResult.status === "passed" ? "passed" : "failed",
    error: childResult.pipelineResult.status !== "passed"
      ? `Sub-pipeline "${childPipeline.name}" ${childResult.pipelineResult.status}`
      : undefined,
    durationMs,
  };

  // --- Escalation ---
  if (result.status === "failed" && stage.on_fail) {
    if (stage.on_fail === "skip") {
      return { ...result, status: "skipped" };
    }
    if (stage.on_fail === "human_gate" && ctx.gateStrategy) {
      const gate: GateInfo = {
        stageName: stage.name,
        status: "pending",
        prompt: `Sub-pipeline "${childPipeline.name}" failed. Approve to continue, reject to stop.`,
      };
      state.gate = gate;
      await saveState(state);
      const response = await ctx.gateStrategy.waitForGate(gate);
      state.gate = { ...gate, ...response, status: response.approved ? "approved" : "rejected" };
      if (response.approved) {
        return { ...result, status: "skipped" };
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Stage router
// ---------------------------------------------------------------------------

async function runStage(
  stage: Stage,
  ctx: RunContext,
  state: PipelineState,
): Promise<StageResult> {
  switch (stage.type) {
    case "agent":
      return runAgentStage(stage, ctx);

    case "pge":
      return runPgeStage(stage, ctx, state);

    case "human_gate":
      return runHumanGateStage(stage, ctx, state);

    case "autoresearch":
      return runAutoresearchStage(stage, ctx, state);

    case "pipeline":
      return runPipelineStage(stage, ctx, state);
  }
}

// ---------------------------------------------------------------------------
// Core stage execution loop (shared by runPipeline and runPipelineStage)
// ---------------------------------------------------------------------------

interface StagesResult {
  state: PipelineState;
  pipelineResult: PipelineResult;
}

/**
 * Execute the stage loop for a pipeline. Used by both top-level `runPipeline()`
 * and nested `runPipelineStage()`. Handles resume, state persistence, and
 * stage routing — but not lifecycle concerns (DB row creation, notifications,
 * gate strategy setup, temp file cleanup).
 */
async function runStages(
  ctx: RunContext,
  existingState?: PipelineState,
): Promise<StagesResult> {
  const start = Date.now();
  const results: StageResult[] = [];
  let pipelineStatus: PipelineResult["status"] = "passed";

  // --- State initialization ---
  let state: PipelineState;
  let skipUntilIndex = -1;

  if (existingState) {
    state = existingState;
    state.status = "running";
    const resume = findResumePoint(state);
    if (resume) {
      skipUntilIndex = resume.stageIndex;
      getLogger(ctx).log(`  resuming "${ctx.pipeline.name}" from stage "${resume.stageName}"`);
    } else {
      return {
        state,
        pipelineResult: {
          pipeline: ctx.pipeline.name,
          project: ctx.project,
          stages: [],
          status: "passed",
          durationMs: 0,
        },
      };
    }
  } else {
    state = createState(
      ctx.pipeline.name,
      ctx.project,
      ctx.pipelineFile,
      ctx.pipeline.stages.map((s) => ({ name: s.name, type: s.type })),
      ctx.artifactDir,
      ctx.projectDir,
    );
  }

  if (!ctx.dryRun) {
    await saveState(state);
  }

  for (let i = 0; i < ctx.pipeline.stages.length; i++) {
    const stage = ctx.pipeline.stages[i];

    // Skip completed stages on resume.
    if (existingState && i < skipUntilIndex) {
      const stageState = state.stages[stage.name];
      if (stageState?.status === "passed" || stageState?.status === "skipped") {
        getLogger(ctx).log(`  ⏭ ${stage.name}: already ${stageState.status}`);
        results.push({
          stageName: stage.name,
          status: stageState.status as "passed" | "skipped",
          durationMs: stageState.durationMs ?? 0,
        });
        continue;
      }
    }

    getLogger(ctx).log(`▸ Stage: ${stage.name} (${stage.type})`);

    // Mark in_progress in state + update cmux.
    if (!ctx.dryRun) {
      updateStageStatus(state, stage.name, "in_progress");
      await saveStateWithEvent(state, "stage_start", stage.name);
      await updatePipelineStatus(stage.name, i, ctx.pipeline.stages.length);
    }

    try {
      const result = await runStage(stage, ctx, state);
      results.push(result);

      // Persist stage result to state.
      if (!ctx.dryRun) {
        updateStageStatus(state, stage.name, result.status as StageStatus, {
          durationMs: result.durationMs,
          error: result.error,
        });
        await saveStateWithEvent(state, "stage_complete", stage.name, {
          status: result.status,
          durationMs: result.durationMs,
        });
      }

      if (result.status === "failed" || result.status === "error") {
        pipelineStatus = "failed";
        getLogger(ctx).log(`  ✗ ${stage.name}: ${result.status}${result.error ? ` — ${result.error}` : ""}`);
        break;
      }

      const duration = result.durationMs > 0
        ? ` (${(result.durationMs / 1000).toFixed(1)}s)`
        : "";
      getLogger(ctx).log(`  ✓ ${stage.name}: ${result.status}${duration}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        stageName: stage.name,
        status: "error",
        error: message,
        durationMs: Date.now() - start,
      });
      pipelineStatus = "error";

      if (!ctx.dryRun) {
        updateStageStatus(state, stage.name, "error", { error: message });
        await saveState(state);
      }

      getLogger(ctx).error(`  ✗ ${stage.name}: error — ${message}`);
      break;
    }
  }

  // Finalize state.
  if (!ctx.dryRun) {
    const finalStatus = pipelineStatus === "passed" ? "passed" : pipelineStatus === "error" ? "error" : "failed";
    finishPipeline(state, finalStatus);
  }

  const durationMs = Date.now() - start;
  return {
    state,
    pipelineResult: {
      pipeline: ctx.pipeline.name,
      project: ctx.project,
      stages: results,
      status: pipelineStatus,
      durationMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline runner (top-level entry point)
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Existing state to resume from. If provided, completed stages are skipped. */
  existingState?: PipelineState;
}

/**
 * Run all stages in a pipeline sequentially.
 * Handles top-level lifecycle: state creation, DB persistence, gate strategy,
 * cmux notifications, and temp file cleanup.
 */
export async function runPipeline(
  ctx: RunContext,
  opts?: RunOptions,
): Promise<PipelineResult> {
  // Create gate strategy if not provided.
  if (!ctx.gateStrategy && !ctx.headless && !ctx.dryRun) {
    // Need a runId — use existing state or generate one via createState.
    const tempState = opts?.existingState ?? createState(
      ctx.pipeline.name, ctx.project, ctx.pipelineFile,
      ctx.pipeline.stages.map((s) => ({ name: s.name, type: s.type })),
      ctx.artifactDir, ctx.projectDir,
    );
    ctx.gateStrategy = new FilesystemGateStrategy(tempState.runId, ctx.projectDir, ctx.quiet);
  }

  // Initialize visited pipelines for cycle detection.
  if (!ctx.visitedPipelines) {
    ctx.visitedPipelines = new Set([resolve(ctx.pipelineFile)]);
  }

  if (opts?.existingState) {
    getLogger(ctx).log(`\nCCCP: Resuming pipeline "${ctx.pipeline.name}"\n`);
  } else {
    getLogger(ctx).log(`\nCCCP: Running pipeline "${ctx.pipeline.name}" for project "${ctx.project}"\n`);
  }

  try {
    const { state, pipelineResult } = await runStages(ctx, opts?.existingState);

    // Top-level persistence and notifications.
    if (!ctx.dryRun) {
      await saveStateWithEvent(state, "pipeline_complete", undefined, { status: pipelineResult.status });
      await notifyPipelineComplete(ctx.pipeline.name, pipelineResult.status);
    }

    getLogger(ctx).log(`\nPipeline "${ctx.pipeline.name}": ${pipelineResult.status} (${(pipelineResult.durationMs / 1000).toFixed(1)}s)\n`);

    return pipelineResult;
  } finally {
    await ctx.tempTracker?.cleanup();
  }
}
