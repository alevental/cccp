import { resolve } from "node:path";
import { activityBus } from "./activity-bus.js";
import { resolveAgent } from "./agent-resolver.js";
import { DefaultAgentDispatcher, type AgentDispatcher } from "./dispatcher.js";
import { AgentCrashError, MissingOutputError } from "./errors.js";
import { FilesystemGateStrategy } from "./gate/gate-watcher.js";
import { ConsoleLogger, type Logger } from "./logger.js";
import { writeMcpConfigFile } from "./mcp/mcp-config.js";
import { runPgeCycle } from "./pge.js";
import { interpolate, loadAgentMarkdown, buildTaskContext, writeSystemPromptFile } from "./prompt.js";
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
  HumanGateStage,
  PgeStage,
  RunContext,
  StageResult,
  StageStatus,
  PipelineResult,
  Stage,
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

  const taskDescription =
    stage.task ?? `Execute stage: ${stage.name}`;
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
  }
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Existing state to resume from. If provided, completed stages are skipped. */
  existingState?: PipelineState;
}

/**
 * Run all stages in a pipeline sequentially.
 * Persists state to disk after every stage transition.
 * Returns the overall pipeline result.
 */
export async function runPipeline(
  ctx: RunContext,
  opts?: RunOptions,
): Promise<PipelineResult> {
  const start = Date.now();
  const results: StageResult[] = [];
  let pipelineStatus: PipelineResult["status"] = "passed";

  // --- State initialization ---
  let state: PipelineState;
  let skipUntilIndex = -1;

  if (opts?.existingState) {
    state = opts.existingState;
    state.status = "running";
    const resume = findResumePoint(state);
    if (resume) {
      skipUntilIndex = resume.stageIndex;
      getLogger(ctx).log(`\nCCCP: Resuming pipeline "${ctx.pipeline.name}" from stage "${resume.stageName}"\n`);
    } else {
      getLogger(ctx).log(`\nCCCP: Pipeline "${ctx.pipeline.name}" has no resumable stages\n`);
      return {
        pipeline: ctx.pipeline.name,
        project: ctx.project,
        stages: [],
        status: "passed",
        durationMs: 0,
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
    getLogger(ctx).log(`\nCCCP: Running pipeline "${ctx.pipeline.name}" for project "${ctx.project}"\n`);
  }

  // Create gate strategy now that we have a runId.
  if (!ctx.gateStrategy && !ctx.headless) {
    ctx.gateStrategy = new FilesystemGateStrategy(state.runId, ctx.projectDir, ctx.quiet);
  }

  if (!ctx.dryRun) {
    await saveState(state);
  }

  try {
    for (let i = 0; i < ctx.pipeline.stages.length; i++) {
      const stage = ctx.pipeline.stages[i];

      // Skip completed stages on resume.
      if (opts?.existingState && i < skipUntilIndex) {
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

    // Finalize state + notify cmux.
    if (!ctx.dryRun) {
      const finalStatus = pipelineStatus === "passed" ? "passed" : pipelineStatus === "error" ? "error" : "failed";
      finishPipeline(state, finalStatus);
      await saveStateWithEvent(state, "pipeline_complete", undefined, { status: finalStatus });
      await notifyPipelineComplete(ctx.pipeline.name, pipelineStatus);
    }

    const durationMs = Date.now() - start;
    getLogger(ctx).log(`\nPipeline "${ctx.pipeline.name}": ${pipelineStatus} (${(durationMs / 1000).toFixed(1)}s)\n`);

    return {
      pipeline: ctx.pipeline.name,
      project: ctx.project,
      stages: results,
      status: pipelineStatus,
      durationMs,
    };
  } finally {
    await ctx.tempTracker?.cleanup();
  }
}
